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
const secret = "orchid-marker-4410";

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routewize-decision-"));
  const upstreamModels = [];
  const upstream = http.createServer(async (req, res) => {
    let text = "";
    for await (const part of req) text += part;
    const body = JSON.parse(text);
    upstreamModels.push(body.model);
    const usage = { prompt_tokens: 20, completion_tokens: 3 };
    if (!body.stream) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ id: "f", object: "chat.completion", model: body.model, choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage }));
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (extra) => `data: ${JSON.stringify({ id: "f", object: "chat.completion.chunk", created: 1, model: body.model, ...extra })}\n\n`;
    res.write(chunk({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] }));
    res.write(chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
    res.write(chunk({ choices: [], usage }));
    res.end("data: [DONE]\n\n");
  });
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close"); child.kill(); await closed;
    }
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  fs.cpSync(path.join(root, "src"), path.join(dir, "src"), { recursive: true, filter: (source) => !source.endsWith("customers.yaml") });
  fs.symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"), "junction");
  fs.writeFileSync(path.join(dir, "package.json"), '{"type":"module"}');
  const base = {
    provider_keys: { openai: "fake-openai" }, default: { provider: "openai", model: "gpt-4o" },
    cache: { enabled: false }, rate_limit: { requests_per_minute: 0 },
  };
  const rules = [{ name: "short-classification", match: { max_prompt_tokens: 200, keywords: ["classify"] }, route_to: { provider: "openai", model: "gpt-4o-mini" } }];
  fs.writeFileSync(path.join(dir, "customers.json"), JSON.stringify({ customers: [
    { ...base, api_key: "advised", name: "Advised", routing: { decision_engine: { enabled: true }, rules } },
    { ...base, api_key: "plain", name: "Plain", routing: { rules } },
  ] }));
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
    DOTENV_CONFIG_PATH: path.join(dir, "absent.env"), PRICING_SOURCE: "static",
    OPENAI_BASE_URL: `http://127.0.0.1:${upstream.address().port}/v1`,
  }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let diagnostics = "";
  child.stdout.on("data", (d) => { diagnostics += d; });
  child.stderr.on("data", (d) => { diagnostics += d; });
  const address = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Proxy startup timed out: ${diagnostics}`)), 10000);
    child.once("message", (value) => { clearTimeout(timer); resolve(value); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error(diagnostics)); });
  });
  const url = `http://127.0.0.1:${address.port}/v1/chat/completions`;
  return {
    upstreamModels,
    logFile: path.join(dir, "logs", "requests.log"),
    call: (key, prompt, { trace = false, stream = false } = {}) => fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(trace ? { "x-routewize-trace": "1" } : {}) },
      body: JSON.stringify({ messages: [{ role: "user", content: prompt }], stream }),
      signal: AbortSignal.timeout(10000),
    }),
  };
}

const lastSseMeta = (text) => text.split("\n\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6))).at(-1).rw_meta;

test("trace header returns the route reason and advisory decision; routing itself is unchanged", async (t) => {
  const f = await fixture(t);
  const res = await f.call("advised", `Classify this ticket: ${secret} app crashes on login`, { trace: true });
  assert.equal(res.status, 200);
  const body = await res.json();
  // the customer's rule still decides the model
  assert.equal(body.model, "gpt-4o-mini");
  assert.deepEqual(f.upstreamModels, ["gpt-4o-mini"]);
  assert.equal(body.rw_meta.trace.route.matched_rule, "short-classification");
  assert.ok(body.rw_meta.trace.route.why.includes('keyword "classify"'));
  assert.equal(body.rw_meta.trace.decision.engine, "rules-v1");
  assert.equal(body.rw_meta.trace.decision.suggested_tier, "quick");
  assert.ok(!JSON.stringify(body.rw_meta).includes(secret));
});

test("no trace header means no trace in the response", async (t) => {
  const f = await fixture(t);
  const body = await (await f.call("advised", "Classify this ticket")).json();
  assert.equal(body.rw_meta.trace, undefined);
});

test("customers without the engine enabled get the route reason but no decision", async (t) => {
  const f = await fixture(t);
  const body = await (await f.call("plain", "Write a poem about spring", { trace: true })).json();
  assert.equal(body.model, "gpt-4o");
  assert.deepEqual(body.rw_meta.trace.route.why, ["no routing rule matched (1 checked)"]);
  assert.equal(body.rw_meta.trace.decision, null);
});

test("streaming responses carry the trace on the final chunk", async (t) => {
  const f = await fixture(t);
  const res = await f.call("advised", "Compare active-active and active-passive designs step by step and explain the trade-offs", { trace: true, stream: true });
  const meta = lastSseMeta(await res.text());
  assert.equal(meta.trace.route.matched_rule, "default-fallback");
  assert.ok(["high", "premium"].includes(meta.trace.decision.suggested_tier));
});

test("request logs record the route reason and decision without prompt text", async (t) => {
  const f = await fixture(t);
  await (await f.call("advised", `Classify this: ${secret}`)).json();
  let lines = [];
  for (let i = 0; i < 50 && lines.length === 0; i++) {
    if (fs.existsSync(f.logFile)) lines = fs.readFileSync(f.logFile, "utf8").trim().split("\n").filter(Boolean);
    if (lines.length === 0) await new Promise((r) => setTimeout(r, 50));
  }
  const event = JSON.parse(lines.at(-1));
  assert.deepEqual(event.route_why, [`~${Math.ceil(`Classify this: ${secret}`.length / 4)} tokens ≤ 200`, 'keyword "classify"']);
  assert.equal(event.decision.suggested_tier, "quick");
  assert.ok(!lines.join("\n").includes(secret));
});
