import OpenAI from "openai";

// Straight passthrough — the customer's request is already OpenAI-shaped.
export async function callOpenAI({ apiKey, model, messages, temperature, max_tokens, timeout = 60000, maxRetries = 2, signal }) {
  const client = new OpenAI({ apiKey, timeout, maxRetries });
  const completion = await client.chat.completions.create({
    model,
    messages,
    ...(temperature !== undefined ? { temperature } : {}),
    ...(max_tokens !== undefined ? { max_tokens } : {}),
  }, { signal });

  return {
    content: completion.choices[0].message.content,
    usage: {
      prompt_tokens: completion.usage?.prompt_tokens ?? 0,
      completion_tokens: completion.usage?.completion_tokens ?? 0,
    },
    raw: completion,
  };
}

// Streams chunks in OpenAI's own `chat.completion.chunk` shape — since the
// customer's request is already OpenAI-shaped, chunks need no translation,
// just direct passthrough. `stream_options.include_usage` puts a final
// `usage` field (with the same shape `priceResponse()` expects) on the last
// chunk before [DONE], which `resultSink.raw` captures for the caller —
// the caller accumulates `choices[0].delta.content` across chunks itself,
// same pattern as reading `.content` off the non-streaming result above.
export async function* streamOpenAI({ apiKey, model, messages, temperature, max_tokens, timeout = 60000, maxRetries = 2, signal }, resultSink = {}) {
  const client = new OpenAI({ apiKey, timeout, maxRetries });
  const stream = await client.chat.completions.create({
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(temperature !== undefined ? { temperature } : {}),
    ...(max_tokens !== undefined ? { max_tokens } : {}),
  }, { signal });

  for await (const chunk of stream) {
    if (chunk.usage) resultSink.raw = chunk;
    yield chunk;
  }
}
