import { estimateTokens } from "../logging/pricing.js";

// Rules-based routing per the v1 spec: the customer defines the rules, we
// just execute them. No auto quality detection, no ML — first matching rule
// wins, and anything unmatched (or explicitly forced) falls through to the
// customer's flagship default. `why` explains the decision without echoing
// prompt text (only the customer's own configured keywords and numbers).
export function selectRoute({ customer, promptText, forceFlagship }) {
  if (forceFlagship) {
    return { ...customer.default, matchedRule: "forced-flagship", why: ["client forced the flagship model"] };
  }

  const rules = customer.routing?.rules ?? [];
  const promptTokens = estimateTokens(promptText);
  const lowerPrompt = promptText.toLowerCase();

  for (const rule of rules) {
    const match = rule.match ?? {};
    const why = [];
    let matches = true;

    if (typeof match.max_prompt_tokens === "number") {
      if (promptTokens > match.max_prompt_tokens) matches = false;
      else why.push(`~${promptTokens} tokens ≤ ${match.max_prompt_tokens}`);
    }

    if (matches && Array.isArray(match.keywords) && match.keywords.length > 0) {
      const keyword = match.keywords.find((kw) => lowerPrompt.includes(kw.toLowerCase()));
      if (keyword === undefined) matches = false;
      else why.push(`keyword "${keyword}"`);
    }

    if (matches) {
      return { ...rule.route_to, matchedRule: rule.name ?? "unnamed-rule", why };
    }
  }

  return { ...customer.default, matchedRule: "default-fallback", why: [`no routing rule matched (${rules.length} checked)`] };
}
