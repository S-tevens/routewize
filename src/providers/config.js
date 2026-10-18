import { assertProviderRoute, isCompatibleProvider, providerStatus } from "./catalog.js";
import { validateRates } from "../evaluation/cost.js";

export function validateProviderConfig(customer, env = process.env) {
  for (const route of [customer.default, ...(customer.routing?.rules ?? []).map(rule => rule.route_to)]) {
    // Preserve partial configurations used for auth-only customers.
    if (!route) continue;
    assertProviderRoute(route);
    if (providerStatus(route.provider, env) === "standby") {
      throw new Error(`Provider "${route.provider}" is on standby (built, not live-verified). Verify it with the customer's account, then add "${route.provider}" to ROUTEWIZE_ACTIVATE_PROVIDERS (comma-separated) and restart. See PROVIDERS.md.`);
    }
    if (isCompatibleProvider(route.provider)) {
      if (typeof customer.provider_keys?.[route.provider] !== "string" || !customer.provider_keys[route.provider].trim()) {
        throw new Error(`Configure provider_keys.${route.provider}`);
      }
      validateRates(customer.evaluation?.pricing?.[`${route.provider}/${route.model}`], route.provider);
    }
  }
}
