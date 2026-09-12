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

function envFixture(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const configPath = tempConfigPath();
  t.after(() => { reloadCustomers(); fs.rmSync(path.dirname(configPath), { recursive: true, force: true }); });
  reloadCustomers();
  return configPath;
}

test("the shipped example loads with only its actual provider variables set", (t) => {
  const configPath = envFixture(t, { ENV_VAR_NAME: undefined, DEMO_AGENT_CO_OPENAI_KEY: "test-openai", DEMO_AGENT_CO_ANTHROPIC_KEY: "test-anthropic" });
  writeConfig(configPath, fs.readFileSync(new URL("../src/config/customers.example.yaml", import.meta.url), "utf8"));
  const customer = getCustomerByApiKey(configPath, "rw_live_demo_4a21");
  assert.equal(customer.provider_keys.openai, "test-openai");
  assert.equal(customer.provider_keys.anthropic, "test-anthropic");
});

test("comments are ignored while quoted hashes and block strings resolve placeholders", (t) => {
  const configPath = envFixture(t, { RW_CONFIG_VALUE: "resolved", RW_COMMENT_ONLY: undefined });
  writeConfig(configPath, BASE_CONFIG + `
    # \${RW_COMMENT_ONLY}
    description: "# \${RW_CONFIG_VALUE}" # \${RW_COMMENT_ONLY}
    notes: |
      # \${RW_CONFIG_VALUE}
    labels: ["\${RW_CONFIG_VALUE}"]
`);
  const customer = getCustomerByApiKey(configPath, "test_key_1");
  assert.equal(customer.description, "# resolved");
  assert.equal(customer.notes, "# resolved\n");
  assert.deepEqual(customer.labels, ["resolved"]);
});

test("environment values remain literal strings even with YAML syntax and aliases", (t) => {
  const secret = 'quote" # comment\nnew: value\\path';
  const configPath = envFixture(t, { RW_CONFIG_SECRET: secret, RW_CONFIG_BOOL: "false" });
  writeConfig(configPath, `
shared: &provider
  openai: "\${RW_CONFIG_SECRET}"
customers:
  - api_key: test_key
    provider_keys: *provider
    description: \${RW_CONFIG_BOOL}
    literal: "\${RW_CONFIG_SECRET}"
`);
  const customer = getCustomerByApiKey(configPath, "test_key");
  assert.equal(customer.provider_keys.openai, secret);
  assert.equal(customer.literal, secret);
  assert.equal(customer.description, "false");
});

test("all missing value variables are reported without values or comment placeholders", (t) => {
  const configPath = envFixture(t, { RW_MISSING_A: undefined, RW_MISSING_B: undefined, RW_COMMENT_ONLY: undefined });
  writeConfig(configPath, BASE_CONFIG + `
    notes: ["\${RW_MISSING_A}", "\${RW_MISSING_B}", "\${RW_MISSING_A}"] # \${RW_COMMENT_ONLY}
`);
  assert.throws(() => loadCustomers(configPath), { message: "Customer config references undefined environment variable(s): RW_MISSING_A, RW_MISSING_B" });
});
