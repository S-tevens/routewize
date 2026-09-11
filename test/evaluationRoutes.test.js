import test from "node:test";
import assert from "node:assert/strict";
import { evaluationRouter } from "../src/evaluation/routes.js";

// Exercise router handlers without opening a network listener.
function harness() {
  let calls = 0;
  const receipts = [];
  const rates = { input: 2, output: 8, cached_input: 0.5, source: "test", as_of: "2026-09-10" };
  const customer = { api_key: "tenant-a", default: { provider: "openai", model: "fixture" }, provider_keys: { openai: "fixture-key" }, evaluation: { enabled: true, pricing: { "openai/fixture": rates } } };
  const router = evaluationRouter({ providers: { openai: async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { content: "PRIVATE answer 30 days", raw: { id: `receipt-${calls}`, choices: [{ finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } } };
  } }, saveReceipt: async (receipt) => { receipts.push(receipt); } });
  const post = router.stack.find((l) => l.route?.methods.post).route.stack[0].handle;
  const get = router.stack.find((l) => l.route?.methods.get).route.stack[0].handle;
  const payload = { confirm_paid_calls: true, overhead_usd_per_request: 0, cases: [{ messages: [{ role: "user", content: "PRIVATE prompt" }], expected_contains: ["30 days"] }] };
  const request = async (body = payload, id = "same-idempotency-key", tenant = customer) => {
    let status = 200, data;
    const res = { status(code) { status = code; return this; }, json(value) { data = value; return this; } };
    await post({ customer: tenant, body, get: () => id }, res);
    return { status, data };
  };
  return { request, customer, payload, receipts, count: () => calls, get };
}

test("concurrent duplicate evaluation requests call providers once and share receipt", async () => {
  const h = harness();
  const [a, b] = await Promise.all([h.request(), h.request()]);
  assert.equal(a.status, 200); assert.equal(a.data.id, b.data.id);
  assert.equal(h.count(), 2); assert.equal(h.receipts.length, 1);
  await h.request(); assert.equal(h.count(), 2);
  const stored = JSON.stringify(h.receipts);
  assert.ok(!stored.includes("PRIVATE")); assert.ok(!stored.includes("fixture-key"));
  assert.ok(!stored.includes('"phrase"')); assert.ok(stored.includes("provider_response_id"));
});
test("idempotency conflicts block extra charges; tenant keys isolate runs", async () => {
  const h = harness(); await h.request();
  const conflict = await h.request({ ...h.payload, max_tokens: 100 });
  assert.equal(conflict.status, 409); assert.equal(h.count(), 2);
  await h.request(h.payload, "same-idempotency-key", { ...h.customer, api_key: "tenant-b" });
  assert.equal(h.count(), 4);
});
test("one paid evaluation per customer runs at a time", async () => {
  const h = harness(); const first = h.request();
  const busy = await h.request(h.payload, "another-valid-request-id");
  assert.equal(busy.status, 429); await first; assert.equal(h.count(), 2);
});
test("missing idempotency or disabled configuration fails before provider invocation", async () => {
  const h = harness();
  assert.equal((await h.request(h.payload, "short")).status, 400);
  assert.equal((await h.request(h.payload, "valid-request-id-123", { ...h.customer, evaluation: {} })).status, 400);
  assert.equal(h.count(), 0);
});
