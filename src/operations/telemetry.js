import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
export const requestContext = new AsyncLocalStorage();
const buckets = [0.01, 0.05, 0.1, 0.5, 1, 5, 30, 120, Infinity];
export function createTelemetry() {
  const rows = new Map();
  return {
    middleware(req, res, next) {
      const id = randomUUID(); // Never trust an externally supplied identifier.
      req.requestId = id;
      res.set('X-Request-ID', id);
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Referrer-Policy', 'no-referrer');
      res.set('X-Frame-Options', 'DENY');
      if (!req.path.match(/\.(css|js|png|svg|ico)$/)) res.set('Cache-Control', 'no-store');
      const started = performance.now();
      let counted = false;
      const finish = () => {
        if (counted) return; counted = true;
        const route = typeof req.route?.path === 'string' ? req.route.path : 'unmatched';
        const status = res.writableFinished ? res.statusCode : 499;
        const label = JSON.stringify({ route, status });
        const row = rows.get(label) ?? { route, status, count: 0, seconds: 0, buckets: buckets.map(() => 0) };
        const seconds = (performance.now() - started) / 1000;
        row.count++; row.seconds += seconds;
        buckets.forEach((bound, i) => { if (seconds <= bound) row.buckets[i]++; });
        rows.set(label, row);
      };
      res.once('finish', finish); res.once('close', finish);
      requestContext.run({ request_id: id }, next);
    },
    render() {
      const out = ['# TYPE routewize_requests_total counter', '# TYPE routewize_request_duration_seconds histogram'];
      for (const row of rows.values()) {
        const labels = `route=${JSON.stringify(row.route)},status="${row.status}"`;
        out.push(`routewize_requests_total{${labels}} ${row.count}`);
        row.buckets.forEach((count, i) => out.push(`routewize_request_duration_seconds_bucket{${labels},le="${buckets[i] === Infinity ? '+Inf' : buckets[i]}"} ${count}`));
        out.push(`routewize_request_duration_seconds_sum{${labels}} ${row.seconds}`, `routewize_request_duration_seconds_count{${labels}} ${row.count}`);
      }
      return out.join('\n') + '\n';
    },
  };
}
export function safeError(_error) {
  // Provider errors can contain prompts, keys, URLs or request bodies.
  console.error(JSON.stringify({ event: 'request_error', ...requestContext.getStore(), code: 'upstream_or_internal_error' }));
}
