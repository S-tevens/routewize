import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

let cachedConfig = null;
let cachedPath = null;

// Supports ${ENV_VAR} placeholders anywhere in the YAML text (typically
// provider_keys), so real secrets live in environment variables, never in
// the file itself. Substitution happens on the raw text before parsing, so
// it works regardless of where in the structure a placeholder appears.
// Missing env vars fail loudly (listed together) rather than silently
// substituting an empty string, which would otherwise look like a
// plausible-but-wrong key and fail confusingly later.
function substituteEnvVars(raw) {
  const missing = new Set();
  const result = raw.replace(/\$\{([A-Z0-9_]+)\}/g, (match, varName) => {
    const value = process.env[varName];
    if (value === undefined) {
      missing.add(varName);
      return match;
    }
    return value;
  });
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
  const substituted = substituteEnvVars(raw);
  const parsed = yaml.load(substituted);
  const customers = parsed?.customers ?? [];

  const byApiKey = new Map();
  for (const customer of customers) {
    if (!customer.api_key) {
      throw new Error(`Customer "${customer.name ?? "unknown"}" is missing api_key`);
    }
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
