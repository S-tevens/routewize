import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { validateProviderConfig } from "../providers/config.js";

let cachedConfig = null;
let cachedPath = null;

// Resolve placeholders in parsed string values, so YAML comments are ignored
// and secret values cannot change YAML syntax or scalar types. Mapping keys
// remain literal. Missing variables still fail together before config caching.
function substituteEnvVars(config) {
  const missing = new Set();
  const seen = new WeakSet();
  function resolve(value) {
    if (typeof value === "string") {
      return value.replace(/\$\{([A-Z0-9_]+)\}/g, (match, varName) => {
        const replacement = process.env[varName];
        if (replacement === undefined) {
          missing.add(varName);
          return match;
        }
        return replacement;
      });
    }
    if (value && typeof value === "object" && !seen.has(value)) {
      seen.add(value);
      for (const key of Object.keys(value)) value[key] = resolve(value[key]);
    }
    return value;
  }
  const result = resolve(config);
  if (missing.size > 0) {
    throw new Error(`Customer config references undefined environment variable(s): ${[...missing].join(", ")}`);
  }
  return result;
}

function parseConfigFile(configPath) {
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Customer config not found at ${configPath}. Copy src/config/customers.example.yaml to that path and fill in real provider keys.`
    );
  }

  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = substituteEnvVars(yaml.load(raw));
  const customers = parsed?.customers ?? [];

  const byApiKey = new Map();
  for (const customer of customers) {
    if (!customer.api_key) {
      throw new Error(`Customer "${customer.name ?? "unknown"}" is missing api_key`);
    }
    validateProviderConfig(customer);
    byApiKey.set(customer.api_key, customer);
  }

  return { customers, byApiKey };
}

export function loadCustomers(configPath) {
  if (cachedConfig && cachedPath === configPath) return cachedConfig;

  cachedConfig = parseConfigFile(configPath);
  cachedPath = configPath;
  return cachedConfig;
}

export function getCustomerByApiKey(configPath, apiKey) {
  const { byApiKey } = loadCustomers(configPath);
  return byApiKey.get(apiKey);
}

export function reloadCustomers() {
  cachedConfig = null;
  cachedPath = null;
}

// Watches the config file for changes and hot-reloads it — no server
// restart needed for a routing-rule tweak or a new customer. If the edited
// file fails to parse (bad YAML, missing api_key, unresolved env var), the
// previously loaded good config is kept in place and the error is logged;
// a typo mid-edit never takes the whole proxy down.
export function watchCustomersConfig(configPath) {
  let debounceTimer = null;

  const attemptReload = () => {
    try {
      const next = parseConfigFile(configPath);
      cachedConfig = next;
      cachedPath = configPath;
      console.log(`Customer config reloaded (${next.customers.length} customer(s)).`);
    } catch (err) {
      console.error(`Customer config reload failed, keeping previous config in place: ${err.message}`);
    }
  };

  const dir = path.dirname(configPath);
  const filename = path.basename(configPath);
  const watcher = fs.watch(dir, (eventType, changedFile) => {
    if (changedFile !== filename) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(attemptReload, 150);
  });
  watcher.unref();
  return watcher;
}
