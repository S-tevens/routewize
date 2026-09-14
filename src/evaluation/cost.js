// Rates must be supplied by the customer. Never substitute generic fallback prices.
// Anthropic additionally needs cache_write_input: writing a new prompt-cache
// entry (buildCachedSystem() in providers/anthropic.js) is billed at a
// provider-set premium over plain input, never the cached-read discount.
// OpenAI's automatic prompt caching has no separate write price, so it isn't
// required there.
export function validateRates(rates, provider) {
  const required = provider === "anthropic" ? ["input", "output", "cached_input", "cache_write_input"] : ["input", "output", "cached_input"];
  if (!rates || !required.every((k) => Number.isFinite(rates[k]) && rates[k] >= 0)) {
    throw new Error(`Configure ${required.join(", ")} USD rates per million tokens for each evaluated model`);
  }
  if (typeof rates.source !== "string" || !rates.source.trim() || typeof rates.as_of !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(rates.as_of)) throw new Error("Pricing needs a source and as_of date (YYYY-MM-DD)");
  const validated = { input: rates.input, output: rates.output, cached_input: rates.cached_input, source: rates.source, as_of: rates.as_of };
  if (provider === "anthropic") validated.cache_write_input = rates.cache_write_input;
  return validated;
}

export function priceResponse(provider, raw, rates) {
  const u = raw?.usage;
  let input, output, cached, cacheWrite = 0;
  if (provider === "openai") {
    input = u?.prompt_tokens;
    output = u?.completion_tokens;
    cached = u?.prompt_tokens_details?.cached_tokens ?? 0;
    // Unknown billable categories must not silently become savings.
    if ((u?.prompt_tokens_details?.audio_tokens ?? 0) > 0 || (u?.completion_tokens_details?.audio_tokens ?? 0) > 0) throw new Error("Audio pricing is unsupported");
  } else if (provider === "anthropic") {
    cached = u?.cache_read_input_tokens ?? 0;
    cacheWrite = u?.cache_creation_input_tokens ?? 0;
    input = Number.isInteger(u?.input_tokens) ? u.input_tokens + cached : undefined;
    output = u?.output_tokens;
  } else throw new Error("Unsupported provider");
  if (![input, output, cached, cacheWrite].every((n) => Number.isSafeInteger(n) && n >= 0) || cached > input) throw new Error("Provider token usage is missing or invalid; cost cannot be established");
  if (cacheWrite > 0 && !Number.isFinite(rates.cache_write_input)) throw new Error("Cache write rate is not configured; cost cannot be established");
  const cost = ((input - cached) * rates.input + cached * rates.cached_input + cacheWrite * (rates.cache_write_input ?? 0) + output * rates.output) / 1e6;
  return { input_tokens: input, output_tokens: output, cached_input_tokens: cached, cache_write_input_tokens: cacheWrite, cost_usd: cost };
}
