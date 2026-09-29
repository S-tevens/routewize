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

export function assertProviderRoute(route) {
  if (!isSupportedProvider(route?.provider)) throw new Error("Unsupported provider in configured route");
  if (typeof route.model !== "string" || !route.model.trim()) throw new Error("Configured route requires a model ID");
}
