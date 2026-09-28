import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createJevShadow, parseJevChoice, validateJevConfig, callJev } from "../src/router/jevShadow.js";
import { UsageGuard } from "../src/middleware/usageGuard.js";

const criteria = { small: "Simple extraction", standard: "Summarization", frontier: "Complex reasoning or uncertainty" };
const reply = () => ({ answers: { tier: { type: "choice", choice: "small", confidence: 0.8, probabilities: { small: 0.9, standard: 0.08, frontier: 0.02 } } }, usage: { cost: 0.0001 } });
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(overrides = {}) {
  const events = [], calls = [];
  const options = { customer: { api_key: "tenant-a", name: "A", provider_keys: { openrouter: "secret" }, routing: { jev_shadow: { enabled: true, criteria } } }, messages: [{ role: "user", content: "private task" }], route: { provider: "openai", model: "gpt-4o", matchedRule: "default-fallback" }, usageGuard: new UsageGuard() };
  const schedule = createJevShadow({ callProvider: async args => { calls.push(args); return reply(); }, logEvent: event => events.push(event), ...overrides });
  const run = async (opts = options) => { const res = new EventEmitter(); const scheduled = schedule(res, opts); res.emit("finish"); await tick(); return scheduled; };
  return { options, events, calls, schedule, run };
}

test("Jev starts only after finish, reports probabilities and cost without mutating route", async () => {
  const f = fixture(); const res = new EventEmitter(); const before = structuredClone(f.options.route);
  assert.equal(f.schedule(res, f.options), true);
  await tick(); assert.equal(f.calls.length, 0);
  res.emit("finish"); assert.equal(f.calls.length, 0); await tick();
  assert.deepEqual(f.options.route, before);
  assert.equal(f.events[0].jev_shadow.choice, "small");
  assert.equal(f.events[0].jev_shadow.confidence, 0.8);
  assert.equal(f.events[0].jev_shadow.probabilities.small, 0.9);
  assert.equal(f.events[0].estimated_savings, -0.0001);
  assert.equal(f.options.usageGuard.checkSpendCap("tenant-a", 1).spentToday, 0.0001);
  assert.ok(!JSON.stringify(f.events).includes("private task"));
  assert.ok(!JSON.stringify(f.events).includes("secret"));
});

test("disabled, forced and oversized requests never call Jev; aborted response does not call", async () => {
  const f = fixture();
  assert.equal(await f.run({ ...f.options, forceFlagship: true }), false);
  assert.equal(await f.run({ ...f.options, messages: [{ role: "user", content: "x".repeat(32001) }] }), false);
  const res = new EventEmitter(); f.schedule(res, f.options); res.emit("close"); await tick();
  f.options.customer.routing.jev_shadow.enabled = false; assert.equal(await f.run(), false);
  assert.equal(f.calls.length, 0);
});

test("daily calls and spend cap bound shadow spend", async () => {
  const f = fixture(); f.options.customer.routing.jev_shadow.max_calls_per_day = 1;
  await f.run(); await f.run(); assert.equal(f.calls.length, 1);
  const other = fixture(); other.options.customer.rate_limit = { max_daily_spend_usd: 0 };
  await other.run(); assert.equal(other.calls.length, 0);
});

test("unknown cost suspends this customer's shadow calls until next UTC day", async () => {
  let now = Date.parse("2026-09-28T00:00:00Z");
  const f = fixture({ now: () => now, callProvider: async () => { const r = reply(); delete r.usage; return r; } });
  await f.run(); await f.run(); assert.equal(f.events.length, 1);
  assert.equal(f.events[0].financials.provider_spend_usd, null);
  assert.equal(f.events[0].jev_shadow.cost_unknown, true);
  assert.equal(f.events[0].cost_estimate, undefined);
  now += 86400000; await f.run(); assert.equal(f.events.length, 2);
});

test("errors are redacted and known malformed-answer cost is still charged", async () => {
  const f = fixture({ callProvider: async () => { throw new Error("secret private task"); } });
  await f.run(); assert.equal(f.events[0].jev_shadow.outcome, "error");
  assert.ok(!JSON.stringify(f.events).includes("secret"));
  const g = fixture({ callProvider: async () => ({ answers: {}, usage: { cost: 0.02 } }) });
  await g.run(); assert.equal(g.events[0].financials.provider_spend_usd, 0.02);
  assert.equal(g.events[0].jev_shadow.outcome, "error");
});

test("one in-flight call per tenant, other tenants remain independent", async () => {
  let release; const gate = new Promise(resolve => { release = resolve; }); let calls = 0;
  const f = fixture({ callProvider: async () => { calls++; await gate; return reply(); } });
  await f.run(); await f.run(); assert.equal(calls, 1);
  await f.run({ ...f.options, customer: { ...f.options.customer, api_key: "tenant-b" } }); assert.equal(calls, 2);
  release(); await tick(); assert.equal(f.events.length, 2);
});

test("invalid distributions fail closed", () => {
  for (const mutation of [
    r => { r.answers.tier.choice = "invented"; },
    r => { r.answers.tier.confidence = 2; },
    r => { delete r.answers.tier.probabilities.standard; },
    r => { r.answers.tier.probabilities.small = 0.1; },
    r => { r.answers.tier.probabilities = { small: 0.2, standard: 0.7, frontier: 0.1 }; },
    r => { r.answers.tier.probabilities.small = "0.9"; },
  ]) { const r = reply(); mutation(r); assert.throws(() => parseJevChoice(r)); }
});

test("enabled configuration requires explicit credentials and capability definitions", () => {
  assert.doesNotThrow(() => validateJevConfig({}));
  const f = fixture(); validateJevConfig(f.options.customer);
  delete f.options.customer.provider_keys.openrouter; assert.throws(() => validateJevConfig(f.options.customer));
  f.options.customer.provider_keys.openrouter = "secret";
  f.options.customer.routing.jev_shadow.max_calls_per_day = -1; assert.throws(() => validateJevConfig(f.options.customer));
});

test("adapter sends OpenRouter Decisions API schema, no retries or redirects", async () => {
  let captured;
  const raw = await callJev({ apiKey: "fixture-key", messages: [], criteria }, { fetchImpl: async (url, options) => {
    captured = { url, options }; return { ok: true, json: async () => reply() };
  } });
  assert.equal(raw.usage.cost, 0.0001);
  assert.equal(captured.url, "https://openrouter.ai/api/alpha/decisions");
  assert.equal(captured.options.redirect, "error");
  assert.equal(captured.options.headers.Authorization, "Bearer fixture-key");
  assert.deepEqual(JSON.parse(captured.options.body).questions.tier.criteria, criteria);
  let calls = 0;
  await assert.rejects(callJev({ apiKey: "x", messages: [], criteria }, { fetchImpl: async () => { calls++; return { ok: false }; } }));
  assert.equal(calls, 1);
});
