import { assertProviderRoute, isCompatibleProvider } from "./catalog.js";
import { validateRates } from "../evaluation/cost.js";

export function validateProviderConfig(customer) {
  for (const route of [customer.default, ...(customer.routing?.rules ?? []).map(rule => rule.route_to)]) {
    // Preserve partial configurations used for auth-only customers.
    if (!route) continue;
    assertProviderRoute(route);
    if (isCompatibleProvider(route.provider)) {
      if (typeof customer.provider_keys?.[route.provider] !== "string" || !customer.provider_keys[route.provider].trim()) {
        throw new Error(`Configure provider_keys.${route.provider}`);
      }
      validateRates(customer.evaluation?.pricing?.[`${route.provider}/${route.model}`], route.provider);
    }
  }
}
