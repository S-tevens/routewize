import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const sourcePrompt = "What is the return window?";
const nearPrompt = "How long do I have to return my purchase?";
const paraphrase = "How much time do I have to send my purchase back?";
const farPrompt = "What is the weather in Tokyo?";
const cachedAnswer = "You can return your purchase within 30 days.";
const freshAnswer = "The return window is thirty days from purchase.";
const nearAngle = Math.acos(0.88);
const vectors = {
  [sourcePrompt]: [1, 0, 0],
  [nearPrompt]: [0.88, Math.sqrt(1 - 0.88 ** 2), 0],
  [paraphrase]: [Math.cos(nearAngle + 0.01), Math.sin(nearAngle + 0.01), 0],
  [farPrompt]: [0, 0, 1],
};
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
const rates = { input: 1, output: 2, cached_input: 0.5, cache_write_input: 1.25, source: "offline fixture", as_of: "2026-09-22" };

async function fixture(t, { provider = "openai", config = { enabled: true }, verdict = "YES", judgeError = false, foregroundError = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routewize-near-miss-"));
  const judgeGate = deferred();
  const judgeStarted = deferred();
  const streamGate = deferred();
  const requests = [];
  let judgeCompleted = false;
  let child;
  const model = provider === "openai" ? "gpt-4o" : "claude-sonnet-4-6";
  const judgeModel = provider === "openai" ? "gpt-4o-mini" : "claude-haiku-4-5-20251001";
  const usage = provider === "openai" ? { prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 20 } }
    : { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 20, cache_creation_input_tokens: 10 };
  const json = (res, value, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
  const sse = (res, value, type) => res.write(`${type ? `event: ${type}\n` : ""}data: ${JSON.stringify(value)}\n\n`);
  const chunk = (content, extra = {}) => ({ id: "fixture", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { content }, finish_reason: null }], ...extra });
  const upstream = http.createServer(async (req, res) => {
    try {
      let text = "";
      for await (const part of req) text += part;
      const body = JSON.parse(text);
      if (req.url === "/v1/embeddings") {
        const embedding = vectors[body.input];
        assert.ok(embedding, `unexpected fixture embedding input: ${body.input}`);
        // The real SDK requests base64 by default and decodes float32 data.
        const encoded = body.encoding_format === "base64" ? Buffer.from(new Float32Array(embedding).buffer).toString("base64") : embedding;
        return json(res, { data: [{ embedding: encoded, index: 0 }], model: body.model, usage: { prompt_tokens: 10, total_tokens: 10 } });
      }
      requests.push({ body, url: req.url, authorization: req.headers.authorization, anthropicKey: req.headers["x-api-key"] });
      const judge = body.model === judgeModel;
      if (judge) {
        judgeStarted.resolve();
        await judgeGate.promise;
        judgeCompleted = true;
        if (judgeError) return json(res, { error: { type: "authentication_error", message: "fixture judge failure" } }, 401);
      }
      const prompt = body.messages.at(-1).content;
      const content = judge ? verdict : prompt === sourcePrompt ? cachedAnswer : freshAnswer;
      if (foregroundError && prompt === nearPrompt && !body.stream) {
        return json(res, { error: { type: "authentication_error", message: "fixture foreground failure" } }, 401);
      }
      if (!body.stream) {
        return json(res, provider === "openai"
          ? { id: "fixture", object: "chat.completion", model: body.model, choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage }
          : { id: "fixture", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: content }], stop_reason: "end_turn", usage });
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (provider === "openai") sse(res, chunk(content));
      else {
        sse(res, { type: "message_start", message: { id: "fixture", model, usage: { ...usage, output_tokens: 0 } } }, "message_start");
        sse(res, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: content } }, "content_block_delta");
      }
      await streamGate.promise;
      if (foregroundError) {
        sse(res, { type: "error", error: { type: "api_error", message: "fixture foreground failure" } }, provider === "anthropic" ? "error" : undefined);
      } else if (provider === "openai") {
        sse(res, chunk("", { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
        sse(res, chunk("", { choices: [], usage }));
      } else {
        sse(res, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }, "message_delta");
        sse(res, { type: "message_stop" }, "message_stop");
      }
      if (provider === "openai") res.write("data: [DONE]\n\n");
      res.end();
    } catch (error) { res.destroy(error); }
  });
  t.after(async () => {
    judgeGate.resolve(); streamGate.resolve();
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close"); child.kill(); await closed;
    }
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  fs.cpSync(path.join(root, "src"), path.join(dir, "src"), { recursive: true, filter: source => !source.endsWith("customers.yaml") });
  fs.symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"), "junction");
  fs.writeFileSync(path.join(dir, "package.json"), '{"type":"module"}');
  const customer = {
    api_key: "offline-test", name: "Offline Tenant", provider_keys: { openai: "fake-openai", anthropic: "fake-anthropic" },
    default: { provider, model }, cache: { enabled: true, similarity_threshold: 0.92 }, rate_limit: { requests_per_minute: 0 },
    evaluation: { pricing: { [`${provider}/${model}`]: rates, [`${provider}/${judgeModel}`]: rates } },
  };
  if (config !== null) customer.cache.near_miss_verification = { judge_model: `${provider}/${judgeModel}`, ...config };
  fs.writeFileSync(path.join(dir, "customers.json"), JSON.stringify({ customers: [customer, { ...customer, api_key: "other-tenant", name: "Other Tenant" }] }));
  child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { Server } from 'node:net';
    const listen = Server.prototype.listen;
    Server.prototype.listen = function(...args) {
      this.once('listening', () => process.send({ port: this.address().port }));
      return listen.apply(this, args);
    };
    await import('./src/server.js');
  `], { cwd: dir, env: {
    PATH: process.env.PATH, PORT: "0", CUSTOMERS_CONFIG: path.join(dir, "customers.json"),
    DOTENV_CONFIG_PATH: path.join(dir, "absent.env"), PRICING_SOURCE: "static", EMBEDDING_PROVIDER: "openai",
    OPENAI_BASE_URL: `${base}/v1`, ANTHROPIC_BASE_URL: base,
  }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let diagnostics = "";
  child.stdout.on("data", data => { diagnostics += data; });
  child.stderr.on("data", data => { diagnostics += data; });
  const address = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Proxy startup timed out: ${diagnostics}`)), 10000);
    child.once("message", value => { clearTimeout(timer); resolve(value); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error(diagnostics)); });
  });
  const url = `http://127.0.0.1:${address.port}`;
  return {
    dir, customer, model, judgeModel, requests, judgeStarted,
    releaseJudge: judgeGate.resolve, releaseStream: streamGate.resolve,
    judgeCompleted: () => judgeCompleted,
    judges: () => requests.filter(r => r.body.model === judgeModel),
    call: (prompt, options = {}, key = "offline-test") => fetch(`${url}/v1/chat/completions`, {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: prompt }], ...options }), signal: AbortSignal.timeout(10000),
    }),
    overview: () => fetch(`${url}/api/financial-overview`, { headers: { Authorization: "Bearer offline-test" } }).then(r => r.json()),
  };
}

