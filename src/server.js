import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { v4 as uuidv4 } from "uuid";
import { createHash } from "node:crypto";
import { optimizeContext } from "./optimization/context.js";
import { evaluationRouter } from "./evaluation/routes.js";
import { financialOverview } from "./logging/financialOverview.js";
import { priceResponse, validateRates } from "./evaluation/cost.js";

import { authMiddleware } from "./middleware/auth.js";
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
const cache = new SemanticCache();
setInterval(() => cache.prune(), 60_000).unref();

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/healthz", (req, res) => res.json({ ok: true }));
app.use("/v1/evaluations", authMiddleware(CONFIG_PATH), evaluationRouter());

app.get("/api/stats", authMiddleware(CONFIG_PATH), (req, res) => {
  res.json(computeStats(req.customer.name));
});

app.get("/api/financial-overview", authMiddleware(CONFIG_PATH), (req, res) => {
  const days = Number(req.query.days ?? 14);
  if (![0, 7, 14, 30].includes(days)) return res.status(400).json({ error: { message: "days must be 0, 7, 14 or 30" } });
  res.json(financialOverview(req.customer, days));
});

app.post("/v1/optimize", authMiddleware(CONFIG_PATH), (req, res) => {
  try {
    res.json(optimizeContext(req.body.messages, req.body.rw_optimization, req.customer.optimization));
  } catch (err) {
    res.status(400).json({ error: { message: err.message, type: "invalid_request_error" } });
  }
});

app.post("/v1/chat/completions", authMiddleware(CONFIG_PATH), async (req, res) => {
  const customer = req.customer;
  const { messages, model: modelRequested, temperature, max_tokens } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: { message: "`messages` is required", type: "invalid_request_error" } });
  }

  const forceFlagship =
    req.get("x-force-model") === "flagship" || req.body.force_flagship === true;
  let optimized;
  try {
    if (req.body.stream || req.body.tools || req.body.response_format) throw new Error("Streaming, tools and response_format are not supported by this endpoint yet");
    optimized = optimizeContext(messages, req.body.rw_optimization, customer.optimization);
  } catch (err) {
    return res.status(400).json({ error: { message: err.message, type: "invalid_request_error" } });
  }
  const promptText = messages.map((m) => m.content).join("\n");
  const route = selectRoute({ customer, promptText, forceFlagship });
  // Exact request isolation prevents similar text from reusing an answer with
  // different instructions, context, generation settings or routing policy.
  const cacheNamespace = createHash("sha256").update(JSON.stringify({ customer: customer.api_key, messages: optimized.messages, model: modelRequested, route, temperature, max_tokens })).digest("hex");
  const cacheConfig = customer.cache ?? { enabled: false };

  try {
    if (cacheConfig.enabled && !forceFlagship) {
      const result = cache.find(cacheNamespace, [1], {
        similarityThreshold: 1,
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
          customer_sha256: createHash("sha256").update(customer.api_key).digest("hex"),
          financials: { provider_spend_usd: 0, source: "response_cache_no_provider_call" },
          model_requested: modelRequested ?? customer.default.model,
          model_used: entry.model,
          cache_hit: true,
          similarity: result.similarity,
          matched_rule: null,
          estimated_savings: savedCost,
          optimization: optimized.metrics,
        });

        return res.json(buildResponse({ modelUsed: entry.model, content: entry.response.content, usage: entry.response.usage, cacheHit: true, matchedRule: null, estimatedSavings: savedCost, optimization: optimized.metrics }));
      }
    }

    const providerKey = customer.provider_keys[route.provider];
    if (!providerKey) {
      return res.status(500).json({
        error: { message: `Customer has no provider key configured for "${route.provider}"`, type: "config_error" },
      });
    }

    const callArgs = { apiKey: providerKey, model: route.model, messages: optimized.messages, temperature, max_tokens };
    const result = route.provider === "anthropic" ? await callAnthropic(callArgs) : await callOpenAI(callArgs);

    if (cacheConfig.enabled && !forceFlagship) {
      cache.store(cacheNamespace, {
        embedding: [1],
        promptText,
        response: result,
        model: route.model,
        ttlSeconds: cacheConfig.ttl_seconds ?? 86400,
      });
    }

    const actualCost = estimateCost(route.model, result.usage.prompt_tokens, result.usage.completion_tokens);
    const baselineCost = estimateCost(customer.default.model, result.usage.prompt_tokens, result.usage.completion_tokens);
    const estimatedSavings = Math.max(0, baselineCost - actualCost);

    let providerSpend = null;
    try {
      const rates = validateRates(customer.evaluation?.pricing?.[`${route.provider}/${route.model}`]);
      providerSpend = priceResponse(route.provider, result.raw, rates).cost_usd;
    } catch { /* Missing pricing/usage is unknown, never assumed to be free. */ }

    logRequestEvent({
      customer: customer.name,
      customer_sha256: createHash("sha256").update(customer.api_key).digest("hex"),
      financials: { provider_spend_usd: providerSpend, source: "provider_usage_at_configured_rates" },
      model_requested: modelRequested ?? customer.default.model,
      model_used: route.model,
      cache_hit: false,
      matched_rule: route.matchedRule,
      estimated_savings: estimatedSavings,
      optimization: optimized.metrics,
    });

    return res.json(
      buildResponse({
        modelUsed: route.model,
        content: result.content,
        usage: result.usage,
        cacheHit: false,
        matchedRule: route.matchedRule,
        estimatedSavings,
        optimization: optimized.metrics,
      })
    );
  } catch (err) {
    console.error(err);
    return res.status(502).json({ error: { message: err.message ?? "Upstream provider error", type: "upstream_error" } });
  }
});

function buildResponse({ modelUsed, content, usage, cacheHit, matchedRule, estimatedSavings, optimization }) {
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
    rw_meta: { cache_hit: cacheHit, matched_rule: matchedRule, estimated_savings_usd: Number(estimatedSavings.toFixed(6)), optimization },
  };
}

await loadRemotePricing();

app.listen(PORT, () => {
  console.log(`routewise listening on http://localhost:${PORT}`);
  console.log(`Customer config: ${CONFIG_PATH}`);
});
