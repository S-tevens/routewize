import OpenAI from "openai";
import { COMPATIBLE_PROVIDERS, isCompatibleProvider } from "./catalog.js";

export function normalizeUsage(provider, raw) {
  const usage = raw?.usage ?? (provider === "groq" ? raw?.x_groq?.usage : undefined);
  if (![usage?.prompt_tokens, usage?.completion_tokens].every(n => Number.isSafeInteger(n) && n >= 0)) {
    throw new Error("Provider token usage is missing or invalid");
  }
  const cached = usage.prompt_tokens_details?.cached_tokens ?? (provider === "deepseek" ? usage.prompt_cache_hit_tokens : undefined) ?? 0;
  if (!Number.isSafeInteger(cached) || cached < 0 || cached > usage.prompt_tokens) throw new Error("Invalid cached token usage");
  if (provider === "deepseek" && usage.prompt_cache_miss_tokens !== undefined &&
      usage.prompt_cache_miss_tokens + cached !== usage.prompt_tokens) throw new Error("Inconsistent DeepSeek cache usage");
  return { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens,
    prompt_tokens_details: { ...usage.prompt_tokens_details, cached_tokens: cached } };
}

function requestBody(args) {
  const { model, messages, temperature, max_tokens } = args;
  return { model, messages, ...(temperature !== undefined ? { temperature } : {}), ...(max_tokens !== undefined ? { max_tokens } : {}) };
}

function clientFor(provider, { apiKey, timeout = 60000, maxRetries = 2 }, fetchImpl) {
  if (!isCompatibleProvider(provider)) throw new Error("Unsupported compatible provider");
  if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error("Provider key is missing");
  return new OpenAI({ apiKey, timeout, maxRetries, baseURL: COMPATIBLE_PROVIDERS[provider].baseURL,
    // Do not forward a customer's credential through an HTTP redirect.
    fetch: (url, options) => (fetchImpl ?? fetch)(url, { ...options, redirect: "error" }) });
}

export async function callCompatible(provider, args, { fetchImpl } = {}) {
  const raw = await clientFor(provider, args, fetchImpl).chat.completions.create(requestBody(args));
  const content = raw.choices?.[0]?.message?.content;
  if (typeof content !== "string" || (raw.choices?.[0]?.message?.tool_calls?.length ?? 0) > 0) throw new Error("Provider did not return supported text content");
  if (raw.choices?.[0]?.finish_reason !== "stop") throw new Error("Provider response is incomplete or unsupported");
  const usage = normalizeUsage(provider, raw);
  return { content, usage, raw: { ...raw, usage } };
}

export async function* streamCompatible(provider, args, resultSink = {}, { fetchImpl } = {}) {
  const client = clientFor(provider, args, fetchImpl);
  const stream = await client.chat.completions.create({ ...requestBody(args), stream: true,
    ...(COMPATIBLE_PROVIDERS[provider].streamUsage ? { stream_options: { include_usage: true } } : {}) });
  let usageRaw, last, finish;
  try {
    for await (const chunk of stream) {
      if (chunk.error) throw new Error("Provider stream failed");
      if (chunk.choices?.some(c => (c.delta?.tool_calls?.length ?? 0) > 0)) throw new Error("Tool calls are unsupported");
      last = chunk;
      if (chunk.usage || (provider === "groq" && chunk.x_groq?.usage)) usageRaw = chunk;
      if (chunk.choices?.[0]?.finish_reason) finish = chunk.choices[0].finish_reason;
      // Some providers repeat cumulative usage. Emit exactly one final usage
      // chunk to prevent duplicate cache writes, spend records, and log events.
      const { usage, x_groq, ...out } = chunk;
      if (out.choices?.length) yield out;
    }
    if (finish !== "stop") throw new Error("Provider stream ended without a successful finish reason");
    const usage = normalizeUsage(provider, usageRaw);
    resultSink.raw = { ...usageRaw, usage };
    yield { id: last.id, object: "chat.completion.chunk", created: last.created,
      model: last.model ?? args.model, choices: [], usage };
  } finally {
    stream.controller?.abort();
  }
}
