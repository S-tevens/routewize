import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { COMPATIBLE_PROVIDERS } from "../src/providers/catalog.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const rates = { input: 1, output: 2, cached_input: 0.5, source: "fixture", as_of: "2026-09-28" };
async function fixture(t, provider, mode = "success") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routewize-providers-"));
  const requests = [];
  let child, release;
  const gate = new Promise(resolve => { release = resolve; });
  const upstream = http.createServer(async (req, res) => {
    let text = "";
    for await (const part of req) text += part;
    const body = JSON.parse(text);
    requests.push({ body, url: req.url, key: req.headers.authorization });
    if (mode === "before") {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "fixture failure" } }));
    }
    const usage = { prompt_tokens: 10, completion_tokens: 2, cost: 0.00002,
      ...(provider === "deepseek" ? { prompt_cache_hit_tokens: 4, prompt_cache_miss_tokens: 6 } : { prompt_tokens_details: { cached_tokens: 4 } }) };
    const raw = { id: "fixture", model: body.model, choices: [{ message: { role: "assistant", content: "Hello world" }, finish_reason: "stop" }], usage };
    if (!body.stream) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(raw));
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (content, extra = {}) => ({ id: "fixture", model: body.model, object: "chat.completion.chunk", created: 1,
      choices: [{ index: 0, delta: { content }, finish_reason: null }], ...extra });
    const send = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
    send(chunk("Hello"));
    if (mode === "success") await gate;
    if (mode === "during") send({ error: { message: "fixture stream failed" } });
    else {
      send(chunk(" world", { choices: [{ index: 0, delta: { content: " world" }, finish_reason: "stop" }],
        ...(mode === "missing-usage" ? {} : provider === "groq" ? { x_groq: { usage } } : { usage }) }));
      // Deliberately repeated cumulative usage must be accounted only once.
      if (mode !== "missing-usage") send(chunk("", { choices: [], usage }));
    }
    res.end("data: [DONE]\n\n");
  });
  t.after(async () => {
    release();
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close"); child.kill(); await closed;
    }
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  fs.cpSync(path.join(root, "src"), path.join(dir, "src"), { recursive: true, filter: p => !p.endsWith("customers.yaml") });
  fs.symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"), "junction");
  fs.writeFileSync(path.join(dir, "package.json"), '{"type":"module"}');
  const catalog = path.join(dir, "src/providers/catalog.js");
  fs.writeFileSync(catalog, fs.readFileSync(catalog, "utf8").replace(COMPATIBLE_PROVIDERS[provider].baseURL, `http://127.0.0.1:${upstream.address().port}/v1`));
  const customer = { api_key: "tenant-a", name: "Tenant A", default: { provider, model: "org/test-model" },
    provider_keys: { [provider]: "provider-key-a" }, cache: { enabled: true, similarity_threshold: 0.99 },
    evaluation: { pricing: { [`${provider}/org/test-model`]: rates } }, rate_limit: { requests_per_minute: 0 } };
  fs.writeFileSync(path.join(dir, "customers.json"), JSON.stringify({ customers: [customer,
    { ...customer, api_key: "tenant-b", name: "Tenant B", provider_keys: { [provider]: "provider-key-b" } }] }));
  child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { Server } from 'node:net';
    const listen = Server.prototype.listen;
    Server.prototype.listen = function(...args) {
      this.once('listening', () => process.send({ port: this.address().port }));
      return listen.apply(this, args);
    };
    await import('./src/server.js');
  `], { cwd: dir, env: { PATH: process.env.PATH, PORT: "0", CUSTOMERS_CONFIG: path.join(dir, "customers.json"),
    DOTENV_CONFIG_PATH: path.join(dir, "absent.env"), PRICING_SOURCE: "static", EMBEDDING_PROVIDER: "mock" },
    stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let diagnostics = "";
  child.stdout.on("data", d => { diagnostics += d; }); child.stderr.on("data", d => { diagnostics += d; });
  const { port } = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(diagnostics)), 10000);
    child.once("message", v => { clearTimeout(timer); resolve(v); });
    child.once("error", e => { clearTimeout(timer); reject(e); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error(diagnostics)); });
  });
  const base = `http://127.0.0.1:${port}`;
  return { requests, release, dir,
    get: (url, key = "tenant-a") => fetch(`${base}${url}`, { headers: { Authorization: `Bearer ${key}` } }),
    call: (stream, key = "tenant-a") => fetch(`${base}/v1/chat/completions`, { method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Say hello world" }], stream }), signal: AbortSignal.timeout(10000) }) };
}

async function logs(f, count) {
  const file = path.join(f.dir, "logs/requests.log");
  for (let i = 0; i < 100; i++) {
    const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse) : [];
    if (lines.length >= count) return lines;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Expected financial events");
}

for (const provider of Object.keys(COMPATIBLE_PROVIDERS)) {
  test(`${provider}: real proxy JSON, SSE, cache, accounting and tenant keys`, { timeout: 20000 }, async t => {
    const f = await fixture(t, provider);
    const first = await f.call(true);
    assert.equal(first.status, 200);
    const reader = first.body.getReader();
    const initial = await reader.read();
    assert.match(new TextDecoder().decode(initial.value), /Hello/);
    f.release();
    let output = new TextDecoder().decode(initial.value);
    while (true) { const part = await reader.read(); if (part.done) break; output += new TextDecoder().decode(part.value); }
    assert.equal((output.match(/rw_meta/g) ?? []).length, 1);
    const events = await logs(f, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].provider, provider);
    const breakdown = events[0].savings_breakdown;
    assert.ok(Math.abs(breakdown.cache_usd + breakdown.routing_usd + (breakdown.prompt_cache_usd ?? 0) - events[0].estimated_savings) < 1e-12);
    assert.equal(events[0].cost_estimate.actual_usd, provider === "openrouter" ? 0.00002 : 0.000012);
    assert.equal(events[0].financials.provider_spend_usd, provider === "openrouter" ? 0.00002 : 0.000012);
    assert.equal((await (await f.call(false)).json()).rw_meta.cache_hit, true);
    assert.equal(f.requests.length, 1);
    const other = await (await f.call(false, "tenant-b")).json();
    assert.equal(other.choices[0].message.content, "Hello world");
    assert.equal(other.rw_meta.cache_hit, false);
    assert.equal(f.requests[0].key, "Bearer provider-key-a");
    assert.equal(f.requests[1].key, "Bearer provider-key-b");
    const catalog = await (await f.get("/api/providers")).json();
    assert.equal(catalog.providers.length, 11);
    assert.deepEqual(catalog.providers.filter(p => p.configured).map(p => p.id), [provider]);
    assert.ok(!JSON.stringify(catalog).includes("provider-key"));
    assert.equal((await f.get("/api/providers", "invalid")).status, 401);
  });
}

for (const mode of ["before", "during", "missing-usage"]) {
  test(`compatible provider ${mode} failure logs unknown cost and never caches partial output`, { timeout: 20000 }, async t => {
    const f = await fixture(t, "gemini", mode);
    const response = await f.call(true);
    assert.equal(response.status, mode === "before" ? 502 : 200);
    assert.match(await response.text(), /error/);
    const events = await logs(f, 1);
    assert.equal(events[0].financials.provider_spend_usd, null);
    assert.equal(events[0].cost_estimate, undefined);
    await (await f.call(true)).text();
    assert.equal(f.requests.length, 2);
  });
}
