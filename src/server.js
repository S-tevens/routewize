import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { v4 as uuidv4 } from "uuid";
import { createHash } from "node:crypto";
import OpenAI from "openai";
import { optimizeContext } from "./optimization/context.js";
import { evaluationRouter } from "./evaluation/routes.js";
import { financialOverview } from "./logging/financialOverview.js";
import { priceResponse, validateRates, promptCacheSavings } from "./evaluation/cost.js";

import { authMiddleware } from "./middleware/auth.js";
import { adminAuth } from "./middleware/adminAuth.js";
import { UsageGuard } from "./middleware/usageGuard.js";
import { watchCustomersConfig, loadCustomers } from "./config/loadConfig.js";
import { createEmbeddingProvider } from "./cache/embeddings.js";
import { SemanticCache } from "./cache/semanticCache.js";
import { scheduleNearMissVerification } from "./cache/nearMissVerification.js";
import { selectRoute } from "./router/rules.js";
import { callOpenAI, streamOpenAI } from "./providers/openai.js";
import { callAnthropic, streamAnthropic } from "./providers/anthropic.js";
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

// Applies unless a customer sets rate_limit.requests_per_minute explicitly;
// set it to 0/null in customers.yaml to disable the check for that customer.
const DEFAULT_REQUESTS_PER_MINUTE = 120;

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
watchCustomersConfig(CONFIG_PATH);
const usageGuard = new UsageGuard();

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

// Deliberately not part of the express.static(public) mount above -- the
// admin page lives in its own directory, served by its own explicit routes,
// so it shares no static mount, directory listing, or link path with
// anything a customer's browser ever loads. The page shell is unauthenticated
// (same pattern as the customer dashboard: pages are public shells, the API
// underneath is the real gate) but is never linked from customer-facing HTML
// and requires ADMIN_TOKEN to show any actual data.
const ADMIN_DIR = path.join(__dirname, "..", "admin");
app.get("/admin", (req, res) => res.sendFile(path.join(ADMIN_DIR, "admin.html")));
app.get("/admin/admin.js", (req, res) => res.sendFile(path.join(ADMIN_DIR, "admin.js")));

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

