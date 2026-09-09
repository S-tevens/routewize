import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { v4 as uuidv4 } from "uuid";
import OpenAI from "openai";

import { authMiddleware } from "./middleware/auth.js";
import { createEmbeddingProvider } from "./cache/embeddings.js";
import { SemanticCache } from "./cache/semanticCache.js";
import { selectRoute } from "./router/rules.js";
import { callOpenAI } from "./providers/openai.js";
import { callAnthropic } from "./providers/anthropic.js";
import { estimateCost, loadRemotePricing } from "./logging/pricing.js";
import { logRequestEvent } from "./logging/logger.js";
import { computeStats } from "./logging/stats.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.CUSTOMERS_CONFIG
  ? path.resolve(process.cwd(), process.env.CUSTOMERS_CONFIG)
  : path.join(__dirname, "config", "customers.yaml");

const PORT = process.env.PORT || 8787;
const EMBEDDING_PROVIDER = process.env.EMBEDDING_PROVIDER || "openai";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small";

// A single OpenAI client for embeddings, keyed with whichever customer's key
// is on the request (embeddings are cheap enough this is a fine v1 shortcut).
const embeddingClientCache = new Map();
function embeddingClientFor(apiKey) {
  if (!embeddingClientCache.has(apiKey)) {
    embeddingClientCache.set(apiKey, new OpenAI({ apiKey }));
  }
  return embeddingClientCache.get(apiKey);
}

const cache = new SemanticCache();
setInterval(() => cache.prune(), 60_000).unref();

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/healthz", (req, res) => res.json({ ok: true }));

app.get("/api/stats", authMiddleware(CONFIG_PATH), (req, res) => {
  res.json(computeStats(req.customer.name));
});

app.post("/v1/chat/completions", authMiddleware(CONFIG_PATH), async (req, res) => {
  const customer = req.customer;
  const { messages, model: modelRequested, temperature, max_tokens } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: { message: "`messages` is required", type: "invalid_request_error" } });
  }

  const forceFlagship =
    req.get("x-force-model") === "flagship" || req.body.force_flagship === true;
  const promptText = messages.map((m) => m.content).join("\n");
  const cacheConfig = customer.cache ?? { enabled: false };

  try {
    if (cacheConfig.enabled && !forceFlagship) {
      const embedder = createEmbeddingProvider({
        provider: EMBEDDING_PROVIDER,
        openaiClient: embeddingClientFor(customer.provider_keys.openai),
        model: EMBEDDING_MODEL,
      });
      const embedding = await embedder.embed(promptText);
      const result = cache.find(customer.api_key, embedding, {
        similarityThreshold: cacheConfig.similarity_threshold ?? 0.92,
        ttlSeconds: cacheConfig.ttl_seconds ?? 86400,
      });

      if (result.hit) {
        const { entry } = result;
        const savedCost = estimateCost(
          entry.model,
          entry.response.usage.prompt_tokens,
          entry.response.usage.completion_tokens
        );

        logRequestEvent({
          customer: customer.name,
          model_requested: modelRequested ?? customer.default.model,
          model_used: entry.model,
          cache_hit: true,
          similarity: result.similarity,
          matched_rule: null,
          estimated_savings: savedCost,
        });

        return res.json(buildResponse({ modelUsed: entry.model, content: entry.response.content, usage: entry.response.usage, cacheHit: true, matchedRule: null, estimatedSavings: savedCost }));
      }
    }

    const route = selectRoute({ customer, promptText, forceFlagship });
    const providerKey = customer.provider_keys[route.provider];
    if (!providerKey) {
      return res.status(500).json({
        error: { message: `Customer has no provider key configured for "${route.provider}"`, type: "config_error" },
      });
    }

    const callArgs = { apiKey: providerKey, model: route.model, messages, temperature, max_tokens };
    const result = route.provider === "anthropic" ? await callAnthropic(callArgs) : await callOpenAI(callArgs);

    if (cacheConfig.enabled) {
      const embedder = createEmbeddingProvider({
        provider: EMBEDDING_PROVIDER,
        openaiClient: embeddingClientFor(customer.provider_keys.openai),
        model: EMBEDDING_MODEL,
      });
      const embedding = await embedder.embed(promptText);
      cache.store(customer.api_key, {
        embedding,
        promptText,
        response: result,
        model: route.model,
        ttlSeconds: cacheConfig.ttl_seconds ?? 86400,
      });
    }

    const actualCost = estimateCost(route.model, result.usage.prompt_tokens, result.usage.completion_tokens);
    const baselineCost = estimateCost(customer.default.model, result.usage.prompt_tokens, result.usage.completion_tokens);
    const estimatedSavings = Math.max(0, baselineCost - actualCost);

    logRequestEvent({
      customer: customer.name,
      model_requested: modelRequested ?? customer.default.model,
      model_used: route.model,
      cache_hit: false,
      matched_rule: route.matchedRule,
      estimated_savings: estimatedSavings,
    });

    return res.json(
      buildResponse({
        modelUsed: route.model,
        content: result.content,
        usage: result.usage,
        cacheHit: false,
        matchedRule: route.matchedRule,
        estimatedSavings,
      })
    );
  } catch (err) {
    console.error(err);
    return res.status(502).json({ error: { message: err.message ?? "Upstream provider error", type: "upstream_error" } });
  }
});

function buildResponse({ modelUsed, content, usage, cacheHit, matchedRule, estimatedSavings }) {
  return {
    id: `chatcmpl-${uuidv4()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelUsed,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.prompt_tokens + usage.completion_tokens,
    },
    rw_meta: { cache_hit: cacheHit, matched_rule: matchedRule, estimated_savings_usd: Number(estimatedSavings.toFixed(6)) },
  };
}

await loadRemotePricing();

app.listen(PORT, () => {
  console.log(`routewise listening on http://localhost:${PORT}`);
  console.log(`Customer config: ${CONFIG_PATH}`);
});
