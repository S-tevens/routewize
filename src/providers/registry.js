import { callOpenAI, streamOpenAI } from "./openai.js";
import { callAnthropic, streamAnthropic } from "./anthropic.js";
import { callCompatible, streamCompatible } from "./compatible.js";
import { PROVIDER_IDS, assertProviderRoute } from "./catalog.js";

export function callProvider(provider, args) {
  assertProviderRoute({ provider, model: args.model });
  if (provider === "openai") return callOpenAI(args);
  if (provider === "anthropic") return callAnthropic(args);
  return callCompatible(provider, args);
}
export function streamProvider(provider, args, resultSink) {
  assertProviderRoute({ provider, model: args.model });
  if (provider === "openai") return streamOpenAI(args, resultSink);
  if (provider === "anthropic") return streamAnthropic(args, resultSink);
  return streamCompatible(provider, args, resultSink);
}
export const evaluationProviders = Object.fromEntries(PROVIDER_IDS.map(provider => [provider, args => callProvider(provider, args)]));
