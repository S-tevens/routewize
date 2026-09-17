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
const chunk = (model, delta, extra = {}) => ({ id: "fixture", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: null }], ...extra });
const data = (res, value, type) => res.write(`${type ? `event: ${type}\n` : ""}data: ${JSON.stringify(value)}\n\n`);

async function fixture(t, provider, mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routewise-stream-"));
  let child;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const requests = [];
  const model = provider === "openai" ? "gpt-4o" : "claude-sonnet-4-6";
  const upstream = http.createServer(async (req, res) => {
    try {
      let body = "";
      for await (const part of req) body += part;
      requests.push({ url: req.url, body: JSON.parse(body) });
      if (mode === "before") {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { type: "authentication_error", message: "fixture auth failure" } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (provider === "openai") data(res, chunk(model, { role: "assistant", content: "Hello" }));
      else {
        data(res, { type: "message_start", message: { id: "fixture", model, usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 4, cache_creation_input_tokens: 0 } } }, "message_start");
        data(res, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }, "content_block_delta");
      }
      if (mode === "success") await gate; // prove the client sees data before upstream completes
      if (mode === "during") {
        data(res, { type: "error", error: { type: "api_error", message: "fixture stream failure" } }, provider === "anthropic" ? "error" : undefined);
      } else if (provider === "openai") {
        data(res, chunk(model, { content: " world" }));
        data(res, chunk(model, {}, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
        data(res, chunk(model, {}, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }));
      } else {
        data(res, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } }, "content_block_delta");
        data(res, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }, "message_delta");
        data(res, { type: "message_stop" }, "message_stop");
      }
      if (provider === "openai") res.write("data: [DONE]\n\n");
      res.end();
    } catch (error) { res.destroy(error); }
  });
  t.after(async () => {
    release();
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close"); child.kill(); await closed;
    }
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  // Run unchanged application source in an isolated directory: neither real
  // customer config nor project request logs are touched by these tests.
  fs.cpSync(path.join(root, "src"), path.join(dir, "src"), { recursive: true, filter: source => !source.endsWith("customers.yaml") });
  // "junction" (not "dir") because Windows requires admin/Developer Mode to
  // create a directory *symlink* without elevation, but not a junction — the
  // target must be absolute for a junction, which `root` already is. Node
  // ignores the type argument entirely on non-Windows platforms, so this is
  // a no-op behavior change there.
  fs.symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"), "junction");
  fs.writeFileSync(path.join(dir, "package.json"), '{"type":"module"}');
  fs.writeFileSync(path.join(dir, "customers.json"), JSON.stringify({ customers: [{
    api_key: "offline-test", name: "Offline Tenant", provider_keys: { openai: "fake-openai", anthropic: "fake-anthropic" },
    default: { provider, model }, cache: { enabled: true, similarity_threshold: 0.99 },
    rate_limit: { requests_per_minute: 0 },
    evaluation: { pricing: { [`${provider}/${model}`]: { input: 1, output: 2, cached_input: 0.5, cache_write_input: 1.25, source: "fixture", as_of: "2026-09-13" } } },
  }] }));
  // Test-only listener instrumentation reports the OS-assigned port via IPC.
  // Production server exports, routes and request handling remain unchanged.
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
    DOTENV_CONFIG_PATH: path.join(dir, "absent.env"), PRICING_SOURCE: "static", EMBEDDING_PROVIDER: "mock",
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
  return { release, requests, model, dir, call: (stream = true) => fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
    method: "POST", headers: { Authorization: "Bearer offline-test", "Content-Type": "application/json" },
    body: JSON.stringify({ stream, messages: [{ role: "system", content: "You are a concise assistant." }, { role: "user", content: "Say hello world" }], max_tokens: 32 }), signal: AbortSignal.timeout(10000),
  }) };
}

function events(text) {
  const frames = text.split("\n\n").filter(Boolean).map(frame => frame.split("\n").find(line => line.startsWith("data: "))?.slice(6));
  assert.equal(frames.filter(value => value === "[DONE]").length, 1);
  assert.equal(frames.at(-1), "[DONE]");
  return frames.slice(0, -1).map(JSON.parse);
}

