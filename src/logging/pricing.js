// Static fallback — USD price per 1K tokens — used when the live pricing
// feed can't be reached, or doesn't (yet) list a given model. Deliberately
// small: it only needs to cover our own example config's default models.
//
// NOTE (2026-09-12): tokenscost.com's model `id` strings don't match the
// real Anthropic/OpenAI API model strings exactly (e.g. it lists
// "claude-sonnet-4.6", the real API id is "claude-sonnet-4-6") — so the
// live feed will rarely match current Anthropic models by exact id, and
// these fallback entries carry more real weight than the name suggests.
// Verified against provider docs on 2026-09-12:
// - claude-3-5-sonnet-20241022 and claude-3-5-haiku-20241022 are RETIRED
//   (Anthropic: requests to retired models fail outright) — kept here only
//   so old logs/sample-data referencing them still price consistently.
//   customers.example.yaml has been updated to use the active replacements.
// - gpt-4o / gpt-4o-mini are still active (not retired), just no longer
//   OpenAI's recommended/flagship tier.
const FALLBACK_PRICING = {
  "gpt-4o": { in: 0.0025, out: 0.01 },
  "gpt-4o-mini": { in: 0.00015, out: 0.0006 },
  "gpt-4-turbo": { in: 0.01, out: 0.03 },
  "claude-sonnet-4-6": { in: 0.003, out: 0.015 },
  "claude-haiku-4-5-20251001": { in: 0.001, out: 0.005 },
  // Retired models — kept only for consistent historical cost estimates.
  "claude-3-5-sonnet-20241022": { in: 0.003, out: 0.015 },
  "claude-3-5-haiku-20241022": { in: 0.0008, out: 0.004 },
  "claude-3-opus-20240229": { in: 0.015, out: 0.075 },
};

const DEFAULT_PRICE = { in: 0.003, out: 0.015 };

const REMOTE_PRICING_URL = "https://tokenscost.com/data/pricing.min.json";

// null = not loaded yet (priceFor falls back to the static table below).
// {} = load was attempted and found nothing usable (offline, bad response,
// or PRICING_SOURCE=static) — also falls back, but won't retry mid-process.
let remotePricing = null;
let loadPromise = null;

// Fetches live per-model pricing once per process and caches it in memory.
// Call this during startup (server.js, scripts/dryRun.js); priceFor() stays
// synchronous and just uses whatever's loaded (or the static table if
// nothing is, including before this has been called — e.g. in tests).
export function loadRemotePricing({ timeoutMs = 3000 } = {}) {
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    if (process.env.PRICING_SOURCE === "static") {
      console.log("PRICING_SOURCE=static set — using built-in pricing table only.");
      remotePricing = {};
      return remotePricing;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetch(REMOTE_PRICING_URL, { signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();
      const table = {};
      for (const model of data.models ?? []) {
        if (typeof model.inputPricePerM === "number" && typeof model.outputPricePerM === "number") {
          table[model.id] = { in: model.inputPricePerM / 1000, out: model.outputPricePerM / 1000 };
        }
      }
      remotePricing = table;
      console.log(`Loaded live pricing for ${Object.keys(table).length} models from tokenscost.com`);
    } catch (err) {
      console.warn(`Could not load live pricing from tokenscost.com (${err.message}); using built-in fallback pricing.`);
      remotePricing = {};
    }
    return remotePricing;
  })();

  return loadPromise;
}

export function priceFor(model) {
  if (remotePricing && remotePricing[model]) return remotePricing[model];
  return FALLBACK_PRICING[model] ?? DEFAULT_PRICE;
}

export function estimateCost(model, inputTokens, outputTokens) {
  const price = priceFor(model);
  return (inputTokens / 1000) * price.in + (outputTokens / 1000) * price.out;
}

// Rough token estimate (~4 chars/token) for cases where we don't have a real
// tokenizer wired up. Good enough for cost estimates and routing rules.
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
