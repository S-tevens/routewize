import test from "node:test";
import assert from "node:assert/strict";
import { validateRates, priceResponse, promptCacheSavings } from "../src/evaluation/cost.js";
import { prepareEvaluation, runEvaluation } from "../src/evaluation/evaluate.js";
import { optimizeContext } from "../src/optimization/context.js";

const rates = { input: 2, output: 8, cached_input: 0.5, cache_write_input: 2.5, source: "test fixture, not live pricing", as_of: "2026-09-10" };
const customer = { default: { provider: "openai", model: "test-model" }, provider_keys: { openai: "test-only-not-a-real-key" }, evaluation: { enabled: true, pricing: { "openai/test-model": rates } } };
function body(overrides = {}) { return { confirm_paid_calls: true, overhead_usd_per_request: 0, cases: [{ messages: [{ role: "user", content: "refund policy?" }], expected_contains: ["30 days"], rw_optimization: { compression: true, selection: true, context: [{ id: "r", text: "30 days\n\n30 days" }] } }], ...overrides }; }
const response = (input = 100, text = "Refunds within 30 days.", finish = "stop") => ({ content: text, raw: { id: "fixture-response", model: "test-model", choices: [{ finish_reason: finish }], usage: { prompt_tokens: input, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } } } });

test("prices cache hits separately from uncached OpenAI input", () => {
  const raw = response().raw;
  raw.usage.prompt_tokens_details.cached_tokens = 80;
  assert.equal(priceResponse("openai", raw, rates).cost_usd, 0.00016);
});
test("Anthropic cached reads are additional to normal input", () => {
  const priced = priceResponse("anthropic", { usage: { input_tokens: 20, cache_read_input_tokens: 80, output_tokens: 10 } }, rates);
  assert.equal(priced.input_tokens, 100);
  assert.equal(priced.cost_usd, 0.00016);
});
test("Anthropic cache writes are priced at the configured write rate, separately from input and cached reads", () => {
  const priced = priceResponse("anthropic", { usage: { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 100 } }, rates);
  assert.equal(priced.cache_write_input_tokens, 100);
  // (10 * 2 + 100 * 2.5 + 2 * 8) / 1e6
  assert.ok(Math.abs(priced.cost_usd - 0.000286) < 1e-9);
});
test("promptCacheSavings reports the read discount for OpenAI, separately from priceResponse's total", () => {
  const raw = response().raw;
  raw.usage.prompt_tokens_details.cached_tokens = 80;
  assert.ok(Math.abs(promptCacheSavings("openai", raw, rates) - 0.00012) < 1e-12);
});
test("promptCacheSavings nets Anthropic's read discount against its write premium", () => {
  const readOnly = promptCacheSavings("anthropic", { usage: { cache_read_input_tokens: 80, cache_creation_input_tokens: 0 } }, rates);
  assert.ok(Math.abs(readOnly - 0.00012) < 1e-12);
  // A cache write is a real, temporary cost -- negative, not clamped to zero.
  const writeOnly = promptCacheSavings("anthropic", { usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 100 } }, rates);
  assert.ok(Math.abs(writeOnly - -0.00005) < 1e-12);
});
test("promptCacheSavings is null (not zero) when the needed rate isn't configured", () => {
  assert.equal(promptCacheSavings("openai", response().raw, { input: 2, output: 8 }), null);
  assert.equal(promptCacheSavings("anthropic", { usage: { cache_read_input_tokens: 5 } }, { input: 2, output: 8, cached_input: 0.5 }), null);
  assert.equal(promptCacheSavings("unsupported-provider", {}, rates), null);
});
test("missing usage and unsupported billable categories never price as zero", () => {
  assert.throws(() => priceResponse("openai", {}, rates));
  assert.throws(() => priceResponse("anthropic", { usage: { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 10 } }, { ...rates, cache_write_input: undefined }), /Cache write rate is not configured/);
  assert.throws(() => priceResponse("openai", { usage: { prompt_tokens: 2, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 3 } } }, rates));
});
test("evaluations require explicit rates, real configuration and paid-call consent", () => {
  assert.throws(() => validateRates({ input: 1, output: 1 }));
  assert.throws(() => validateRates({ input: 1, output: 1, cached_input: 0.5 }, "anthropic"), /cache_write_input/);
  assert.throws(() => prepareEvaluation({ ...customer, evaluation: { enabled: false } }, body()));
  assert.throws(() => prepareEvaluation(customer, body({ confirm_paid_calls: false })));
  assert.throws(() => prepareEvaluation(customer, body({ overhead_usd_per_request: undefined })));
  assert.throws(() => prepareEvaluation({ ...customer, provider_keys: { openai: "sk-REPLACE_ME" } }, body()));
  assert.throws(() => prepareEvaluation(customer, body({ cases: Array(4).fill(body().cases[0]) })));
});
test("baseline retains every reference and optimized arm uses independent settings", () => {
  const plan = prepareEvaluation(customer, body());
  assert.ok(plan.cases[0].arms[0].messages[0].content.includes("30 days\n\n30 days"));
  assert.ok(!plan.cases[0].arms[1].messages[0].content.includes("30 days\n\n30 days"));
});
test("positive observed savings retain paid-test cost and caller overhead", async () => {
  let calls = 0;
  const report = await runEvaluation(prepareEvaluation(customer, body({ overhead_usd_per_request: 0.00001 })), { openai: async (args) => {
    assert.equal(args.maxRetries, 0); assert.equal(args.timeout, 30000);
    return response(calls++ === 0 ? 100 : 20);
  } });
  assert.equal(calls, 2);
  assert.equal(report.summary.verdict, "savings_observed_on_this_sample");
  assert.ok(Math.abs(report.summary.net_savings_per_replayed_batch_usd - 0.00015) < 1e-10);
  assert.ok(Math.abs(report.summary.total_evaluation_cost_usd - 0.00041) < 1e-10);
  assert.equal(report.invoice_verified, false);
});
test("cost increases are negative, not clamped to savings", async () => {
  const report = await runEvaluation(prepareEvaluation(customer, body({ overhead_usd_per_request: 1 })), { openai: async () => response() });
  assert.equal(report.summary.net_savings_per_replayed_batch_usd, -1);
  assert.equal(report.summary.verdict, "no_net_savings");
});
test("failed phrase checks or truncated answers block a success verdict", async () => {
  for (const candidate of [response(20, "No refunds"), response(20, "30 days", "length")]) {
    let calls = 0;
    const report = await runEvaluation(prepareEvaluation(customer, body()), { openai: async () => calls++ ? candidate : response() });
    assert.equal(report.summary.verdict, "quality_checks_failed");
    assert.ok(report.summary.net_savings_per_replayed_batch_usd > 0);
  }
});
test("partial provider failure retains known spend and marks totals unknown", async () => {
  let calls = 0;
  const report = await runEvaluation(prepareEvaluation(customer, body()), { openai: async () => { if (calls++) throw new Error("SECRET provider payload"); return response(); } });
  assert.equal(report.summary.verdict, "inconclusive");
  assert.equal(report.summary.total_evaluation_cost_usd, null);
  assert.equal(report.summary.net_savings_per_replayed_batch_usd, null);
  assert.ok(report.summary.known_provider_spend_usd > 0);
  assert.ok(!JSON.stringify(report).includes("SECRET"));
});
test("routing preflights pricing for both arms before any provider call", () => {
  const routing = { rules: [{ name: "r", match: {}, route_to: { provider: "anthropic", model: "other" } }] };
  assert.throws(() => prepareEvaluation({ ...customer, routing }, body({ use_routing: true })));
});
test("protected documents remain byte-identical even over the token budget", () => {
  const text = "  Must keep.\n\nMust keep.  ";
  const result = optimizeContext([{ role: "user", content: "question" }], { compression: true, selection: true, max_context_tokens: 1, context: [{ id: "legal", text, protected: true }, { id: "other", text: "discard me" }] });
  assert.ok(result.messages[0].content.endsWith(text));
  assert.deepEqual(result.metrics.selected_context_ids, ["legal"]);
  assert.equal(result.metrics.context_budget_exceeded, true);
});
