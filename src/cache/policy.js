import { createHash } from 'node:crypto';

// Scope/version must be assigned by the customer's trusted backend, never an
// untrusted browser. They supplement (and cannot override) tenant isolation.
export function cachePolicy(customer, request, route) {
  const config = customer.cache ?? { enabled: false };
  const options = request.rw_cache ?? {};
  const enabled = config.enabled === true && options.disabled !== true && request.force_flagship !== true && (!config.require_scope || Boolean(options.scope));
  const namespace = createHash('sha256').update(JSON.stringify({
    customer: customer.api_key, model: request.model ?? null,
    temperature: request.temperature ?? null, max_tokens: request.max_tokens ?? null,
    route: { provider: route.provider, model: route.model },
    scope: options.scope ?? null, version: options.version ?? null,
    // System instructions are an authorization/behavior boundary, not fuzzy text.
    system: request.messages.filter(m => m.role === 'system').map(m => m.content),
  })).digest('hex');
  return { config: { ...config, enabled }, namespace };
}
