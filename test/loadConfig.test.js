import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCustomers, getCustomerByApiKey, reloadCustomers, watchCustomersConfig } from "../src/config/loadConfig.js";

function tempConfigPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rw-config-test-"));
  return path.join(dir, "customers.yaml");
}

function writeConfig(configPath, yamlText) {
  fs.writeFileSync(configPath, yamlText, "utf8");
}

const BASE_CONFIG = `
customers:
  - api_key: "test_key_1"
    name: "Test Co"
    provider_keys:
      openai: "sk-plain-value"
      anthropic: "sk-ant-plain"
    default:
      provider: openai
      model: gpt-4o
`;

test("loads a valid config and resolves a customer by api_key", () => {
  const configPath = tempConfigPath();
  writeConfig(configPath, BASE_CONFIG);
  reloadCustomers();

  const customer = getCustomerByApiKey(configPath, "test_key_1");
  assert.equal(customer.name, "Test Co");
  assert.equal(customer.provider_keys.openai, "sk-plain-value");
});

test("substitutes ${ENV_VAR} placeholders with real environment variable values", () => {
  process.env.RW_TEST_OPENAI_KEY = "sk-from-env-12345";
  const configPath = tempConfigPath();
  writeConfig(
    configPath,
    `
customers:
  - api_key: "test_key_2"
    name: "Env Co"
    provider_keys:
      openai: "\${RW_TEST_OPENAI_KEY}"
    default: { provider: openai, model: gpt-4o }
`
  );
  reloadCustomers();

  const customer = getCustomerByApiKey(configPath, "test_key_2");
  assert.equal(customer.provider_keys.openai, "sk-from-env-12345");
  delete process.env.RW_TEST_OPENAI_KEY;
});

test("throws a clear error listing missing environment variables, without silently inserting an empty value", () => {
  const configPath = tempConfigPath();
  writeConfig(
    configPath,
    `
customers:
  - api_key: "test_key_3"
    name: "Missing Env Co"
    provider_keys:
      openai: "\${RW_TEST_DEFINITELY_UNSET_VAR}"
    default: { provider: openai, model: gpt-4o }
`
  );
  reloadCustomers();

  assert.throws(() => loadCustomers(configPath), /RW_TEST_DEFINITELY_UNSET_VAR/);
});

test("rejects a customer entry missing api_key", () => {
  const configPath = tempConfigPath();
  writeConfig(
    configPath,
    `
customers:
  - name: "No Key Co"
    default: { provider: openai, model: gpt-4o }
`
  );
  reloadCustomers();

  assert.throws(() => loadCustomers(configPath), /missing api_key/);
});

test("watchCustomersConfig hot-reloads on file change without a restart", async () => {
  const configPath = tempConfigPath();
  writeConfig(configPath, BASE_CONFIG);
  reloadCustomers();
  loadCustomers(configPath); // establish initial cache

  const watcher = watchCustomersConfig(configPath);
  try {
    writeConfig(
      configPath,
      `
customers:
  - api_key: "test_key_1"
    name: "Renamed Co"
    provider_keys: { openai: "sk-plain-value", anthropic: "sk-ant-plain" }
    default: { provider: openai, model: gpt-4o }
`
    );

    await new Promise((resolve) => setTimeout(resolve, 500));

    const customer = getCustomerByApiKey(configPath, "test_key_1");
    assert.equal(customer.name, "Renamed Co");
  } finally {
    watcher.close();
  }
});

test("watchCustomersConfig keeps the previous good config if the edited file fails to parse", async () => {
  const configPath = tempConfigPath();
  writeConfig(configPath, BASE_CONFIG);
  reloadCustomers();
  loadCustomers(configPath); // establish initial cache

  const watcher = watchCustomersConfig(configPath);
  const originalError = console.error;
  console.error = () => {}; // expected error path — keep test output clean
  try {
    writeConfig(configPath, "customers:\n  - name: \"Broken, no api_key\"\n");

    await new Promise((resolve) => setTimeout(resolve, 500));

    const customer = getCustomerByApiKey(configPath, "test_key_1");
    assert.equal(customer.name, "Test Co", "should still serve the last good config");
  } finally {
    console.error = originalError;
    watcher.close();
  }
});