async function logs(dir, count) {
  const file = path.join(dir, "logs/requests.log");
  for (let attempt = 0; attempt < 100; attempt++) {
    const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
    if (lines.length >= count) return lines;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Request log writes did not arrive");
}

for (const provider of ["openai", "anthropic"]) {
  test(`${provider}: streaming delivers incremental content, final usage/meta, priced log and reusable cache`, { timeout: 20000 }, async t => {
    const f = await fixture(t, provider, "success");
    const response = await f.call();
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    const decoder = new TextDecoder();
    let text = decoder.decode(first.value, { stream: true });
    assert.match(text, /chat.completion.chunk/);
    assert.ok(!text.includes("[DONE]"));
    f.release();
    for (;;) { const part = await reader.read(); if (part.done) break; text += decoder.decode(part.value, { stream: true }); }
    text += decoder.decode();
    const received = events(text);
    assert.equal(received.map(e => e.choices?.[0]?.delta?.content ?? "").join(""), "Hello world");
    const final = received.at(-1);
    assert.deepEqual(final.usage, { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 });
    assert.equal(final.rw_meta.cache_hit, false);
    assert.equal(final.rw_meta.matched_rule, "default-fallback");
    assert.equal(final.rw_meta.estimated_savings_usd, 0);
    assert.equal(typeof final.rw_meta.optimization, "object");
    assert.equal(received.filter(e => e.rw_meta).length, 1);
    assert.ok(received.some(e => e.choices?.[0]?.finish_reason === "stop"));
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].body.stream, true);
    assert.equal(f.requests[0].body.max_tokens, 32);
    assert.equal(f.requests[0].url, provider === "openai" ? "/v1/chat/completions" : "/v1/messages");
    if (provider === "openai") {
      assert.deepEqual(f.requests[0].body.stream_options, { include_usage: true });
      assert.deepEqual(f.requests[0].body.messages[0], { role: "system", content: "You are a concise assistant." });
    } else {
      // Prompt-cache breakpoint on the system block: repeated calls with the
      // same system text get it billed at the cached-read rate after this
      // first request writes it.
      assert.deepEqual(f.requests[0].body.system, [{ type: "text", text: "You are a concise assistant.", cache_control: { type: "ephemeral" } }]);
    }
    const recorded = await logs(f.dir, 1);
    assert.equal(recorded.length, 1);
    assert.ok(Math.abs(recorded[0].financials.provider_spend_usd - (provider === "anthropic" ? 0.000018 : 0.000016)) < 1e-12);
    assert.notEqual(recorded[0].financials.provider_spend_usd, null);
    // No routing rule matched (route == customer default) so routing_usd is 0.
    // Anthropic's fixture usage carries a static cache_read_input_tokens: 4,
    // so its prompt-cache line is nonzero even without a second real call.
    assert.equal(recorded[0].savings_breakdown.cache_usd, 0);
    assert.equal(recorded[0].savings_breakdown.routing_usd, 0);
    assert.ok(Math.abs(recorded[0].savings_breakdown.prompt_cache_usd - (provider === "anthropic" ? 0.000002 : 0)) < 1e-12);
    const cached = events(await (await f.call()).text());
    assert.equal(cached.length, 1);
    assert.equal(cached[0].rw_meta.cache_hit, true);
    assert.equal(cached[0].choices[0].delta.content, "Hello world");
    const ordinary = await (await f.call(false)).json();
    assert.equal(ordinary.choices[0].message.content, "Hello world");
    assert.equal(ordinary.rw_meta.cache_hit, true);
    assert.equal(f.requests.length, 1);
  });

  for (const mode of ["before", "during"]) test(`${provider}: failure ${mode} streaming has correct HTTP/SSE shape and never caches partial output`, { timeout: 20000 }, async t => {
    const f = await fixture(t, provider, mode);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await f.call();
      if (mode === "before") {
        assert.equal(response.status, 502);
        assert.match(response.headers.get("content-type"), /application\/json/);
        const body = await response.json();
        assert.equal(body.error.type, "upstream_error");
        assert.match(body.error.message, /fixture auth failure/);
      } else {
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type"), /text\/event-stream/);
        const received = events(await response.text());
        assert.ok(received.some(e => e.choices?.[0]?.delta?.content === "Hello"));
        assert.equal(received.at(-1).error.type, "upstream_error");
        assert.match(received.at(-1).error.message, /fixture stream failure/);
        assert.ok(received.every(e => !e.rw_meta && !e.usage));
      }
    }
    assert.equal(f.requests.length, 2, "retry must reach provider rather than a cached partial answer");
    assert.equal(fs.existsSync(path.join(f.dir, "logs/requests.log")), false);
  });
}
