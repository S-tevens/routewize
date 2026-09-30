import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { validateChatRequest } from '../src/middleware/requestValidation.js';
import { cachePolicy } from '../src/cache/policy.js';
import { SemanticCache } from '../src/cache/semanticCache.js';
import { authMiddleware } from '../src/middleware/auth.js';
import { reloadCustomers, loadCustomers } from '../src/config/loadConfig.js';
import { createTelemetry } from '../src/operations/telemetry.js';
import { snapshot, restore, retain } from '../src/operations/logMaintenance.js';
import { PersistentUsageGuard } from '../src/middleware/persistentUsageGuard.js';
const hash = s => createHash('sha256').update(s).digest('hex');
const body = { messages: [{ role: 'user', content: 'hello' }] };
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-hardening-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }

test('validation rejects unsupported options and malformed inputs before billing', () => {
  assert.equal(validateChatRequest(body), null);
  for (const value of [null, [], {}, { ...body, max_tokens: -1 }, { ...body, max_tokens: 1.5 }, { ...body, temperature: NaN }, { ...body, stream: 'true' }, { ...body, tools: [] }, { ...body, top_p: 1 }, { ...body, messages: [{ role: 'tool', content: 'x' }] }, { ...body, messages: [{ role: 'user', content: [] }] }, { ...body, rw_cache: { scope: '' } }]) assert.ok(validateChatRequest(value));
});

test('cache scopes isolate tenants, system instructions, versions and routes while preserving near-duplicate hits', () => {
  const customer = { api_key: 'tenant', cache: { enabled: true, require_scope: true } }, route = { provider: 'openai', model: 'model' };
  const request = { ...body, rw_cache: { scope: 'user-1', version: 'docs-1' } };
  const initial = cachePolicy(customer, request, route);
  assert.equal(initial.config.enabled, true);
  assert.equal(cachePolicy(customer, body, route).config.enabled, false);
  assert.equal(cachePolicy(customer, { ...request, rw_cache: { ...request.rw_cache, disabled: true } }, route).config.enabled, false);
  const cache = new SemanticCache();
  cache.store(initial.namespace, { embedding: [1, 0], promptText: 'What is the refund period?', response: { content: '30 days' }, model: 'model', ttlSeconds: 60 });
  const similar = cachePolicy(customer, { ...request, messages: [{ role: 'user', content: 'How long is the refund window?' }] }, route);
  assert.equal(cache.find(similar.namespace, [0.999, 0.001], { similarityThreshold: 0.9 }).hit, true);
  const variants = [
    cachePolicy({ ...customer, api_key: 'other' }, request, route),
    cachePolicy(customer, { ...request, rw_cache: { scope: 'user-2' } }, route),
    cachePolicy(customer, { ...request, rw_cache: { scope: 'user-1', version: 'docs-2' } }, route),
    cachePolicy(customer, { ...request, messages: [{ role: 'system', content: 'Different permission' }, ...request.messages] }, route),
    cachePolicy(customer, request, { ...route, model: 'other' }),
  ];
  for (const policy of variants) assert.equal(cache.find(policy.namespace, [1, 0], { similarityThreshold: 0.9 }).hit, false);
});

test('scoped keys enforce read/inference/evaluation, expiry, revocation and stable tenant identity', t => {
  const dir = temp(t), config = path.join(dir, 'customers.json');
  const credential = (key, scopes, extra = {}) => ({ sha256: hash(key), scopes, expires_at: '2099-01-01T00:00:00Z', ...extra });
  const customer = { name: 'Tenant', api_key: 'legacy', auth: { legacy_key_enabled: false, keys: [credential('reader', ['read']), credential('caller', ['inference']), credential('evaluator', ['evaluation']), credential('expired', ['read'], { expires_at: '2020-01-01' }), credential('revoked', ['read'], { revoked: true })] } };
  fs.writeFileSync(config, JSON.stringify({ customers: [customer] })); reloadCustomers();
  const run = (key, method, url) => {
    let status = 200, passed = false;
    const req = { method, originalUrl: url, get: name => name === 'authorization' ? `Bearer ${key}` : undefined };
    const res = { status(n) { status = n; return this; }, json() {} };
    authMiddleware(config)(req, res, () => { passed = true; });
    return { status, passed, customer: req.customer };
  };
  assert.equal(run('reader', 'GET', '/api/stats').customer.api_key, 'legacy');
  assert.equal(run('reader', 'POST', '/v1/chat/completions').status, 403);
  assert.equal(run('caller', 'POST', '/v1/evaluations').status, 403);
  assert.equal(run('evaluator', 'POST', '/v1/evaluations').passed, true);
  for (const key of ['legacy', 'revoked', 'expired', 'wrong']) assert.equal(run(key, 'GET', '/api/stats').status, 401);
  fs.writeFileSync(config, JSON.stringify({ customers: [customer, { ...customer, api_key: 'different' }] })); reloadCustomers();
  assert.throws(() => loadCustomers(config), /unique/);
});

