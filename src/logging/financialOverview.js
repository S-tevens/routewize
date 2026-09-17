import fs from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { getRequestLogStore } from "./requestLogStore.js";

const receiptsPath = fileURLToPath(new URL("../../logs/evaluations.log", import.meta.url));
const money = (value) => typeof value === "number" && Number.isFinite(value);
function readLines(path) {
  if (!fs.existsSync(path)) return [];
  return fs.readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

export function summarizeFinancials(events, receipts, customer, days = 14, now = new Date()) {
  const tenant = createHash("sha256").update(customer.api_key).digest("hex");
  const start = days ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days + 1)).getTime() : -Infinity;
  const inRange = (date) => Number.isFinite(Date.parse(date)) && Date.parse(date) >= start && Date.parse(date) <= now.getTime();
  const requests = events.filter((e) => e && inRange(e.timestamp) && (e.customer_sha256 ? e.customer_sha256 === tenant : e.customer === customer.name));
  const known = requests.filter((e) => money(e.financials?.provider_spend_usd) && e.financials.provider_spend_usd >= 0);
  const saved = requests.filter((e) => money(e.estimated_savings));
  // Per-mechanism breakdown of the blended cost_saved_estimate_usd above.
  // Only requests logged after this field was introduced carry it — older
  // rows are excluded from the breakdown (not counted as zero) rather than
  // silently understating one bucket.
  const withBreakdown = requests.filter((e) => e.savings_breakdown);
  const cacheSavingsSum = withBreakdown.reduce((n, e) => n + (money(e.savings_breakdown.cache_usd) ? e.savings_breakdown.cache_usd : 0), 0);
  const routingSavingsSum = withBreakdown.reduce((n, e) => n + (money(e.savings_breakdown.routing_usd) ? e.savings_breakdown.routing_usd : 0), 0);
  const promptCachePriced = withBreakdown.filter((e) => money(e.savings_breakdown.prompt_cache_usd));
  // Live-traffic baseline-vs-actual, shaped like comparison_daily below so
  // the same chart renderer works for both. Only requests logged after
  // cost_estimate was introduced are included -- older rows are excluded
  // (not counted as zero), same convention as the breakdown above.
  const withCostEstimate = requests.filter((e) => e.cost_estimate && money(e.cost_estimate.baseline_usd) && money(e.cost_estimate.actual_usd));
  const liveByDay = new Map();
  for (const e of withCostEstimate) {
    const date = e.timestamp.slice(0, 10);
    const day = liveByDay.get(date) ?? { date, baseline: 0, optimized: 0, pairs: 0 };
    day.baseline += e.cost_estimate.baseline_usd; day.optimized += e.cost_estimate.actual_usd; day.pairs++;
    liveByDay.set(date, day);
  }
  // Match current API-key identity; never merge receipts by display name.
  const seen = new Set();
  const runs = receipts.filter((r) => {
    if (!r || !r.id || seen.has(r.id) || r.customer_sha256 !== tenant || !inRange(r.created_at)) return false;
    seen.add(r.id); return true;
  });
  const pairs = [];
  for (const run of runs) for (const pair of run.cases ?? []) {
    if (pair?.baseline?.status !== "measured" || pair?.optimized?.status !== "measured") continue;
    const baseline = pair.baseline.usage?.cost_usd;
    const optimized = pair.optimized.usage?.cost_usd;
    const overhead = run.policy?.overhead_usd_per_optimized_request;
    if (![baseline, optimized, overhead].every((v) => money(v) && v >= 0)) continue;
    pairs.push({ date: run.created_at.slice(0, 10), baseline, optimized: optimized + overhead, qualified: pair.baseline.passed === true && pair.optimized.passed === true });
  }
  const byDay = new Map();
  for (const p of pairs) {
    const day = byDay.get(p.date) ?? { date: p.date, baseline: 0, optimized: 0, pairs: 0 };
    day.baseline += p.baseline; day.optimized += p.optimized; day.pairs++;
    byDay.set(p.date, day);
  }
  const qualified = pairs.filter((p) => p.qualified);
  const qualifiedBaseline = qualified.reduce((n, p) => n + p.baseline, 0);
  const potential = qualified.reduce((n, p) => n + p.baseline - p.optimized, 0);
  const testSpendKnown = runs.filter((r) => money(r.summary?.known_provider_spend_usd));
  return {
    days, currency: "USD", request_count: requests.length,
    provider_spend_usd: requests.length && known.length === requests.length ? known.reduce((n, e) => n + e.financials.provider_spend_usd, 0) : null,
    known_provider_spend_usd: known.length ? known.reduce((n, e) => n + e.financials.provider_spend_usd, 0) : null,
    priced_requests: known.length, unpriced_requests: requests.length - known.length,
    cost_saved_estimate_usd: saved.length ? saved.reduce((n, e) => n + e.estimated_savings, 0) : null,
    cost_saved_breakdown_usd: withBreakdown.length ? {
      cache_usd: cacheSavingsSum,
      routing_usd: routingSavingsSum,
      prompt_cache_usd: promptCachePriced.length ? promptCachePriced.reduce((n, e) => n + e.savings_breakdown.prompt_cache_usd, 0) : null,
    } : null,
    breakdown_priced_requests: withBreakdown.length,
    prompt_cache_priced_requests: promptCachePriced.length,
    unverified_historical_requests: requests.filter((e) => !e.financials).length,
    potential_savings_usd: qualified.length ? potential : null,
    potential_reduction_pct: qualifiedBaseline > 0 ? potential / qualifiedBaseline * 100 : null,
    qualified_pairs: qualified.length, compared_pairs: pairs.length, evaluation_count: runs.length,
    known_evaluation_provider_spend_usd: testSpendKnown.length ? testSpendKnown.reduce((n, r) => n + r.summary.known_provider_spend_usd, 0) : null,
    evaluation_spend_incomplete: runs.some((r) => r.summary?.total_evaluation_cost_usd == null),
    comparison_daily: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
    live_comparison_daily: [...liveByDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
    live_priced_requests: withCostEstimate.length,
    invoice_verified: false,
  };
}

export function financialOverview(customer, days) {
  const now = new Date();
  const period = days ?? 14;
  const start = period ? Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - period + 1) : -Infinity;
  const tenant = createHash("sha256").update(customer.api_key).digest("hex");
  const events = getRequestLogStore().requestsForCustomer(customer.name, tenant, start, now.getTime());
  return summarizeFinancials(events, readLines(receiptsPath), customer, period, now);
}
