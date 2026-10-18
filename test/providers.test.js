import test from "node:test";
import assert from "node:assert/strict";
import { COMPATIBLE_PROVIDERS, assertProviderRoute, providerStatus, ignoredActivations } from "../src/providers/catalog.js";
import { callCompatible, streamCompatible, normalizeUsage } from "../src/providers/compatible.js";
import { validateProviderConfig } from "../src/providers/config.js";
import { estimateRouteCost } from "../src/logging/routeCost.js";
import { priceResponse } from "../src/evaluation/cost.js";
import { prepareEvaluation, runEvaluation } from "../src/evaluation/evaluate.js";

const rates = { input: 2, output: 4, cached_input: 1, source: "offline fixture", as_of: "2026-09-28" };
const usage = { prompt_tokens: 10, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 }, cost: 0.00005 };
const completion = { id: "fixture", model: "org/model", choices: [{ message: { content: "hello" }, finish_reason: "stop" }], usage };
const args = { apiKey: "tenant-key", model: "org/model", messages: [{ role: "user", content: "hello" }], max_tokens: 12, temperature: 0, maxRetries: 0 };
const json = body => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

for (const [provider, profile] of Object.entries(COMPATIBLE_PROVIDERS)) {
  test(`${provider}: SDK endpoint, key, payload, streaming usage and evaluation contract`, async () => {
    const received = [];
    const fetchImpl = async (url, options) => {
      const body = JSON.parse(options.body);
      received.push({ url: String(url), options, body });
      if (!body.stream) return json(completion);
      const frame = (choices, extra = {}) => ({ id: "s", model: args.model, object: "chat.completion.chunk", created: 1, choices, ...extra });
      const frames = [frame([{ index: 0, delta: { content: "hel" }, finish_reason: null }], { usage }),
        frame([{ index: 0, delta: { content: "lo" }, finish_reason: "stop" }],
          provider === "groq" ? { x_groq: { usage } } : { usage })];
      return new Response(frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
    };
    const result = await callCompatible(provider, args, { fetchImpl });
    assert.equal(result.content, "hello");
    const sink = {}, chunks = [];
    for await (const c of streamCompatible(provider, args, sink, { fetchImpl })) chunks.push(c);
    assert.equal(chunks.filter(c => c.usage).length, 1);
    assert.equal(chunks.at(-1).usage.prompt_tokens, 10);
    assert.equal(sink.raw.usage.completion_tokens, 3);
    assert.equal(chunks.flatMap(c => c.choices).map(c => c.delta.content ?? "").join(""), "hello");
    for (const request of received) {
      assert.equal(request.url, `${profile.baseURL}/chat/completions`);
      assert.equal(new Headers(request.options.headers).get("authorization"), "Bearer tenant-key");
      assert.equal(request.options.redirect, "error");
      assert.equal(request.body.model, "org/model");
      assert.equal(request.body.max_tokens, 12);
    }
    assert.deepEqual(received[1].body.stream_options, profile.streamUsage ? { include_usage: true } : undefined);
    assert.equal(priceResponse(provider, result.raw, rates).cost_usd, provider === "openrouter" ? 0.00005 : 0.000028);
    const customer = { default: { provider, model: "org/model" }, provider_keys: { [provider]: "key" }, evaluation: { enabled: true, pricing: { [`${provider}/org/model`]: rates } } };
    const plan = prepareEvaluation(customer, { confirm_paid_calls: true, overhead_usd_per_request: 0, cases: [{ messages: args.messages, expected_contains: ["hello"] }] });
    const report = await runEvaluation(plan, { [provider]: async () => result });
    assert.equal(report.summary.checks_passed, true);
    assert.equal(report.summary.completed_pairs, 1);
  });
}

test("new-provider routes require their own credentials and qualified pricing", () => {
  const activated = { ROUTEWIZE_ACTIVATE_PROVIDERS: "groq" };
  const customer = { default: { provider: "groq", model: "same-model" }, provider_keys: { groq: "key" }, evaluation: { pricing: { "groq/same-model": rates } } };
  validateProviderConfig(customer, activated);
  assert.equal(estimateRouteCost(customer, customer.default, 10, 3), 0.000032);
  assert.throws(() => estimateRouteCost(customer, { provider: "together", model: "same-model" }, 10, 3));
  delete customer.provider_keys.groq; assert.throws(() => validateProviderConfig(customer, activated), /provider_keys\.groq/);
  assert.throws(() => assertProviderRoute({ provider: "typo", model: "gpt-4o" }));
  assert.throws(() => assertProviderRoute({ provider: "constructor", model: "x" }));
});

test("standby providers cannot be routed to until explicitly activated", () => {
  const customer = { default: { provider: "deepseek", model: "deepseek-chat" }, provider_keys: { deepseek: "key" },
    evaluation: { pricing: { "deepseek/deepseek-chat": rates } } };
  assert.throws(() => validateProviderConfig(customer, {}), /standby.*add "deepseek" to ROUTEWIZE_ACTIVATE_PROVIDERS/);
  assert.throws(() => validateProviderConfig(customer, { ROUTEWIZE_ACTIVATE_PROVIDERS: "groq" }), /standby/);
  assert.doesNotThrow(() => validateProviderConfig(customer, { ROUTEWIZE_ACTIVATE_PROVIDERS: " groq , deepseek " }));
  assert.doesNotThrow(() => validateProviderConfig(customer, { ROUTEWIZE_ACTIVATE_PROVIDERS: "DeepSeek" }));
  // a typo activates nothing, and startup can name it
  assert.throws(() => validateProviderConfig(customer, { ROUTEWIZE_ACTIVATE_PROVIDERS: "deepsek" }), /standby/);
  assert.deepEqual(ignoredActivations({ ROUTEWIZE_ACTIVATE_PROVIDERS: "deepsek, Groq, openai" }), ["deepsek", "openai"]);
  assert.deepEqual(ignoredActivations({}), []);
  // a standby route hidden in a rule is rejected even when the default is live
  const ruleOnly = { default: { provider: "openai", model: "gpt-4o" }, provider_keys: { deepseek: "key" },
    evaluation: { pricing: { "deepseek/deepseek-chat": rates } },
    routing: { rules: [{ name: "cheap", match: {}, route_to: { provider: "deepseek", model: "deepseek-chat" } }] } };
  assert.throws(() => validateProviderConfig(ruleOnly, {}), /standby/);
  // live providers never need activation
  assert.doesNotThrow(() => validateProviderConfig({ default: { provider: "openai", model: "gpt-4o" } }, {}));
  assert.equal(providerStatus("anthropic", {}), "live");
  assert.equal(providerStatus("gemini", {}), "standby");
  assert.equal(providerStatus("gemini", { ROUTEWIZE_ACTIVATE_PROVIDERS: "gemini" }), "activated");
  assert.equal(providerStatus("madeup", { ROUTEWIZE_ACTIVATE_PROVIDERS: "madeup" }), "unsupported");
});

test("DeepSeek cached tokens normalize without double counting", () => {
  const normalized = normalizeUsage("deepseek", { usage: { prompt_tokens: 10, completion_tokens: 3, prompt_cache_hit_tokens: 4, prompt_cache_miss_tokens: 6 } });
  assert.equal(priceResponse("deepseek", { usage: normalized }, rates).cost_usd, 0.000028);
  assert.throws(() => normalizeUsage("deepseek", { usage: { ...normalized, prompt_cache_miss_tokens: 10 } }));
});

test("missing usage, malformed answers and unsupported billing do not become zero spend", async () => {
  await assert.rejects(callCompatible("gemini", args, { fetchImpl: async () => json({ ...completion, usage: null }) }));
  await assert.rejects(callCompatible("gemini", args, { fetchImpl: async () => json({ ...completion, choices: [{ message: { content: "no reason" } }] }) }));
  assert.equal(priceResponse("openrouter", { usage: { ...usage, prompt_tokens_details: { cache_write_tokens: 2 } } }, rates).cost_usd, usage.cost);
  assert.throws(() => priceResponse("openrouter", { usage: { prompt_tokens: 10, completion_tokens: 2 } }, rates));
  assert.throws(() => priceResponse("gemini", { usage: { ...usage, prompt_tokens_details: { audio_tokens: 3 } } }, rates));
  assert.throws(() => priceResponse("mistral", { usage: { ...usage, prompt_tokens_details: { cache_write_tokens: 3 } } }, rates));
});

test("compatible stream without final usage or any finish reason fails", async () => {
  for (const chunk of [
    { choices: [{ delta: { content: "hello" }, finish_reason: "stop" }] },
    { choices: [{ delta: { content: "cut off" }, finish_reason: null }], usage },
  ]) {
    const fetchImpl = async () => new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    await assert.rejects(async () => { for await (const c of streamCompatible("gemini", args, {}, { fetchImpl })) void c; });
  }
});

// max_tokens truncation is a normal, already-billed OpenAI-compatible answer: it must reach
// the client with its real finish_reason (not a 502), flagged incomplete so it is never cached.
test("length-truncated answers are returned with their finish reason and marked incomplete", async () => {
  const truncated = { ...completion, choices: [{ message: { content: "partial" }, finish_reason: "length" }] };
  const result = await callCompatible("gemini", args, { fetchImpl: async () => json(truncated) });
  assert.equal(result.content, "partial");
  assert.equal(result.finishReason, "length");
  assert.equal(result.complete, false);
  assert.equal(priceResponse("gemini", result.raw, rates).cost_usd, 0.000028);

  const full = await callCompatible("gemini", args, { fetchImpl: async () => json(completion) });
  assert.equal(full.complete, true);

  const chunk = { choices: [{ index: 0, delta: { content: "partial" }, finish_reason: "length" }], usage };
  const fetchImpl = async () => new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  const sink = {}, chunks = [];
  for await (const c of streamCompatible("gemini", args, sink, { fetchImpl })) chunks.push(c);
  assert.equal(chunks.flatMap(c => c.choices).find(c => c.finish_reason)?.finish_reason, "length");
  assert.equal(chunks.filter(c => c.usage).length, 1);
  assert.equal(sink.finishReason, "length");
  assert.equal(sink.complete, false);
});
