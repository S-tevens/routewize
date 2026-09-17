import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

// Isolated server instance with two customers and a configured ADMIN_TOKEN --
// proves the admin route aggregates across customers and that a customer's
// own api_key cannot be used as an admin token, without touching real
// customer config, provider keys, or project request logs.
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routewize-admin-"));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close"); child.kill(); await closed;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  fs.cpSync(path.join(root, "src"), path.join(dir, "src"), { recursive: true, filter: (source) => !source.endsWith("customers.yaml") });
  fs.cpSync(path.join(root, "admin"), path.join(dir, "admin"), { recursive: true });
  fs.symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"), "junction");
  fs.writeFileSync(path.join(dir, "package.json"), '{"type":"module"}');
  fs.writeFileSync(path.join(dir, "customers.json"), JSON.stringify({
    customers: [
      { api_key: "customer-one-key", name: "Customer One", provider_keys: {}, default: { provider: "openai", model: "gpt-4o" }, rate_limit: { requests_per_minute: 0 } },
      { api_key: "customer-two-key", name: "Customer Two", provider_keys: {}, default: { provider: "openai", model: "gpt-4o" }, rate_limit: { requests_per_minute: 0 } },
    ],
  }));

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
    ADMIN_TOKEN: "the-real-admin-token",
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
  const base = `http://127.0.0.1:${address.port}`;
  return { base, get: (path, bearer) => fetch(`${base}${path}`, { headers: bearer ? { Authorization: `Bearer ${bearer}` } : {}, signal: AbortSignal.timeout(10000) }) };
}

test("admin overview aggregates every customer and totals request counts", async (t) => {
  const f = await fixture(t);
  const res = await f.get("/admin/api/overview", "the-real-admin-token");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.customer_count, 2);
  assert.deepEqual(body.customers.map((c) => c.name).sort(), ["Customer One", "Customer Two"]);
  assert.equal(body.totals.request_count, 0);
});

test("a customer's own api_key is rejected on the admin route -- no shared auth path", async (t) => {
  const f = await fixture(t);
  const res = await f.get("/admin/api/overview", "customer-one-key");
  assert.equal(res.status, 401);
});

test("the admin token does not work on customer-scoped routes either -- isolation runs both ways", async (t) => {
  const f = await fixture(t);
  const res = await f.get("/api/stats", "the-real-admin-token");
  assert.equal(res.status, 401);
});

test("wrong or missing admin token is rejected; the page shell itself needs no auth", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.get("/admin/api/overview", "wrong-token")).status, 401);
  assert.equal((await f.get("/admin/api/overview")).status, 401);
  const page = await f.get("/admin");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Admin overview/);
  const script = await f.get("/admin/admin.js");
  assert.equal(script.status, 200);
});
