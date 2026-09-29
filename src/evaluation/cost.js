import { isCompatibleProvider } from "../providers/catalog.js";

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
  if (provider === "openai" || isCompatibleProvider(provider)) {
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
  if (provider === "openrouter") {
    if (!Number.isFinite(u?.cost) || u.cost < 0) throw new Error("OpenRouter reported cost is missing or invalid");
    return { input_tokens: input, output_tokens: output, cached_input_tokens: cached, cache_write_input_tokens: 0, cost_usd: u.cost };
  }
  if (isCompatibleProvider(provider) && ((u?.prompt_tokens_details?.cache_write_tokens ?? 0) > 0 || (u?.cache_creation_input_tokens ?? 0) > 0)) throw new Error("Provider cache-write pricing is unsupported");
  const cost = ((input - cached) * rates.input + cached * rates.cached_input + cacheWrite * (rates.cache_write_input ?? 0) + output * rates.output) / 1e6;
  return { input_tokens: input, output_tokens: output, cached_input_tokens: cached, cache_write_input_tokens: cacheWrite, cost_usd: cost };
}

// Net effect of provider-native prompt caching on this one call, in USD —
// separate from priceResponse()'s total cost so the customer-facing savings
// breakdown can show "prompt caching" as its own line item rather than
// folding it into routing/cache savings. A cache *write* costs more than
// plain input (a real, temporary cost), so this can be negative on the call
// that creates a cache entry and positive on later calls that read it — that
// asymmetry is real and should be shown, not hidden. Returns null (not 0)
// when the rate needed to compute it isn't configured, matching this
// module's fail-closed convention: unknown is never displayed as zero.
export function promptCacheSavings(provider, raw, rates) {
  const u = raw?.usage;
  if (provider === "openrouter") return null; // Aggregated billing is not a per-mechanism savings proof.
  if (provider === "openai" || isCompatibleProvider(provider)) {
    const cached = u?.prompt_tokens_details?.cached_tokens ?? 0;
    if (!Number.isFinite(rates?.cached_input) || !Number.isFinite(rates?.input)) return null;
    return (cached * (rates.input - rates.cached_input)) / 1e6;
  }
  if (provider === "anthropic") {
    const cached = u?.cache_read_input_tokens ?? 0;
    const written = u?.cache_creation_input_tokens ?? 0;
    if (![rates?.cached_input, rates?.cache_write_input, rates?.input].every(Number.isFinite)) return null;
    return (cached * (rates.input - rates.cached_input) - written * (rates.cache_write_input - rates.input)) / 1e6;
  }
  return null;
}
