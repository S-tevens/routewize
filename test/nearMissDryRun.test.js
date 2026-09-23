import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

test("dry run rejects verification-enabled forecasts and retains the ordinary disabled baseline", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routewize-dry-verification-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = path.join(dir, "requests.jsonl");
  const config = path.join(dir, "customers.json");
  fs.writeFileSync(input, JSON.stringify({ customer_api_key: "offline", messages: [{ role: "user", content: "hello" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) + "\n");
  for (const enabled of [true, false]) {
    fs.writeFileSync(config, JSON.stringify({ customers: [{
      name: "Test", api_key: "offline", default: { provider: "openai", model: "gpt-4o" },
      cache: { enabled: true, near_miss_verification: { enabled } },
    }] }));
    const result = spawnSync(process.execPath, [path.join(root, "scripts/dryRun.js"), input, config], {
      cwd: dir, encoding: "utf8", timeout: 10000,
      env: { PATH: process.env.PATH, EMBEDDING_PROVIDER: "mock", PRICING_SOURCE: "static", DOTENV_CONFIG_PATH: path.join(dir, "absent.env") },
    });
    assert.equal(result.status, enabled ? 1 : 0, result.stderr);
    if (enabled) {
      assert.match(result.stderr, /cannot simulate paid async near-miss verification/);
      assert.ok(!result.stdout.includes("Dry Run Report"));
    } else {
      assert.match(result.stdout, /Dry Run Report/);
      assert.match(result.stdout, /Requests analyzed:\s+1/);
    }
  }
});
