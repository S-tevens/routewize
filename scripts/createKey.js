import { randomBytes, createHash } from 'node:crypto';
const key = `rw_${randomBytes(32).toString('base64url')}`;
console.log(JSON.stringify({ key, sha256: createHash('sha256').update(key).digest('hex'), expires_at: new Date(Date.now() + 90 * 86400000).toISOString(), scopes: ['read'] }, null, 2));
