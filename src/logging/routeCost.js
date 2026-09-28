import { estimateCost } from "./pricing.js";
import { validateRates } from "../evaluation/cost.js";
import { assertProviderRoute, isCompatibleProvider } from "../providers/catalog.js";

// Existing OpenAI/Anthropic estimates retain their historical behavior.
// New providers MUST have provider-qualified rates, never a generic fallback.
export function estimateRouteCost(customer, route, inputTokens, outputTokens) {
  assertProviderRoute(route);
  if (!isCompatibleProvider(route.provider)) return estimateCost(route.model, inputTokens, outputTokens);
  const rates = validateRates(customer.evaluation?.pricing?.[`${route.provider}/${route.model}`], route.provider);
  if (![inputTokens, outputTokens].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error("Missing usage for cost estimate");
  return (inputTokens * rates.input + outputTokens * rates.output) / 1e6;
}
