import { estimateTokens } from "../logging/pricing.js";

// Rules-based routing per the v1 spec: the customer defines the rules, we
// just execute them. No auto quality detection, no ML — first matching rule
// wins, and anything unmatched (or explicitly forced) falls through to the
// customer's flagship default.
export function selectRoute({ customer, promptText, forceFlagship }) {
  if (forceFlagship) {
    return { ...customer.default, matchedRule: "forced-flagship" };
  }

  const rules = customer.routing?.rules ?? [];
  const promptTokens = estimateTokens(promptText);
  const lowerPrompt = promptText.toLowerCase();

  for (const rule of rules) {
    const match = rule.match ?? {};
    let matches = true;

    if (typeof match.max_prompt_tokens === "number" && promptTokens > match.max_prompt_tokens) {
      matches = false;
    }

    if (matches && Array.isArray(match.keywords) && match.keywords.length > 0) {
      const hasKeyword = match.keywords.some((kw) => lowerPrompt.includes(kw.toLowerCase()));
      if (!hasKeyword) matches = false;
    }

    if (matches) {
      return { ...rule.route_to, matchedRule: rule.name ?? "unnamed-rule" };
    }
  }

  return { ...customer.default, matchedRule: "default-fallback" };
}
