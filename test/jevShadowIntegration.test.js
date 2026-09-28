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
const cachedAnswer = "You can return your purchase within 30 days.";
const freshAnswer = "The return window is thirty days from purchase.";
const vectors = {
  [sourcePrompt]: [1, 0, 0],
  [nearPrompt]: [0.88, Math.sqrt(1 - 0.88 ** 2), 0],
};
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
const rates = { input: 1, output: 2, cached_input: 0.5, cache_write_input: 1.25, source: "offline fixture", as_of: "2026-09-22" };

async function fixture(t, { provider = "openai", foregroundError = false } = {}) {
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
      const judge = req.url === "/decisions";
      if (judge) {
        judgeStarted.resolve();
        await judgeGate.promise;
        judgeCompleted = true;
        return json(res, { answers: { tier: { type: "choice", choice: "small", confidence: 0.8, probabilities: { small: 0.9, standard: 0.08, frontier: 0.02 } } }, usage: { cost: 0.001 } });

      }
      const prompt = body.messages.at(-1).content;
      const content = prompt === sourcePrompt ? cachedAnswer : freshAnswer;
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
  customer.provider_keys.openrouter = "fixture-openrouter";
  customer.routing = { jev_shadow: { enabled: true, criteria: { small: "FAQ", standard: "Summaries", frontier: "Complex reasoning" } } };
  const jevFile = path.join(dir, "src/router/jevShadow.js");
  fs.writeFileSync(jevFile, fs.readFileSync(jevFile, "utf8").replace("https://openrouter.ai/api/alpha/decisions", `${base}/decisions`));
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
    judges: () => requests.filter(r => r.url === "/decisions"),
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
  for (const stream of [false, true]) test(`Jev shadow ${provider} ${stream ? "SSE" : "JSON"}: foreground unchanged, paid decision visible in stats`, { timeout: 20000 }, async t => {
    const f = await fixture(t, { provider });
    const response = await f.call(sourcePrompt, { stream });
    assert.equal(response.status, 200);
    f.releaseStream();
    const text = await response.text();
    assert.ok(text.includes(cachedAnswer));
    await f.judgeStarted.promise;
    assert.equal(f.judgeCompleted(), false, "response completed before shadow classifier");
    assert.equal(f.judges()[0].authorization, "Bearer fixture-openrouter");
    assert.equal(f.judges()[0].body.questions.tier.type, "choice");
    f.releaseJudge();
    const events = await logs(f, 2);
    const decision = events.find(e => e.jev_shadow);
    assert.equal(decision.jev_shadow.choice, "small");
    assert.equal(decision.jev_shadow.actual_route.model, f.model);
    assert.equal(decision.financials.provider_spend_usd, 0.001);
    assert.equal(decision.estimated_savings, -0.001);
    const hit = await (await f.call(sourcePrompt)).json();
    assert.equal(hit.rw_meta.cache_hit, true);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(f.judges().length, 1, "cache hits do not trigger paid classification");
    const overview = await f.overview();
    assert.ok(overview.known_provider_spend_usd >= 0.001);
  });
}

for (const stream of [false, true]) test(`Jev skips failed foreground ${stream ? "stream" : "JSON"}`, { timeout: 20000 }, async t => {
  const f = await fixture(t, { foregroundError: true });
  f.releaseStream();
  const response = await f.call(nearPrompt, { stream });
  const text = await response.text();
  assert.ok(text.includes("error"));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(f.judges().length, 0);
});
