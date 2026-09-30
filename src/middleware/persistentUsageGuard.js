import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
const tenant = key => createHash('sha256').update(key).digest('hex');
// Durable accounting and atomic rate windows on ONE host/local disk. This is
// not a hard spend reservation system; concurrent in-flight spend can exceed
// the daily threshold and unknown provider/embedding charges remain uncounted.
export class PersistentUsageGuard {
  constructor(file) {
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec('CREATE TABLE IF NOT EXISTS usage (tenant TEXT PRIMARY KEY, day TEXT NOT NULL, spent REAL NOT NULL, window INTEGER NOT NULL, count INTEGER NOT NULL)');
    this.get = this.db.prepare('SELECT * FROM usage WHERE tenant = ?');
    this.put = this.db.prepare('INSERT INTO usage VALUES (@tenant, @day, @spent, @window, @count) ON CONFLICT(tenant) DO UPDATE SET day=excluded.day, spent=excluded.spent, window=excluded.window, count=excluded.count');
    this.change = this.db.transaction((key, fn) => {
      const now = Date.now(), day = new Date(now).toISOString().slice(0, 10), id = tenant(key);
      const row = this.get.get(id) ?? { tenant: id, day, spent: 0, window: now, count: 0 };
      if (row.day !== day) { row.day = day; row.spent = 0; }
      if (now - row.window >= 60000) { row.window = now; row.count = 0; }
      const result = fn(row, now);
      this.put.run(row);
      return result;
    }).immediate;
  }
  checkRateLimit(key, limit) {
    if (!limit) return { allowed: true };
    return this.change(key, (row, now) => {
      if (row.count >= limit) return { allowed: false, retryAfterSeconds: Math.ceil((60000 - (now - row.window)) / 1000) };
      row.count++; return { allowed: true };
    });
  }
  checkSpendCap(key, cap) {
    if (cap == null) return { allowed: true, spentToday: 0 };
    return this.change(key, row => ({ allowed: row.spent < cap, spentToday: row.spent }));
  }
  recordSpend(key, amount) {
    if (amount == null || amount === 0) return;
    if (!Number.isFinite(amount) || amount < 0) throw new Error('Spend must be finite and nonnegative');
    this.change(key, row => { row.spent += amount; });
  }
  close() { this.db.close(); }
}
