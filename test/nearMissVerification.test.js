import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createHash } from "node:crypto";
import { SemanticCache } from "../src/cache/semanticCache.js";
import { scheduleNearMissVerification, DEFAULT_NEAR_MISS_MARGIN } from "../src/cache/nearMissVerification.js";
import { UsageGuard } from "../src/middleware/usageGuard.js";

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function fixture({ similarity = 0.88, config = { enabled: true }, verdict = "YES", raw, providerError = false, gate } = {}) {
  const cache = new SemanticCache();
  const usageGuard = new UsageGuard();
  const res = new EventEmitter();
  const logged = deferred();
  const started = deferred();
  const calls = [];
  const customer = {
    api_key: "test-customer", name: "Test Customer", provider_keys: { openai: "test-key", anthropic: "other-test-key" },
    cache: { enabled: true, similarity_threshold: 0.92, near_miss_verification: config },
    evaluation: { pricing: { "openai/gpt-4o-mini": { input: 1, output: 2, cached_input: 0.5, source: "fixture", as_of: "2026-09-22" } } },
  };
  const response = { content: "cached answer", usage: { prompt_tokens: 5, completion_tokens: 3 } };
  const source = cache.store("namespace", { embedding: [1, 0], promptText: "cached prompt", response, model: "gpt-4o", ttlSeconds: 3600 });
  const embedding = [similarity, Math.sqrt(1 - similarity ** 2)];
  const cacheResult = cache.find("namespace", embedding, { similarityThreshold: 0.92, includeNearMiss: true });
  const currentEntry = cache.store("namespace", { embedding, promptText: "current prompt", response: { ...response, content: "fresh answer" }, model: "gpt-4o", ttlSeconds: 3600 });
  const options = { customer, cache, cacheNamespace: "namespace", cacheResult, currentEntry, usageGuard };
  const dependencies = {
    callProvider: async (provider, args) => {
      calls.push({ provider, ...args }); started.resolve();
      if (gate) await gate.promise;
      if (providerError) throw new Error("fixture failure");
      return { content: verdict, usage: { prompt_tokens: 100, completion_tokens: 1 }, raw: raw ?? {
        choices: [{ finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 20 } },
      } };
    },
    logEvent: event => logged.resolve(event),
  };
  return { options, dependencies, cache, source, currentEntry, customer, usageGuard, res, calls, started, logged,
    schedule: () => scheduleNearMissVerification(res, options, dependencies),
    hit: () => cache.find("namespace", embedding, { similarityThreshold: 0.92 }),
  };
}

test("within-margin miss starts one judge only after response finish and a later event-loop turn", async () => {
  const gate = deferred();
  const f = fixture({ gate });
  assert.equal(DEFAULT_NEAR_MISS_MARGIN, 0.05);
  assert.equal(f.schedule(), true);
  await nextTurn();
  assert.equal(f.calls.length, 0, "no judge before the entire response finishes");
  f.res.emit("finish");
  assert.equal(f.calls.length, 0, "finish handlers must not synchronously start judge work");
  await f.started.promise;
  assert.equal(f.hit().entry.response.content, "fresh answer", "pending judge cannot change the completed request");
  gate.resolve();
  const event = await f.logged.promise;
  assert.equal(event.cache_verification.outcome, "promoted");
  assert.equal(f.hit().entry.response, f.source.response);
  assert.equal(f.currentEntry.response.content, "fresh answer");
  const args = f.calls[0];
  assert.equal(args.provider, "openai");
  assert.equal(args.model, "gpt-4o-mini");
  assert.equal(args.temperature, 0);
  assert.equal(args.max_tokens, 4);
  assert.equal(args.maxRetries, 0);
  assert.equal(args.timeout, 10000);
  assert.deepEqual(JSON.parse(args.messages[1].content), { cached_prompt: "cached prompt", cached_response: "cached answer", current_prompt: "current prompt" });
  assert.match(args.messages[0].content, /untrusted data/);
  assert.match(args.messages[0].content, /exactly YES or NO/);
});

