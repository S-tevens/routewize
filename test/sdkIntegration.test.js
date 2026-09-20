import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import OpenAI from "openai";
import { createApp } from "../src/server.js";

function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routewise-sdk-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [], events = [];
  const customer = {
    name: "SDK test", api_key: "test-routewise-key", provider_keys: { openai: "test-provider-key", anthropic: "test-anthropic-key" },
    default: { provider: "openai", model: "gpt-4o" },
    models: [{ provider: "anthropic", model: "claude-fixture" }],
    cache: { enabled: true },
    routing: { rules: [{ name: "classification", match: { keywords: ["classify"] }, route_to: { provider: "openai", model: "gpt-4o-mini" } }] },
  };
  const configPath = path.join(dir, "customers.json");
  fs.writeFileSync(configPath, JSON.stringify({ customers: [customer, { ...customer, api_key: "second-tenant", models: [], routing: {} }] }));
  const provider = (name) => async (args) => {
    calls.push({ provider: name, ...args });
    return { content: "Positive", finish_reason: "length", usage: { prompt_tokens: 20, completion_tokens: 4 }, raw: {} };
  };
  const app = createApp({ configPath, providers: { openai: provider("openai"), anthropic: provider("anthropic") }, logEvent: (event) => events.push(event) });
  // Use the real SDK's transport, JSON decoding, and error handling, while
  // dispatching through actual route/auth handlers without a network listener.
  const fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const layer = app._router.stack.find((entry) => entry.route?.path === url.pathname && entry.route.methods[request.method.toLowerCase()]);
    if (!layer) return Response.json({ error: { message: "Unknown route" } }, { status: 404 });
    const req = { body: request.method === "POST" ? await request.json() : undefined, get: (name) => request.headers.get(name) };
    let status = 200, data;
    const res = { status(value) { status = value; return this; }, json(value) { data = value; return this; } };
    for (const handler of layer.route.stack) {
      let next = false;
      await handler.handle(req, res, () => { next = true; });
      if (!next) break;
    }
    return Response.json(data, { status });
  };
  const client = (apiKey = customer.api_key) => new OpenAI({ apiKey, baseURL: "http://routewise.test/v1", maxRetries: 0, fetch });
  return { client: client(), forKey: client, calls, events };
}
const messages = [{ role: "user", content: "Classify: I love this product!" }];

test("standard SDK request honors explicit model despite a matching cheaper rule", async (t) => {
  const h = harness(t);
  const answer = await h.client.chat.completions.create({ model: "openai/gpt-4o", messages, max_tokens: 200, temperature: 0.2 });
  assert.equal(answer.choices[0].message.content, "Positive");
  assert.equal(answer.choices[0].finish_reason, "length");
  assert.equal(answer.model, "gpt-4o");
  assert.equal(answer.usage.total_tokens, 24);
  assert.equal(answer.rw_meta.estimated_savings_usd, 0);
  assert.equal(h.calls[0].model, "gpt-4o");
  assert.equal(h.calls[0].max_tokens, 200);
  assert.deepEqual(h.calls[0].messages, messages);
  assert.equal(h.events[0].matched_rule, "explicit-model");
  const cheaper = await h.client.chat.completions.create({ model: "gpt-4o-mini", messages });
  assert.equal(cheaper.rw_meta.estimated_savings_usd, 0, "user-selected cheaper models are not credited as routing savings");
});

test("SDK auto routing and exact cache avoid a repeat provider call", async (t) => {
  const h = harness(t);
  const body = { model: "routewise/auto", messages };
  const first = await h.client.chat.completions.create(body);
  const repeat = await h.client.chat.completions.create(body);
  assert.equal(first.model, "gpt-4o-mini");
  assert.equal(first.rw_meta.cache_hit, false);
  assert.equal(repeat.rw_meta.cache_hit, true);
  assert.equal(repeat.choices[0].finish_reason, "length");
  assert.equal(h.calls.length, 1);
  assert.equal(h.events[1].financials.provider_spend_usd, 0);
  await h.forKey("second-tenant").chat.completions.create({ model: "openai/gpt-4o", messages });
  assert.equal(h.calls.length, 2);
});

test("SDK lists only that customer's configured models without leaking credentials", async (t) => {
  const h = harness(t);
  const list = await h.client.models.list();
  assert.deepEqual(list.data.map((model) => model.id), ["routewise/auto", "openai/gpt-4o", "anthropic/claude-fixture", "openai/gpt-4o-mini"]);
  const other = await h.forKey("second-tenant").models.list();
  assert.deepEqual(other.data.map((model) => model.id), ["routewise/auto", "openai/gpt-4o"]);
  assert.ok(!JSON.stringify(list.data).includes("test-provider-key"));
  assert.equal(h.calls.length, 0);
});

test("SDK exposes auth, model and unsupported-option errors before any provider call", async (t) => {
  const h = harness(t);
  await assert.rejects(h.forKey("wrong-key").models.list(), (error) => error.status === 401);
  await assert.rejects(h.forKey("wrong-key").chat.completions.create({ model: "routewise/auto", messages }), (error) => error.status === 401);
  await assert.rejects(h.client.chat.completions.create({ model: "openai/unconfigured", messages }), (error) => error.status === 404 && error.code === "model_not_found");
  for (const extra of [{ model: null }, { stream: true }, { tools: [] }, { response_format: { type: "json_object" } }, { n: 2 }, { temperature: -1 }, { max_tokens: 0 }, { top_p: 0.1 }]) {
    await assert.rejects(h.client.chat.completions.create({ model: "routewise/auto", messages, ...extra }), (error) => error.status === 400);
  }
  assert.equal(h.calls.length, 0);
});

test("bare model IDs and optional compression work through the same SDK endpoint", async (t) => {
  const h = harness(t);
  const answer = await h.client.chat.completions.create({ model: "claude-fixture", messages, rw_optimization: { compression: true, context: [{ id: "policy", text: "Refunds within 30 days.\n\nRefunds within 30 days." }] } });
  assert.equal(h.calls[0].provider, "anthropic");
  assert.equal(h.calls[0].model, "claude-fixture");
  assert.ok(answer.rw_meta.optimization.estimated_tokens_removed > 0);
  assert.equal(h.calls[0].messages.at(-1).content, messages[0].content);
});

test("omitted model preserves legacy auto routing; flagship override bypasses cache", async (t) => {
  const h = harness(t);
  const answer = await h.client.chat.completions.create({ messages });
  assert.equal(answer.model, "gpt-4o-mini");
  const body = { model: "routewise/auto", messages, force_flagship: true };
  await h.client.chat.completions.create(body);
  await h.client.chat.completions.create(body);
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[2].model, "gpt-4o");
});