// Admin-only, cross-customer view. Namespaced under /admin/api (never
// /api) and gated by adminAuth() -- a wholly separate credential from any
// customer's api_key, checked with no shared code path (see adminAuth.js).
// No customer-facing page links here; nothing in this codebase points a
// customer at this route. Never returns prompt/response content -- there
// isn't any to return, since nothing in the logging path writes it.
app.get("/admin/api/overview", adminAuth(), (req, res) => {
  const days = Number(req.query.days ?? 14);
  if (![0, 7, 14, 30].includes(days)) return res.status(400).json({ error: { message: "days must be 0, 7, 14 or 30" } });
  const { customers } = loadCustomers(CONFIG_PATH);
  const perCustomer = customers.map((customer) => {
    const overview = financialOverview(customer, days);
    return {
      name: customer.name,
      customer_sha256: createHash("sha256").update(customer.api_key).digest("hex"),
      request_count: overview.request_count,
      provider_spend_usd: overview.provider_spend_usd,
      known_provider_spend_usd: overview.known_provider_spend_usd,
      unpriced_requests: overview.unpriced_requests,
      cost_saved_estimate_usd: overview.cost_saved_estimate_usd,
      cost_saved_breakdown_usd: overview.cost_saved_breakdown_usd,
      live_priced_requests: overview.live_priced_requests,
    };
  });
  const totals = perCustomer.reduce((acc, c) => ({
    request_count: acc.request_count + c.request_count,
    known_provider_spend_usd: acc.known_provider_spend_usd + (c.known_provider_spend_usd ?? 0),
    cost_saved_estimate_usd: acc.cost_saved_estimate_usd + (c.cost_saved_estimate_usd ?? 0),
  }), { request_count: 0, known_provider_spend_usd: 0, cost_saved_estimate_usd: 0 });
  res.json({ days, customer_count: perCustomer.length, totals, customers: perCustomer });
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

  const requestsPerMinute = customer.rate_limit?.requests_per_minute ?? DEFAULT_REQUESTS_PER_MINUTE;
  const rateResult = usageGuard.checkRateLimit(customer.api_key, requestsPerMinute);
  if (!rateResult.allowed) {
    res.set("Retry-After", String(rateResult.retryAfterSeconds));
    return res.status(429).json({
      error: { message: `Rate limit exceeded (${requestsPerMinute} requests/min). Retry after ${rateResult.retryAfterSeconds}s.`, type: "rate_limit_error" },
    });
  }

  const forceFlagship =
    req.get("x-force-model") === "flagship" || req.body.force_flagship === true;

  const isStream = req.body.stream === true;

  let optimized;
  try {
    if (req.body.tools || req.body.response_format) throw new Error("tools and response_format are not supported by this endpoint yet");
    optimized = optimizeContext(messages, req.body.rw_optimization, customer.optimization);
  } catch (err) {
    return res.status(400).json({ error: { message: err.message, type: "invalid_request_error" } });
  }

  const promptText = messages.map((m) => m.content).join("\n");
  const route = selectRoute({ customer, promptText, forceFlagship });
  const cacheConfig = customer.cache ?? { enabled: false };

  // Cache entries are namespaced per (customer, requested model, generation
  // settings, resolved route) so a hit can never reuse an answer generated
  // under different instructions or model settings — real prompt similarity
  // is still checked with actual embeddings *within* that namespace, so
  // semantically-similar-but-not-identical requests still hit.
  const cacheNamespace = createHash("sha256")
    .update(JSON.stringify({ customer: customer.api_key, model: modelRequested ?? null, temperature: temperature ?? null, max_tokens: max_tokens ?? null, route: { provider: route.provider, model: route.model } }))
    .digest("hex");
  const embeddingText = optimized.messages.map((m) => m.content).join("\n");

  try {
    let embedding;
    let cacheResult;
    if (cacheConfig.enabled && !forceFlagship) {
      const embedder = createEmbeddingProvider({
        provider: EMBEDDING_PROVIDER,
        openaiClient: embeddingClientFor(customer.provider_keys.openai),
        model: EMBEDDING_MODEL,
      });
      embedding = await embedder.embed(embeddingText);
      const result = cache.find(cacheNamespace, embedding, {
        similarityThreshold: cacheConfig.similarity_threshold ?? 0.92,
        ttlSeconds: cacheConfig.ttl_seconds ?? 86400,
        includeNearMiss: cacheConfig.near_miss_verification?.enabled === true,
      });
      cacheResult = result;

      if (result.hit) {
        const { entry } = result;
        const savedCost = estimateCost(
          entry.model,
          entry.response.usage.prompt_tokens,
          entry.response.usage.completion_tokens
        );
        // Baseline for the "what would this have cost without routewize"
        // chart, not the savings number above (which compares against the
        // cached model, not necessarily the customer's default) -- always
        // the default model, so the chart's definition of "baseline" stays
        // consistent across cache hits, routed calls, and default-model calls.
        const defaultModelCost = estimateCost(
          customer.default.model,
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
          savings_breakdown: { cache_usd: savedCost, routing_usd: 0, prompt_cache_usd: 0 },
          cost_estimate: { baseline_usd: defaultModelCost, actual_usd: 0 },
          optimization: optimized.metrics,
        });

        if (isStream) {
          // No real generation happened, so there's nothing to stream
          // token-by-token — the full cached answer goes out as one chunk.
          // Still a valid SSE stream: a client accumulating
          // choices[0].delta.content across chunks gets the same result
          // whether it arrives in one piece or many.
          writeSseHeaders(res);
          writeSseChunk(res, {
            id: `chatcmpl-${uuidv4()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: entry.model,
            choices: [{ index: 0, delta: { role: "assistant", content: entry.response.content }, finish_reason: "stop" }],
            usage: {
              prompt_tokens: entry.response.usage.prompt_tokens,
              completion_tokens: entry.response.usage.completion_tokens,
              total_tokens: entry.response.usage.prompt_tokens + entry.response.usage.completion_tokens,
            },
            rw_meta: { cache_hit: true, matched_rule: null, estimated_savings_usd: Number(savedCost.toFixed(6)), optimization: optimized.metrics },
          });
          return endSseStream(res);
        }

        return res.json(buildResponse({ modelUsed: entry.model, content: entry.response.content, usage: entry.response.usage, cacheHit: true, matchedRule: null, estimatedSavings: savedCost, optimization: optimized.metrics }));
      }
    }

    const providerKey = customer.provider_keys[route.provider];
    if (!providerKey) {
      return res.status(500).json({
        error: { message: `Customer has no provider key configured for "${route.provider}"`, type: "config_error" },
      });
    }

    const maxDailySpendUsd = customer.rate_limit?.max_daily_spend_usd ?? null;
    const spendCheck = usageGuard.checkSpendCap(customer.api_key, maxDailySpendUsd);
    if (!spendCheck.allowed) {
      return res.status(429).json({
        error: {
          message: `Daily spend cap of $${maxDailySpendUsd} reached (spent $${spendCheck.spentToday.toFixed(4)} today, UTC). Cache hits still work; real model calls are blocked until the cap resets at UTC midnight.`,
          type: "spend_cap_exceeded",
        },
      });
    }

    const callArgs = { apiKey: providerKey, model: route.model, messages: optimized.messages, temperature, max_tokens };

    if (isStream) {
      return await handleStreamingCall(res, { customer, route, modelRequested, optimized, callArgs, cache, cacheConfig, cacheNamespace, cacheResult, embedding, embeddingText, usageGuard, forceFlagship });
    }

    const result = route.provider === "anthropic" ? await callAnthropic(callArgs) : await callOpenAI(callArgs);

    let currentEntry;
    if (cacheConfig.enabled && !forceFlagship) {
      currentEntry = cache.store(cacheNamespace, {
        embedding,
        promptText: embeddingText,
        response: result,
        model: route.model,
        ttlSeconds: cacheConfig.ttl_seconds ?? 86400,
      });
    }

    const actualCost = estimateCost(route.model, result.usage.prompt_tokens, result.usage.completion_tokens);
    const baselineCost = estimateCost(customer.default.model, result.usage.prompt_tokens, result.usage.completion_tokens);
    const estimatedSavings = Math.max(0, baselineCost - actualCost);
    usageGuard.recordSpend(customer.api_key, actualCost);

    let providerSpend = null;
    let promptCacheSavingsUsd = null;
    try {
      const rates = validateRates(customer.evaluation?.pricing?.[`${route.provider}/${route.model}`], route.provider);
      providerSpend = priceResponse(route.provider, result.raw, rates).cost_usd;
      promptCacheSavingsUsd = promptCacheSavings(route.provider, result.raw, rates);
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
      savings_breakdown: { cache_usd: 0, routing_usd: estimatedSavings, prompt_cache_usd: promptCacheSavingsUsd },
      cost_estimate: { baseline_usd: baselineCost, actual_usd: actualCost },
      optimization: optimized.metrics,
    });

    scheduleNearMissVerification(res, { customer, cache, cacheNamespace, cacheResult, currentEntry, usageGuard });
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

function writeSseHeaders(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
}

function writeSseChunk(res, chunk) {
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function endSseStream(res) {
  res.write("data: [DONE]\n\n");
  return res.end();
}

// Streams a real provider call chunk-by-chunk. Headers commit to SSE only
// after the first chunk is successfully received — an immediate failure
// (bad key, etc., same as the non-streaming path's first `await`) still
// gets a clean 502 JSON response instead of an SSE payload. Once streaming
// has visibly started, a later failure can only be reported as an in-stream
// error event, since the response status/headers are already sent.
async function handleStreamingCall(res, { customer, route, modelRequested, optimized, callArgs, cache, cacheConfig, cacheNamespace, cacheResult, embedding, embeddingText, usageGuard, forceFlagship }) {
  const resultSink = {};
  const generator = route.provider === "anthropic" ? streamAnthropic(callArgs, resultSink) : streamOpenAI(callArgs, resultSink);
  const iterator = generator[Symbol.asyncIterator]();

  let first;
  try {
    first = await iterator.next();
  } catch (err) {
    console.error(err);
    return res.status(502).json({ error: { message: err.message ?? "Upstream provider error", type: "upstream_error" } });
  }

  writeSseHeaders(res);
  let content = "";
  let currentEntry;

  const processChunk = (chunk) => {
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) content += delta;

    if (!chunk.usage) {
      writeSseChunk(res, chunk);
      return;
    }

    // Final chunk — usage is known now, so compute cost/savings and attach
    // rw_meta before forwarding it, same info the non-streaming response
    // carries, just delivered on the last chunk instead of the only one.
    const usage = { prompt_tokens: chunk.usage.prompt_tokens, completion_tokens: chunk.usage.completion_tokens };
    const actualCost = estimateCost(route.model, usage.prompt_tokens, usage.completion_tokens);
    const baselineCost = estimateCost(customer.default.model, usage.prompt_tokens, usage.completion_tokens);
    const estimatedSavings = Math.max(0, baselineCost - actualCost);
    usageGuard.recordSpend(customer.api_key, actualCost);

    if (cacheConfig.enabled && !forceFlagship) {
      currentEntry = cache.store(cacheNamespace, { embedding, promptText: embeddingText, response: { content, usage }, model: route.model, ttlSeconds: cacheConfig.ttl_seconds ?? 86400 });
    }

    let providerSpend = null;
    let promptCacheSavingsUsd = null;
    try {
      const rates = validateRates(customer.evaluation?.pricing?.[`${route.provider}/${route.model}`], route.provider);
      providerSpend = priceResponse(route.provider, resultSink.raw, rates).cost_usd;
      promptCacheSavingsUsd = promptCacheSavings(route.provider, resultSink.raw, rates);
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
      savings_breakdown: { cache_usd: 0, routing_usd: estimatedSavings, prompt_cache_usd: promptCacheSavingsUsd },
      cost_estimate: { baseline_usd: baselineCost, actual_usd: actualCost },
      optimization: optimized.metrics,
    });

    chunk.rw_meta = { cache_hit: false, matched_rule: route.matchedRule, estimated_savings_usd: Number(estimatedSavings.toFixed(6)), optimization: optimized.metrics };
    writeSseChunk(res, chunk);
  };

  let completed = false;
  try {
    if (!first.done) {
      processChunk(first.value);
      let next = await iterator.next();
      while (!next.done) {
        processChunk(next.value);
        next = await iterator.next();
      }
    }
    completed = true;
  } catch (err) {
    console.error(err);
    writeSseChunk(res, { error: { message: err.message ?? "Upstream provider error", type: "upstream_error" } });
  }

  if (completed) scheduleNearMissVerification(res, { customer, cache, cacheNamespace, cacheResult, currentEntry, usageGuard });
  return endSseStream(res);
}

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
  console.log(`routewize listening on http://localhost:${PORT}`);
  console.log(`Customer config: ${CONFIG_PATH}`);
});
