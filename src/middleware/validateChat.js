const allowed = new Set(["messages", "model", "temperature", "max_tokens", "stream", "force_flagship", "rw_optimization"]);

export function validateChat(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Request body must be an object");
  for (const key of Object.keys(body)) if (!allowed.has(key)) throw new Error(`Unsupported option: ${key}`);
  if (!Array.isArray(body.messages) || body.messages.length === 0) throw new Error("messages must be a non-empty array");
  for (const message of body.messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("Each message must be an object");
    if (!["system", "user", "assistant"].includes(message.role)) throw new Error("Message role must be system, user or assistant");
    if (typeof message.content !== "string") throw new Error("Message content must be a string; multimodal content is not supported");
    if (Object.keys(message).some(key => !["role", "content"].includes(key))) throw new Error("Unsupported message field");
  }
  if (body.model !== undefined && (typeof body.model !== "string" || !body.model.trim())) throw new Error("model must be a non-empty string");
  if (body.max_tokens !== undefined && (!Number.isSafeInteger(body.max_tokens) || body.max_tokens <= 0)) throw new Error("max_tokens must be a positive safe integer");
  if (body.temperature !== undefined && (typeof body.temperature !== "number" || !Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2)) throw new Error("temperature must be between 0 and 2");
  for (const key of ["stream", "force_flagship"]) if (body[key] !== undefined && typeof body[key] !== "boolean") throw new Error(`${key} must be a boolean`);
}
