import fs from "node:fs";
import yaml from "js-yaml";

let cachedConfig = null;
let cachedPath = null;

export function loadCustomers(configPath) {
  if (cachedConfig && cachedPath === configPath) return cachedConfig;

  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Customer config not found at ${configPath}. Copy src/config/customers.example.yaml to that path and fill in real provider keys.`
    );
  }

  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = yaml.load(raw);
  const customers = parsed?.customers ?? [];

  const byApiKey = new Map();
  for (const customer of customers) {
    if (!customer.api_key) {
      throw new Error(`Customer "${customer.name ?? "unknown"}" is missing api_key`);
    }
    byApiKey.set(customer.api_key, customer);
  }

  cachedConfig = { customers, byApiKey };
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
