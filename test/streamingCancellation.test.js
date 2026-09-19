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
const sse = (res, value) => res.write(`data: ${JSON.stringify(value)}\n\n`);

// A client that disconnects mid-stream, after the provider has already
// produced real (billable) output but before the final usage-bearing chunk
// arrives -- proves the server records this as unpriced-but-visible rather
// than silently dropping it.
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routewize-cancel-"));
  let child;
  let releaseUpstream;
  const gate = new Promise((resolve) => { releaseUpstream = resolve; });
  t.after(async () => {
    releaseUpstream();
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close"); child.kill(); await closed;
    }
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const model = "gpt-4o";
  const upstream = http.createServer(async (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    sse(res, chunk(model, { role: "assistant", content: "Hello" }));
    // Hang here -- the real provider is "still generating" -- until the
    // test releases it, well after the client has already disconnected.
    await gate;
    sse(res, chunk(model, {}, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }));
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${upstream.address().port}`;

  fs.cpSync(path.join(root, "src"), path.join(dir, "src"), { recursive: true, filter: (source) => !source.endsWith("customers.yaml") });
  fs.symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"), "junction");
  fs.writeFileSync(path.join(dir, "package.json"), '{"type":"module"}');
  fs.writeFileSync(path.join(dir, "customers.json"), JSON.stringify({ customers: [{
    api_key: "offline-test", name: "Offline Tenant", provider_keys: { openai: "fake-openai", anthropic: "fake-anthropic" },
    default: { provider: "openai", model }, cache: { enabled: false },
    rate_limit: { requests_per_minute: 0 },
  }] }));

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
  child.stdout.on("data", (d) => { diagnostics += d; });
  child.stderr.on("data", (d) => { diagnostics += d; });
  const address = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Proxy startup timed out: ${diagnostics}`)), 10000);
    child.once("message", (value) => { clearTimeout(timer); resolve(value); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error(diagnostics)); });
  });

  return {
    dir, releaseUpstream,
    // Starts the streaming request, reads exactly one chunk (proving the
    // provider call actually started and produced output), then aborts --
    // simulating a real client disconnect mid-stream.
    async callThenDisconnect() {
      const controller = new AbortController();
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
        method: "POST", headers: { Authorization: "Bearer offline-test", "Content-Type": "application/json" },
        body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "Say hello world" }], max_tokens: 32 }),
        signal: controller.signal,
      });
      const reader = response.body.getReader();
      const first = await reader.read();
      assert.equal(first.done, false);
      controller.abort();
      try { await reader.cancel(); } catch { /* already aborted */ }
    },
  };
}

async function logs(dir, count) {
  const file = path.join(dir, "logs/requests.log");
  for (let attempt = 0; attempt < 200; attempt++) {
    const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
    if (lines.length >= count) return lines;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Request log writes did not arrive");
}

test("a client disconnect after real provider output has started is logged as unpriced, not silently dropped", { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  await f.callThenDisconnect();
  const recorded = await logs(f.dir, 1);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].financials.provider_spend_usd, null);
  assert.equal(recorded[0].financials.source, "cancelled_client_disconnect_unknown_spend");
  assert.equal(recorded[0].cache_hit, false);
  // Never guessed as savings/cost -- zero contribution, not a fabricated number.
  assert.equal(recorded[0].estimated_savings, 0);
  assert.deepEqual(recorded[0].savings_breakdown, { cache_usd: 0, routing_usd: 0, prompt_cache_usd: null });
  f.releaseUpstream();
});
