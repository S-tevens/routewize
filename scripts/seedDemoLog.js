import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadCustomers } from "../src/config/loadConfig.js";
import { createEmbeddingProvider } from "../src/cache/embeddings.js";
import { SemanticCache } from "../src/cache/semanticCache.js";
import { selectRoute } from "../src/router/rules.js";
import { estimateCost, estimateTokens, loadRemotePricing } from "../src/logging/pricing.js";
import { LOG_FILE } from "../src/logging/logger.js";

// Local-only helper: replays a sample dataset through the real cache+router
// logic and writes entries directly to logs/requests.log, backdated across
// several days — so the dashboard can be checked against realistic-looking
// data before any real traffic exists. logs/ is gitignored; this never
// ships anywhere.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const inputPath = process.argv[2] || "sample-data/llm_api_requests_300.jsonl";
const configPath = path.join(__dirname, "..", "src", "config", "customers.yaml");

await loadRemotePricing();
const { byApiKey } = loadCustomers(configPath);
const embedder = createEmbeddingProvider({ provider: "mock" });
const cache = new SemanticCache();

const lines = fs.readFileSync(path.resolve(process.cwd(), inputPath), "utf8").split("\n").filter(Boolean);
const DAYS = 7;
const now = Date.now();

const outLines = [];

for (let i = 0; i < lines.length; i++) {
  const record = JSON.parse(lines[i]);
  const customer = byApiKey.get(record.customer_api_key);
  if (!customer) continue;

  const promptText = record.messages.map((m) => m.content).join("\n");
  const promptTokens = record.usage?.prompt_tokens ?? estimateTokens(promptText);
  const completionTokens = record.usage?.completion_tokens ?? Math.round(promptTokens * 0.6);
  const baselineModel = record.model_requested ?? customer.default.model;

  const cacheConfig = customer.cache ?? { enabled: false };
  const embedding = await embedder.embed(promptText);

  let event;
  if (cacheConfig.enabled) {
    const result = cache.find(customer.api_key, embedding, {
      similarityThreshold: cacheConfig.similarity_threshold ?? 0.92,
      ttlSeconds: cacheConfig.ttl_seconds ?? 86400,
    });
    if (result.hit) {
      const savedCost = estimateCost(result.entry.model, result.entry.response.usage.prompt_tokens, result.entry.response.usage.completion_tokens);
      event = { customer: customer.name, model_requested: baselineModel, model_used: result.entry.model, cache_hit: true, similarity: result.similarity, matched_rule: null, estimated_savings: savedCost };
    }
  }

  if (!event) {
    const route = selectRoute({ customer, promptText, forceFlagship: false });
    if (cacheConfig.enabled) {
      cache.store(customer.api_key, { embedding, promptText, response: { content: "x", usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens } }, model: route.model, ttlSeconds: cacheConfig.ttl_seconds ?? 86400 });
    }
    const actualCost = estimateCost(route.model, promptTokens, completionTokens);
    const baselineCost = estimateCost(customer.default.model, promptTokens, completionTokens);
    event = { customer: customer.name, model_requested: baselineModel, model_used: route.model, cache_hit: false, matched_rule: route.matchedRule, estimated_savings: Math.max(0, baselineCost - actualCost) };
  }

  // Spread requests realistically across the last DAYS days, business-hours-ish.
  const dayOffset = Math.floor((i / lines.length) * DAYS);
  const timestamp = new Date(now - (DAYS - dayOffset) * 86400_000 + Math.random() * 8 * 3600_000).toISOString();

  outLines.push(JSON.stringify({ timestamp, ...event }));
}

fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
fs.writeFileSync(LOG_FILE, outLines.join("\n") + "\n", "utf8");
console.log(`Wrote ${outLines.length} demo log entries to ${LOG_FILE}`);
