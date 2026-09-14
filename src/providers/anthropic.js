import Anthropic from "@anthropic-ai/sdk";

// Marks the system prompt as an Anthropic prompt-cache breakpoint: repeated
// calls that send the same system text (the common case — a customer's
// system prompt rarely changes between requests) get that portion billed at
// the cached-read rate instead of full price after the first call writes it.
// Anthropic silently skips caching blocks under its per-model minimum length
// (no error, no cost penalty) — so it's always safe to attach, not gated on
// prompt length or a config flag.
function buildCachedSystem(systemMessages) {
  const text = systemMessages.join("\n");
  if (!text) return undefined;
  return [{ type: "text", text, cache_control: { type: "ephemeral" } }];
}

// Translates an OpenAI-shaped chat request to Anthropic's Messages API and
// back, so the customer always sees an OpenAI-compatible response no matter
// which provider actually served the request.
export async function callAnthropic({ apiKey, model, messages, temperature, max_tokens, timeout = 60000, maxRetries = 2 }) {
  const client = new Anthropic({ apiKey, timeout, maxRetries });

  const systemMessages = messages.filter((m) => m.role === "system").map((m) => m.content);
  const conversation = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));

  const response = await client.messages.create({
    model,
    system: buildCachedSystem(systemMessages),
    messages: conversation,
    max_tokens: max_tokens ?? 1024,
    ...(temperature !== undefined ? { temperature } : {}),
  });

  const content = response.content.map((block) => (block.type === "text" ? block.text : "")).join("");

  return {
    content,
    usage: {
      prompt_tokens: response.usage?.input_tokens ?? 0,
      completion_tokens: response.usage?.output_tokens ?? 0,
    },
    raw: response,
  };
}

const STOP_REASON_TO_FINISH_REASON = {
  end_turn: "stop",
  max_tokens: "length",
  stop_sequence: "stop",
  tool_use: "tool_calls",
};

// Pure translation of one Anthropic Messages-API stream event into an
// OpenAI-shaped `chat.completion.chunk` (or null if that event has nothing
// client-visible to say). Exported and kept side-effect-free so it can be
// unit tested against synthetic event sequences without a real connection.
// `state` is mutated across calls for one stream — caller creates a fresh
// {} per request.
export function translateAnthropicStreamEvent(event, state) {
  const now = () => Math.floor(Date.now() / 1000);

  switch (event.type) {
    case "message_start":
      state.id = event.message.id;
      state.model = event.message.model;
      state.inputTokens = event.message.usage?.input_tokens ?? 0;
      state.cacheReadInputTokens = event.message.usage?.cache_read_input_tokens ?? 0;
      state.cacheCreationInputTokens = event.message.usage?.cache_creation_input_tokens ?? 0;
      state.outputTokens = 0;
      return {
        id: state.id,
        object: "chat.completion.chunk",
        created: now(),
        model: state.model,
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      };

    case "content_block_delta":
      if (event.delta?.type !== "text_delta") return null;
      return {
        id: state.id,
        object: "chat.completion.chunk",
        created: now(),
        model: state.model,
        choices: [{ index: 0, delta: { content: event.delta.text }, finish_reason: null }],
      };

    case "message_delta": {
      state.outputTokens = event.usage?.output_tokens ?? state.outputTokens ?? 0;
      const finishReason = STOP_REASON_TO_FINISH_REASON[event.delta?.stop_reason] ?? "stop";
      return {
        id: state.id,
        object: "chat.completion.chunk",
        created: now(),
        model: state.model,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
        // Matches the non-streaming path's usage shape (prompt_tokens excludes
        // cache tokens) — the full native breakdown for cost evaluation goes
        // through resultSink.raw in streamAnthropic below, not this chunk.
        usage: {
          prompt_tokens: state.inputTokens ?? 0,
          completion_tokens: state.outputTokens ?? 0,
          total_tokens: (state.inputTokens ?? 0) + (state.outputTokens ?? 0),
        },
      };
    }

    // ping, content_block_start/stop, message_stop: nothing client-visible.
    default:
      return null;
  }
}

// Streams OpenAI-shaped chunks translated from Anthropic's native event
// stream. The caller accumulates `choices[0].delta.content` across chunks
// to get the full text, same pattern as reading `.content` off the
// non-streaming result above. `resultSink.raw` carries the *native* Anthropic
// usage shape (separate cache_read/cache_creation fields) before yielding
// the final usage chunk, so priceResponse() can evaluate its cost —
// deliberately not the normalized client-facing usage on the final chunk.
export async function* streamAnthropic({ apiKey, model, messages, temperature, max_tokens, timeout = 60000, maxRetries = 2 }, resultSink = {}) {
  const client = new Anthropic({ apiKey, timeout, maxRetries });

  const systemMessages = messages.filter((m) => m.role === "system").map((m) => m.content);
  const conversation = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));

  const stream = await client.messages.create({
    model,
    system: buildCachedSystem(systemMessages),
    messages: conversation,
    max_tokens: max_tokens ?? 1024,
    stream: true,
    ...(temperature !== undefined ? { temperature } : {}),
  });

  const state = {};
  for await (const event of stream) {
    const chunk = translateAnthropicStreamEvent(event, state);
    if (chunk?.usage) {
      // The proxy prices/logs this chunk before requesting the next one.
      // Publish native usage first so configured rates can price the stream.
      resultSink.raw = {
        usage: {
          input_tokens: state.inputTokens ?? 0,
          output_tokens: state.outputTokens ?? 0,
          cache_read_input_tokens: state.cacheReadInputTokens ?? 0,
          cache_creation_input_tokens: state.cacheCreationInputTokens ?? 0,
        },
      };
    }
    if (chunk) yield chunk;
  }
}
