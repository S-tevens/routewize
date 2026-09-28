import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
test("new-provider dry run uses qualified rates and rejects missing prices", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routewize-provider-dry-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = path.join(dir, "requests.jsonl"), config = path.join(dir, "config.json");
  fs.writeFileSync(input, JSON.stringify({ customer_api_key: "fixture", messages: [{ role: "user", content: "hello" }], usage: { prompt_tokens: 1000, completion_tokens: 1000 } }) + "\n");
  for (const configured of [true, false]) {
    fs.writeFileSync(config, JSON.stringify({ customers: [{ api_key: "fixture", name: "Fixture",
      default: { provider: "together", model: "org/model" }, provider_keys: { together: "fixture-key" },
      cache: { enabled: false }, evaluation: { pricing: configured ? { "together/org/model": {
        input: 10, output: 20, cached_input: 5, source: "fixture", as_of: "2026-09-28",
      } } : {} },
    }] }));
    const result = spawnSync(process.execPath, [path.join(root, "scripts/dryRun.js"), input, config], {
      cwd: dir, encoding: "utf8", timeout: 10000, env: { PATH: process.env.PATH, EMBEDDING_PROVIDER: "mock", PRICING_SOURCE: "static", DOTENV_CONFIG_PATH: path.join(dir, "absent.env") },
    });
    assert.equal(result.status, configured ? 0 : 1, result.stderr);
    if (configured) assert.match(result.stdout, /0\.0300/);
    else assert.match(result.stderr, /Configure input, output, cached_input/);
  }
});
