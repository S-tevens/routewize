import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { loadCustomers } from '../src/config/loadConfig.js';
import { validateRates } from '../src/evaluation/cost.js';
const failures = [];
const configPath = path.resolve(process.env.CUSTOMERS_CONFIG || 'src/config/customers.yaml');
try {
  const { customers } = loadCustomers(configPath);
  if (!customers.length) failures.push('No customers configured');
  customers.forEach((c, i) => {
    const label = `Customer ${i + 1}`;
    if (c.auth?.legacy_key_enabled !== false) failures.push(`${label}: disable legacy full-access key and provision scoped credentials`);
    if (!(c.auth?.keys ?? []).some(k => !k.revoked && Date.parse(k.expires_at) > Date.now())) failures.push(`${label}: no active scoped credentials`);
    if (!c.provider_keys?.[c.default?.provider]) failures.push(`${label}: default provider key missing`);
    if (c.cache?.enabled && !c.cache.require_scope) failures.push(`${label}: caching is not restricted to a caller scope`);
    for (const [model, rates] of Object.entries(c.evaluation?.pricing ?? {})) {
      try { validateRates(rates, model.split('/')[0]); } catch { failures.push(`${label}: invalid configured pricing for ${model}`); }
    }
    if (c.cache?.enabled && !c.provider_keys?.openai) failures.push(`${label}: OpenAI embedding key missing`);
  });
} catch { failures.push('Customer config missing or invalid; check YAML, environment references, duplicate identities and credential configuration'); }
try { fs.accessSync(path.resolve('logs'), fs.constants.W_OK); } catch { failures.push('logs directory missing or not writable'); }
if (!process.env.ADMIN_TOKEN || process.env.ADMIN_TOKEN.length < 32) failures.push('ADMIN_TOKEN must be a distinct randomly generated secret of at least 32 characters');
if ((process.env.EMBEDDING_PROVIDER || 'openai') !== 'openai') failures.push('Mock embeddings are not suitable for production');
console.log(JSON.stringify({ ok: !failures.length, offline_only: true, checks: failures }, null, 2));
process.exitCode = failures.length ? 1 : 0;
