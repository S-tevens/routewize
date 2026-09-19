// Fields this endpoint actually reads and acts on.
const actedOn = new Set(["messages", "model", "temperature", "max_tokens", "stream", "force_flagship", "rw_optimization"]);

// Standard OpenAI chat.completions fields that real clients (the OpenAI
// SDK, LangChain, LlamaIndex, etc.) commonly send even when unused. This
// endpoint doesn't forward them to the provider today, but rejecting them
// would break "same code, just change the base URL" for any customer whose
// existing integration sets one of these -- accepted and silently ignored,
// not wired through. Add wiring here (not a broader allowlist) if/when one
// of these needs real support.
const acceptedButIgnored = new Set(["top_p", "presence_penalty", "frequency_penalty", "stop", "user", "seed", "n", "logprobs", "top_logprobs", "stream_options", "logit_bias"]);

const allowed = new Set([...actedOn, ...acceptedButIgnored]);

// Explicitly unsupported, named individually for a clearer error than a
// generic "Unsupported option" -- these are real OpenAI features this
// endpoint has never implemented, not a client mistake.
const explicitlyUnsupported = new Set(["tools", "tool_choice", "functions", "function_call", "response_format"]);

export function validateChat(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Request body must be an object");
  for (const key of Object.keys(body)) {
    if (explicitlyUnsupported.has(key)) throw new Error("tools and response_format are not supported by this endpoint yet");
    if (!allowed.has(key)) throw new Error(`Unsupported option: ${key}`);
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) throw new Error("messages must be a non-empty array");
  for (const message of body.messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("Each message must be an object");
    if (!["system", "user", "assistant"].includes(message.role)) throw new Error("Message role must be system, user or assistant");
    if (typeof message.content !== "string") throw new Error("Message content must be a string; multimodal content is not supported");
    // "name" is a standard OpenAI message field (participant disambiguation).
    // Passed through as-is to OpenAI; Anthropic's own request-shaping already
    // drops any field besides role/content, so it's harmless there too.
    if (Object.keys(message).some(key => !["role", "content", "name"].includes(key))) throw new Error("Unsupported message field");
    if (message.name !== undefined && typeof message.name !== "string") throw new Error("Message name must be a string");
  }
  if (body.model !== undefined && (typeof body.model !== "string" || !body.model.trim())) throw new Error("model must be a non-empty string");
  if (body.max_tokens !== undefined && (!Number.isSafeInteger(body.max_tokens) || body.max_tokens <= 0)) throw new Error("max_tokens must be a positive safe integer");
  if (body.temperature !== undefined && (typeof body.temperature !== "number" || !Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2)) throw new Error("temperature must be between 0 and 2");
  for (const key of ["stream", "force_flagship"]) if (body[key] !== undefined && typeof body[key] !== "boolean") throw new Error(`${key} must be a boolean`);
}
