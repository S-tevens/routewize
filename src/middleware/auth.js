import { createHash, timingSafeEqual } from 'node:crypto';
import { loadCustomers } from '../config/loadConfig.js';

const digest = value => createHash('sha256').update(value).digest();
function matches(value, hash) {
  return typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash) && timingSafeEqual(digest(value), Buffer.from(hash, 'hex'));
}
export function authMiddleware(configPath) {
  return (req, res, next) => {
    const header = req.get('authorization') || '';
    const key = header.startsWith('Bearer ') ? header.slice(7).trim() : req.get('x-api-key');
    const deny = () => res.status(401).json({ error: { message: 'Missing, invalid, expired or revoked API key.', type: 'authentication_error' } });
    if (!key) return deny();
    const { customers } = loadCustomers(configPath);
    let customer, credential;
    for (const candidate of customers) {
      if (candidate.auth?.legacy_key_enabled !== false && timingSafeEqual(digest(key), digest(candidate.api_key))) {
        customer = candidate; credential = { scopes: ['read', 'inference', 'evaluation'] }; break;
      }
      const found = candidate.auth?.keys?.find(k => matches(key, k.sha256));
      if (found && !found.revoked && Date.parse(found.expires_at) > Date.now()) {
        customer = candidate; credential = found; break;
      }
    }
    if (!customer) return deny();
    const required = req.method === 'GET' ? 'read' : req.originalUrl.startsWith('/v1/evaluations') ? 'evaluation' : 'inference';
    if (!credential.scopes.includes(required)) return res.status(403).json({ error: { message: 'Credential does not permit this operation.', type: 'permission_error' } });
    req.customer = customer; // Stable tenant identity; credential rotation cannot change cache ownership.
    next();
  };
}
