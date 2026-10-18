// Fixed destinations: a request/config cannot redirect another provider's key.
// These profiles cover text chat only, not every feature offered by each API.
export const COMPATIBLE_PROVIDERS = Object.freeze({
  gemini: Object.freeze({ baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", streamUsage: true }),
  openrouter: Object.freeze({ baseURL: "https://openrouter.ai/api/v1", streamUsage: true }),
  groq: Object.freeze({ baseURL: "https://api.groq.com/openai/v1", streamUsage: true }),
  mistral: Object.freeze({ baseURL: "https://api.mistral.ai/v1", streamUsage: false }),
  deepseek: Object.freeze({ baseURL: "https://api.deepseek.com/v1", streamUsage: true }),
  together: Object.freeze({ baseURL: "https://api.together.ai/v1", streamUsage: true }),
  fireworks: Object.freeze({ baseURL: "https://api.fireworks.ai/inference/v1", streamUsage: true }),
  xai: Object.freeze({ baseURL: "https://api.x.ai/v1", streamUsage: true }),
  cerebras: Object.freeze({ baseURL: "https://api.cerebras.ai/v1", streamUsage: false }),
});
export const PROVIDER_IDS = Object.freeze(["openai", "anthropic", ...Object.keys(COMPATIBLE_PROVIDERS)]);
export const isCompatibleProvider = provider => Object.hasOwn(COMPATIBLE_PROVIDERS, provider);
export const isSupportedProvider = provider => PROVIDER_IDS.includes(provider);

// Team decision 2026-09-29: only OpenAI and Anthropic are live offerings. The compatible
// adapters are on standby (built and offline-tested, never live-verified) and cannot be
// routed to until an operator activates them for a customer who asks, e.g.
// ROUTEWIZE_ACTIVATE_PROVIDERS=groq,deepseek (read at config load; restart to change).
export const LIVE_PROVIDERS = Object.freeze(["openai", "anthropic"]);
const activationEntries = (env) =>
  (env.ROUTEWIZE_ACTIVATE_PROVIDERS ?? "").split(",").map(p => p.trim().toLowerCase()).filter(Boolean);
export const activatedProviders = (env = process.env) => new Set(activationEntries(env).filter(isCompatibleProvider));
// Entries that activate nothing (typos, already-live or unknown IDs), so
// startup can say why a provider the operator listed is still on standby.
export const ignoredActivations = (env = process.env) =>
  activationEntries(env).filter(p => !isCompatibleProvider(p));
export function providerStatus(provider, env = process.env) {
  if (LIVE_PROVIDERS.includes(provider)) return "live";
  if (!isCompatibleProvider(provider)) return "unsupported";
  return activatedProviders(env).has(provider) ? "activated" : "standby";
}

export function assertProviderRoute(route) {
  if (!isSupportedProvider(route?.provider)) throw new Error("Unsupported provider in configured route");
  if (typeof route.model !== "string" || !route.model.trim()) throw new Error("Configured route requires a model ID");
}
