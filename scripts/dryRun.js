import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";

import { loadCustomers } from "../src/config/loadConfig.js";
import { createEmbeddingProvider } from "../src/cache/embeddings.js";
import { SemanticCache } from "../src/cache/semanticCache.js";
import { selectRoute } from "../src/router/rules.js";
import { estimateCost, estimateTokens, loadRemotePricing } from "../src/logging/pricing.js";

// Simulates the proxy over a customer's historical request log WITHOUT
// calling any real provider — this is the "point 6, step 3" proof-of-concept
// tool: run past traffic through the router+cache logic and report what
// would have happened, so you can show a customer one number before they
// change a single line of code.
//
// Usage: node scripts/dryRun.js <path-to-jsonl> [customers-config-path]
//
// Input JSONL, one request per line:
//   { "customer_api_key": "...", "messages": [{"role":"user","content":"..."}],
//     "model_requested": "gpt-4o", "usage": {"prompt_tokens": 120, "completion_tokens": 40} }
// `usage` is optional — if the customer's export doesn't have it, tokens are
// estimated from prompt/response length instead.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("Usage: node scripts/dryRun.js <path-to-jsonl> [customers-config-path]");
    process.exit(1);
  }

  const configPath = process.argv[3]
    ? path.resolve(process.cwd(), process.argv[3])
    : path.join(__dirname, "..", "src", "config", "customers.yaml");

  await loadRemotePricing();
  const { byApiKey } = loadCustomers(configPath);
  const lines = fs.readFileSync(path.resolve(process.cwd(), inputPath), "utf8").split("\n").filter(Boolean);

  const embeddingProviderName = process.env.EMBEDDING_PROVIDER || "mock";
  const embeddingClients = new Map();
  const embedderFor = (customer) => {
    if (embeddingProviderName === "mock") return createEmbeddingProvider({ provider: "mock" });
    if (!embeddingClients.has(customer.api_key)) {
      embeddingClients.set(customer.api_key, new OpenAI({ apiKey: customer.provider_keys.openai }));
    }
    return createEmbeddingProvider({
      provider: "openai",
      openaiClient: embeddingClients.get(customer.api_key),
      model: process.env.EMBEDDING_MODEL || "text-embedding-3-small",
    });
  };

  const cache = new SemanticCache();

  let totalRequests = 0;
  let cacheHits = 0;
  let routedToCheaper = 0;
  let baselineCostTotal = 0;
  let optimizedCostTotal = 0;
  const perCustomer = new Map();

  for (const line of lines) {
    const record = JSON.parse(line);
    const customer = byApiKey.get(record.customer_api_key);
    if (!customer) {
      console.warn(`Skipping request: unknown customer_api_key "${record.customer_api_key}"`);
      continue;
    }

    totalRequests++;
    const promptText = record.messages.map((m) => m.content).join("\n");
    const promptTokens = record.usage?.prompt_tokens ?? estimateTokens(promptText);
    const completionTokens = record.usage?.completion_tokens ?? Math.round(promptTokens * 0.6);

    const baselineModel = record.model_requested ?? customer.default.model;
    const baselineCost = estimateCost(baselineModel, promptTokens, completionTokens);
    baselineCostTotal += baselineCost;

    const cacheConfig = customer.cache ?? { enabled: false };
    let optimizedCost;
    let stats = perCustomer.get(customer.name) ?? { requests: 0, cacheHits: 0, routed: 0, baseline: 0, optimized: 0 };
    stats.requests++;

    if (cacheConfig.enabled) {
      const embedder = embedderFor(customer);
      const embedding = await embedder.embed(promptText);
      const result = cache.find(customer.api_key, embedding, {
        similarityThreshold: cacheConfig.similarity_threshold ?? 0.92,
        ttlSeconds: cacheConfig.ttl_seconds ?? 86400,
      });

      if (result.hit) {
        cacheHits++;
        stats.cacheHits++;
        optimizedCost = 0;
      } else {
        const route = selectRoute({ customer, promptText, forceFlagship: false });
        if (route.model !== baselineModel) {
          routedToCheaper++;
          stats.routed++;
        }
        optimizedCost = estimateCost(route.model, promptTokens, completionTokens);
        cache.store(customer.api_key, {
          embedding,
          promptText,
          response: { content: "[dry-run placeholder]", usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens } },
          model: route.model,
          ttlSeconds: cacheConfig.ttl_seconds ?? 86400,
        });
      }
    } else {
      const route = selectRoute({ customer, promptText, forceFlagship: false });
      if (route.model !== baselineModel) {
        routedToCheaper++;
        stats.routed++;
      }
      optimizedCost = estimateCost(route.model, promptTokens, completionTokens);
    }

    optimizedCostTotal += optimizedCost;
    stats.baseline += baselineCost;
    stats.optimized += optimizedCost;
    perCustomer.set(customer.name, stats);
  }

  const savingsPct = baselineCostTotal > 0 ? ((baselineCostTotal - optimizedCostTotal) / baselineCostTotal) * 100 : 0;

  console.log("\n=== routewise — Dry Run Report ===\n");
  console.log(`Requests analyzed:     ${totalRequests}`);
  console.log(`Cache hits:            ${cacheHits} (${pct(cacheHits, totalRequests)})`);
  console.log(`Routed to cheaper model: ${routedToCheaper} (${pct(routedToCheaper, totalRequests)})`);
  console.log(`Baseline cost (flagship, no cache): $${baselineCostTotal.toFixed(4)}`);
  console.log(`Estimated cost with router+cache:   $${optimizedCostTotal.toFixed(4)}`);
  console.log(`\n>>> Based on these ${totalRequests} requests, this would have cut the bill by ${savingsPct.toFixed(1)}%. <<<\n`);

  console.log("Per customer:");
  for (const [name, s] of perCustomer) {
    const custSavingsPct = s.baseline > 0 ? ((s.baseline - s.optimized) / s.baseline) * 100 : 0;
    console.log(
      `  - ${name}: ${s.requests} requests, ${pct(s.cacheHits, s.requests)} cache hit rate, ${pct(s.routed, s.requests)} routed cheaper, ${custSavingsPct.toFixed(1)}% savings`
    );
  }
}

function pct(n, total) {
  return total > 0 ? `${((n / total) * 100).toFixed(1)}%` : "0%";
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