async function logs(f, count) {
  const file = path.join(f.dir, "logs/requests.log");
  for (let attempt = 0; attempt < 100; attempt++) {
    const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse) : [];
    if (lines.length >= count) return lines;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Request log writes did not arrive");
}

for (const provider of ["openai", "anthropic"]) {
  for (const stream of [false, true]) test(`${provider} ${stream ? "SSE" : "JSON"}: slow judge never blocks response; promotion reuses the source and logs paid overhead`, { timeout: 20000 }, async t => {
    const f = await fixture(t, { provider });
    const seeded = await (await f.call(sourcePrompt)).json();
    assert.equal(seeded.rw_meta.cache_hit, false);
    assert.equal(seeded.choices[0].message.content, cachedAnswer);
    const response = await f.call(nearPrompt, { stream });
    assert.equal(response.status, 200);
    if (stream) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const first = await reader.read();
      let text = decoder.decode(first.value);
      assert.ok(!text.includes("[DONE]"));
      assert.equal(f.judges().length, 0, "judge cannot start while foreground stream is still open");
      f.releaseStream();
      for (;;) { const part = await reader.read(); if (part.done) break; text += decoder.decode(part.value); }
      assert.match(text, /data: \[DONE\]/);
      assert.match(text, /"cache_hit":false/);
      assert.ok(text.includes(freshAnswer));
      assert.ok(!text.includes(cachedAnswer));
    } else {
      const body = await response.json();
      assert.equal(body.rw_meta.cache_hit, false);
      assert.equal(body.choices[0].message.content, freshAnswer);
    }
    await f.judgeStarted.promise;
    assert.equal(f.judgeCompleted(), false, "client has received ALL response bytes while judge is still gated");
    assert.equal(f.judges().length, 1);
    const judge = f.judges()[0];
    assert.equal(judge.url, provider === "openai" ? "/v1/chat/completions" : "/v1/messages");
    assert.equal(provider === "openai" ? judge.authorization : judge.anthropicKey, provider === "openai" ? "Bearer fake-openai" : "fake-anthropic");
    const input = JSON.parse(judge.body.messages.at(-1).content);
    assert.deepEqual(input, { cached_prompt: sourcePrompt, cached_response: cachedAnswer, current_prompt: nearPrompt });
    f.releaseJudge();
    const recorded = await logs(f, 3);
    const event = recorded.find(e => e.financials.source === "cache_verification_judge_call");
    assert.equal(event.cache_verification.outcome, "promoted");
    assert.ok(Math.abs(event.financials.provider_spend_usd - (provider === "openai" ? 0.000092 : 0.0001245)) < 1e-12);
    assert.equal(event.model_used, f.judgeModel);
    for (const prompt of [nearPrompt, paraphrase]) {
      const hit = await (await f.call(prompt)).json();
      assert.equal(hit.rw_meta.cache_hit, true);
      assert.equal(hit.choices[0].message.content, cachedAnswer, "must serve the verified SOURCE answer, not the foreground answer");
      assert.equal(hit.model, f.model);
    }
    assert.equal(f.requests.length, 3, "repeats/paraphrases need neither provider nor judge");
    await logs(f, 5);
    const overview = await f.overview();
    assert.ok(Math.abs(overview.provider_spend_usd - recorded.reduce((sum, e) => sum + e.financials.provider_spend_usd, 0)) < 1e-12);
    assert.equal(overview.unpriced_requests, 0);
  });
}

