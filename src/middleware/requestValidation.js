// This gateway supports text chat only. Reject options we would silently drop.
export function validateChatRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Request body must be an object';
  const supported = new Set(['messages', 'model', 'temperature', 'max_tokens', 'stream', 'stream_options', 'force_flagship', 'rw_optimization', 'rw_cache']);
  for (const key of Object.keys(body)) if (!supported.has(key)) return `Unsupported option: ${key}`;
  if (!Array.isArray(body.messages) || !body.messages.length) return 'messages must be a nonempty array';
  for (const message of body.messages) {
    if (!message || !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string') return 'Each message must have a supported role and text content';
    if (Object.keys(message).some(key => !['role', 'content'].includes(key))) return 'Unsupported message field';
  }
  if (body.model !== undefined && (typeof body.model !== 'string' || !body.model.trim())) return 'model must be a nonempty string';
  if (body.max_tokens !== undefined && (!Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1)) return 'max_tokens must be a positive integer';
  if (body.temperature !== undefined && (!Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2)) return 'temperature must be between 0 and 2';
  for (const key of ['stream', 'force_flagship']) if (body[key] !== undefined && typeof body[key] !== 'boolean') return `${key} must be boolean`;
  if (body.stream_options !== undefined && (!body.stream || !body.stream_options || typeof body.stream_options !== 'object' || Array.isArray(body.stream_options) || Object.keys(body.stream_options).some(k => k !== 'include_usage') || typeof body.stream_options.include_usage !== 'boolean')) return 'Only stream_options.include_usage is supported for streaming';
  const cache = body.rw_cache;
  if (cache !== undefined) {
    if (!cache || typeof cache !== 'object' || Array.isArray(cache) || Object.keys(cache).some(k => !['disabled', 'scope', 'version'].includes(k))) return 'Invalid rw_cache options';
    if (cache.disabled !== undefined && typeof cache.disabled !== 'boolean') return 'rw_cache.disabled must be boolean';
    for (const key of ['scope', 'version']) if (cache[key] !== undefined && (typeof cache[key] !== 'string' || !cache[key].trim() || cache[key].length > 256)) return `rw_cache.${key} must be a nonempty string of at most 256 characters`;
  }
  return null;
}