test("outside-margin misses, hits, and empty caches never trigger a judge", async () => {
  for (const similarity of [0.869, 0, 0.93, 1]) {
    const f = fixture({ similarity });
    assert.equal(f.schedule(), false);
    f.res.emit("finish");
    await nextTurn();
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  f.options.cacheResult = { hit: false, similarity: -1 };
  assert.equal(f.schedule(), false);
});

test("a response closed before finish never launches a paid judge", async () => {
  const f = fixture();
  assert.equal(f.schedule(), true);
  f.res.emit("close");
  await nextTurn();
  assert.equal(f.calls.length, 0);
  assert.equal(f.hit().entry.response.content, "fresh answer");
});

test("the lower margin boundary is inclusive and the per-customer margin is honored", async () => {
  for (const [similarity, margin, expected] of [[0.87, 0.05, true], [0.88, 0.03, false], [0.85, 0.1, true]]) {
    const f = fixture({ similarity, config: { enabled: true, margin } });
    assert.equal(f.schedule(), expected);
    f.res.emit("finish");
    if (expected) await f.logged.promise;
  }
});

test("verification defaults OFF; absent/false/non-boolean enablement preserves fresh cache answers", async () => {
  for (const config of [null, {}, { enabled: false }, { enabled: "true" }, { margin: 0.05 }]) {
    const f = fixture({ config });
    assert.equal(f.schedule(), false);
    f.res.emit("finish");
    await nextTurn();
    assert.equal(f.calls.length, 0);
    assert.equal(f.hit().entry.response.content, "fresh answer");
  }
  const f = fixture();
  delete f.customer.cache.near_miss_verification;
  assert.equal(f.schedule(), false);
  f.customer.cache = { enabled: false, near_miss_verification: { enabled: true } };
  assert.equal(f.schedule(), false);
});

test("invalid margin/model config disables the optional paid work", () => {
  for (const margin of [-1, 0, 2, "0.05", NaN, Infinity]) {
    assert.equal(fixture({ config: { enabled: true, margin } }).schedule(), false);
  }
  for (const judge_model of ["gpt-4o-mini", "unknown/model", 123, "openai/"]) {
    assert.equal(fixture({ config: { enabled: true, judge_model } }).schedule(), false);
  }
});

for (const verdict of ["YES", "NO", "YES, because they match", "", null]) {
  test(`judge verdict ${JSON.stringify(verdict)} is strictly parsed and its spend is always logged`, async () => {
    const f = fixture({ verdict });
    f.schedule(); f.res.emit("finish");
    const event = await f.logged.promise;
    assert.equal(event.financials.source, "cache_verification_judge_call");
    assert.ok(Math.abs(event.financials.provider_spend_usd - 0.000092) < 1e-12);
    assert.equal(event.customer_sha256, createHash("sha256").update(f.customer.api_key).digest("hex"));
    assert.equal(event.customer, f.customer.name);
    assert.equal(event.model_used, "gpt-4o-mini");
    assert.equal(event.cache_hit, false);
    assert.ok(event.estimated_savings < 0, "judge overhead reduces savings");
    assert.equal(event.cost_estimate.baseline_usd, 0);
    assert.ok(event.cost_estimate.actual_usd > 0);
    assert.ok(!f.usageGuard.checkSpendCap(f.customer.api_key, 0.00009).allowed, "judge costs count toward the cap");
    assert.equal(f.hit().entry.response.content, verdict === "YES" ? "cached answer" : "fresh answer");
    assert.equal(event.cache_verification.outcome, verdict === "YES" ? "promoted" : verdict === "NO" ? "not_equivalent" : "invalid_verdict");
    assert.ok(!JSON.stringify(event).includes("cached prompt"));
    assert.ok(!JSON.stringify(event).includes("cached answer"));
  });
}

test("truncated YES is not promoted; successful and failed unpriced calls log unknown, never zero", async () => {
  for (const mode of ["truncated", "missing-pricing", "missing-usage", "provider-error"]) {
    const f = fixture({ providerError: mode === "provider-error" });
    if (mode === "missing-pricing") f.customer.evaluation.pricing = {};
    if (mode === "missing-usage" || mode === "truncated") {
      const call = f.dependencies.callProvider;
      f.dependencies.callProvider = async (...args) => {
        const result = await call(...args);
        if (mode === "missing-usage") delete result.raw.usage;
        else result.raw.choices[0].finish_reason = "length";
        return result;
      };
    }
    f.schedule(); f.res.emit("finish");
    const event = await f.logged.promise;
    if (mode !== "truncated") assert.equal(event.financials.provider_spend_usd, null);
    assert.equal(event.financials.source, "cache_verification_judge_call");
    if (["truncated", "provider-error"].includes(mode)) assert.equal(f.hit().entry.response.content, "fresh answer");
  }
});

test("a configured Anthropic judge uses its own provider key, model and native usage pricing", async () => {
  const f = fixture({ config: { enabled: true, judge_model: "anthropic/claude-haiku-4-5-20251001" }, raw: {
    stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 20, cache_creation_input_tokens: 10 },
  } });
  f.customer.evaluation.pricing["anthropic/claude-haiku-4-5-20251001"] = { input: 1, output: 2, cached_input: 0.5, cache_write_input: 1.25, source: "fixture", as_of: "2026-09-22" };
  f.schedule(); f.res.emit("finish");
  const event = await f.logged.promise;
  assert.equal(f.calls[0].provider, "anthropic");
  assert.equal(f.calls[0].apiKey, "other-test-key");
  assert.equal(f.calls[0].model, "claude-haiku-4-5-20251001");
  assert.ok(Math.abs(event.financials.provider_spend_usd - 0.0001245) < 1e-12);
  assert.equal(event.cache_verification.outcome, "promoted");
});

test("missing keys, an exhausted cap, or expiry before dispatch skip paid verification", async () => {
  for (const mode of ["missing-key", "cap", "expired"]) {
    const f = fixture();
    f.schedule();
    if (mode === "missing-key") delete f.customer.provider_keys.openai;
    if (mode === "cap") f.customer.rate_limit = { max_daily_spend_usd: 0 };
    if (mode === "expired") f.source.storedAt -= 3601_000;
    f.res.emit("finish");
    await nextTurn();
    assert.equal(f.calls.length, 0);
  }
});

test("a slow YES cannot revive a source that expired while the judge was running, but its spend is logged", async () => {
  const gate = deferred();
  const f = fixture({ gate });
  f.schedule(); f.res.emit("finish");
  await f.started.promise;
  f.source.storedAt -= 3601_000;
  gate.resolve();
  const event = await f.logged.promise;
  assert.equal(event.cache_verification.outcome, "stale");
  assert.ok(event.financials.provider_spend_usd > 0);
  assert.equal(f.hit().entry.response.content, "fresh answer");
});

test("only one judge runs per customer while other customers can verify independently", async () => {
  const gate = deferred();
  const first = fixture({ gate });
  first.schedule(); first.res.emit("finish");
  await first.started.promise;
  const second = fixture();
  second.schedule(); second.res.emit("finish");
  await nextTurn();
  assert.equal(second.calls.length, 0);
  const other = fixture();
  other.customer.api_key = "another-customer";
  other.schedule(); other.res.emit("finish");
  await other.logged.promise;
  gate.resolve();
  await first.logged.promise;
});