for (const [name, config, prompt] of [
  ["omitted config", null, nearPrompt],
  ["disabled config", { enabled: false }, nearPrompt],
  ["outside margin", { enabled: true }, farPrompt],
  ["narrow customer margin", { enabled: true, margin: 0.03 }, nearPrompt],
]) test(`${name}: ordinary miss, repeat hit and foreground response stay unchanged`, { timeout: 20000 }, async t => {
  const f = await fixture(t, { config });
  await (await f.call(sourcePrompt)).json();
  const miss = await (await f.call(prompt)).json();
  assert.equal(miss.rw_meta.cache_hit, false);
  assert.equal(miss.choices[0].message.content, freshAnswer);
  const hit = await (await f.call(prompt)).json();
  assert.equal(hit.rw_meta.cache_hit, true);
  assert.equal(hit.choices[0].message.content, freshAnswer);
  const recorded = await logs(f, 3);
  assert.equal(f.judges().length, 0);
  assert.equal(f.requests.length, 2);
  assert.ok(recorded.every(e => e.financials.source !== "cache_verification_judge_call"));
});

for (const judgeError of [false, true]) test(`${judgeError ? "failed" : "NO"} judge retains the foreground answer and still writes a financial event`, { timeout: 20000 }, async t => {
  const f = await fixture(t, { verdict: "NO", judgeError });
  await (await f.call(sourcePrompt)).json();
  const miss = await (await f.call(nearPrompt)).json();
  assert.equal(miss.choices[0].message.content, freshAnswer);
  await f.judgeStarted.promise;
  f.releaseJudge();
  const event = (await logs(f, 3)).find(e => e.financials.source === "cache_verification_judge_call");
  assert.equal(event.cache_verification.outcome, judgeError ? "error" : "not_equivalent");
  if (judgeError) assert.equal(event.financials.provider_spend_usd, null);
  else assert.ok(event.financials.provider_spend_usd > 0);
  const hit = await (await f.call(nearPrompt)).json();
  assert.equal(hit.rw_meta.cache_hit, true);
  assert.equal(hit.choices[0].message.content, freshAnswer);
  assert.equal(f.judges().length, 1);
});

test("different customers/settings and forced flagship never verify against another namespace", { timeout: 20000 }, async t => {
  const f = await fixture(t);
  await (await f.call(sourcePrompt)).json();
  for (const [options, key] of [[{}, "other-tenant"], [{ temperature: 0.5 }, "offline-test"], [{ model: "requested-alias" }, "offline-test"], [{ max_tokens: 32 }, "offline-test"], [{ force_flagship: true }, "offline-test"]]) {
    const miss = await (await f.call(nearPrompt, options, key)).json();
    assert.equal(miss.rw_meta.cache_hit, false);
  }
  await logs(f, 6);
  assert.equal(f.judges().length, 0);
  assert.equal(f.requests.length, 6);
});

for (const stream of [false, true]) test(`failed foreground ${stream ? "stream" : "call"} never starts verification`, { timeout: 20000 }, async t => {
  const f = await fixture(t, { foregroundError: true });
  await (await f.call(sourcePrompt)).json();
  f.releaseStream();
  const response = await f.call(nearPrompt, { stream });
  assert.equal(response.status, stream ? 200 : 502);
  assert.match(await response.text(), /Upstream provider error/);
  // A following request supplies an event-loop barrier and verifies the server survived.
  assert.equal((await (await f.call(sourcePrompt)).json()).rw_meta.cache_hit, true);
  assert.equal(f.judges().length, 0);
});
