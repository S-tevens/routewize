import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { summarizeFinancials } from "../src/logging/financialOverview.js";
const customer = { api_key: "tenant-key", name: "Customer" };
const tenant = createHash("sha256").update(customer.api_key).digest("hex");
const now = new Date("2026-09-11T12:00:00Z");
const event = (cost) => ({ customer_sha256: tenant, timestamp: now.toISOString(), estimated_savings: 1, financials: { provider_spend_usd: cost } });
function receipt(id = "r", pass = true, optimized = 3) {
  return { id, customer_sha256: tenant, created_at: now.toISOString(), policy: { overhead_usd_per_optimized_request: 1 }, summary: { known_provider_spend_usd: 5 + optimized, total_evaluation_cost_usd: 6 + optimized }, cases: [{ baseline: { status: "measured", passed: true, usage: { cost_usd: 5 } }, optimized: { status: "measured", passed: pass, usage: { cost_usd: optimized } } }] };
}
test("unknown billing is not displayed as zero or a complete partial total", () => {
  const out = summarizeFinancials([event(2), event(null)], [], customer, 14, now);
  assert.equal(out.provider_spend_usd, null);
  assert.equal(out.known_provider_spend_usd, 2);
  assert.equal(out.unpriced_requests, 1);
});
test("cache zero is known; legacy request estimates remain labeled", () => {
  const out = summarizeFinancials([event(0), { customer: "Customer", timestamp: now.toISOString(), estimated_savings: 4 }], [], customer, 14, now);
  assert.equal(out.known_provider_spend_usd, 0);
  assert.equal(out.cost_saved_estimate_usd, 5);
  assert.equal(out.unverified_historical_requests, 1);
});
test("qualifying potential subtracts overhead; failed checks stay in comparison only", () => {
  const out = summarizeFinancials([], [receipt(), receipt("failed", false, 1)], customer, 14, now);
  assert.equal(out.potential_savings_usd, 1);
  assert.equal(out.potential_reduction_pct, 20);
  assert.equal(out.qualified_pairs, 1);
  assert.deepEqual(out.comparison_daily, [{ date: "2026-09-11", baseline: 10, optimized: 6, pairs: 2 }]);
  assert.equal(out.known_evaluation_provider_spend_usd, 14);
});
test("negative potential is preserved and receipt duplicates do not inflate spend", () => {
  const r = receipt("r", true, 7);
  const out = summarizeFinancials([], [r, r], customer, 14, now);
  assert.equal(out.potential_savings_usd, -3);
  assert.equal(out.evaluation_count, 1);
});
test("date window and customer hash isolate billing evidence", () => {
  const old = { ...receipt("old"), created_at: "2026-08-01T00:00:00Z" };
  const other = { ...receipt("other"), customer_sha256: "other" };
  const out = summarizeFinancials([{ ...event(99), customer_sha256: "other", customer: "Customer" }], [old, other], customer, 7, now);
  assert.equal(out.provider_spend_usd, null);
  assert.equal(out.potential_savings_usd, null);
  assert.equal(out.evaluation_count, 0);
  assert.equal(summarizeFinancials([], [old], customer, 0, now).evaluation_count, 1);
});
