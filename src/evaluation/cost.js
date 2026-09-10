// Rates must be supplied by the customer. Never substitute generic fallback prices.
export function validateRates(rates) {
  if (!rates || !["input", "output", "cached_input"].every((k) => Number.isFinite(rates[k]) && rates[k] >= 0)) {
    throw new Error("Configure input, output and cached_input USD rates per million tokens for each evaluated model");
  }
  if (typeof rates.source !== "string" || !rates.source.trim() || typeof rates.as_of !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(rates.as_of)) throw new Error("Pricing needs a source and as_of date (YYYY-MM-DD)");
  return { input: rates.input, output: rates.output, cached_input: rates.cached_input, source: rates.source, as_of: rates.as_of };
}

export function priceResponse(provider, raw, rates) {
  const u = raw?.usage;
  let input, output, cached;
  if (provider === "openai") {
    input = u?.prompt_tokens;
    output = u?.completion_tokens;
    cached = u?.prompt_tokens_details?.cached_tokens ?? 0;
    // Unknown billable categories must not silently become savings.
    if ((u?.prompt_tokens_details?.audio_tokens ?? 0) > 0 || (u?.completion_tokens_details?.audio_tokens ?? 0) > 0) throw new Error("Audio pricing is unsupported");
  } else if (provider === "anthropic") {
    cached = u?.cache_read_input_tokens ?? 0;
    input = Number.isInteger(u?.input_tokens) ? u.input_tokens + cached : undefined;
    output = u?.output_tokens;
    if ((u?.cache_creation_input_tokens ?? 0) > 0) throw new Error("Cache write pricing is unsupported; cost cannot be established");
  } else throw new Error("Unsupported provider");
  if (![input, output, cached].every((n) => Number.isSafeInteger(n) && n >= 0) || cached > input) throw new Error("Provider token usage is missing or invalid; cost cannot be established");
  const cost = ((input - cached) * rates.input + cached * rates.cached_input + output * rates.output) / 1e6;
  return { input_tokens: input, output_tokens: output, cached_input_tokens: cached, cost_usd: cost };
}