test('metrics bound path cardinality, do not expose query secrets, and count disconnect only once', () => {
  const metrics = createTelemetry(), res = new EventEmitter();
  res.set = () => {}; res.statusCode = 200; res.writableFinished = false;
  metrics.middleware({ path: '/secret-untrusted-path', originalUrl: '/?api_key=secret' }, res, () => {});
  res.emit('close'); res.emit('finish');
  const text = metrics.render();
  assert.match(text, /route="unmatched",status="499"} 1/);
  assert.doesNotMatch(text, /secret/);
});

test('durable spend and atomic rate counters survive restart and coordinate connections without storing raw keys', t => {
  const file = path.join(temp(t), 'usage.sqlite');
  let a = new PersistentUsageGuard(file), b = new PersistentUsageGuard(file);
  a.recordSpend('secret', 2); b.recordSpend('secret', 3);
  assert.equal(a.checkRateLimit('secret', 1).allowed, true);
  assert.equal(b.checkRateLimit('secret', 1).allowed, false);
  a.close(); b.close(); a = new PersistentUsageGuard(file);
  assert.deepEqual(a.checkSpendCap('secret', 5), { allowed: false, spentToday: 5 });
  assert.equal(a.checkSpendCap('another', 5).allowed, true);
  assert.notEqual(a.db.prepare('SELECT tenant FROM usage LIMIT 1').get().tenant, 'secret');
  a.close();
});

test('offline backup restore verifies checksums; retention previews, preserves unknown dates and removes derived index', t => {
  const dir = temp(t), logs = path.join(dir, 'logs'); fs.mkdirSync(logs);
  const original = [ { timestamp: '2000-01-01', id: 'old' }, { timestamp: new Date().toISOString(), id: 'new' }, { id: 'unknown' } ].map(JSON.stringify).join('\n') + '\n';
  fs.writeFileSync(path.join(logs, 'requests.log'), original);
  const backup = path.join(dir, 'backup'); snapshot(logs, backup);
  const restored = path.join(dir, 'restored'); restore(backup, restored);
  assert.equal(fs.readFileSync(path.join(restored, 'requests.log'), 'utf8'), original);
  assert.throws(() => restore(backup, restored), /EEXIST/);
  assert.equal(retain(logs, 30)[0].removed, 1);
  assert.equal(fs.readFileSync(path.join(logs, 'requests.log'), 'utf8'), original);
  fs.writeFileSync(path.join(logs, 'requests.log.sqlite'), 'derived');
  retain(logs, 30, true);
  assert.equal(fs.existsSync(path.join(logs, 'requests.log.sqlite')), false);
  assert.equal(fs.readFileSync(path.join(logs, 'requests.log'), 'utf8').split('\n').filter(Boolean).length, 2);
  fs.appendFileSync(path.join(backup, 'requests.log'), 'corrupt');
  assert.throws(() => restore(backup, path.join(dir, 'bad')), /checksum/);
});

test('restore retains the durable ledger and rejects malformed retention without rewriting logs', t => {
  const dir = temp(t), logs = path.join(dir, 'logs'); fs.mkdirSync(logs);
  const file = path.join(logs, 'usage.sqlite'), guard = new PersistentUsageGuard(file);
  guard.recordSpend('customer', 9); guard.close();
  fs.writeFileSync(path.join(logs, 'requests.log'), '{broken}\n');
  assert.throws(() => retain(logs, 30, true));
  assert.equal(fs.readFileSync(path.join(logs, 'requests.log'), 'utf8'), '{broken}\n');
  snapshot(logs, path.join(dir, 'backup'));
  restore(path.join(dir, 'backup'), path.join(dir, 'restored'));
  const recovered = new PersistentUsageGuard(path.join(dir, 'restored/usage.sqlite'));
  assert.equal(recovered.checkSpendCap('customer', 9).allowed, false);
  recovered.close();
});
