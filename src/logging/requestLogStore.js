import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { LOG_FILE } from "./logger.js";

const emptyBucket = () => ({ requests: 0, savings: 0, cacheHits: 0, routedCheaper: 0, flagshipPassthrough: 0, tokensRemoved: 0, documentsSelected: 0, documentsReceived: 0, verificationChecks: 0 });
// Bump when ingest() changes how daily rollups are counted, so existing
// indexes are rebuilt from the authoritative JSONL instead of mixing rules.
const ROLLUP_VERSION = 2;
const number = (value) => typeof value === "number" && Number.isFinite(value) ? value : 0;

// Rebuildable index: the JSONL file remains authoritative, including writes by
// seedDemoLog and other processes. Only newline-terminated records are imported.
export class RequestLogStore {
  constructor(logFile, databaseFile = `${logFile}.sqlite`) {
    this.logFile = logFile;
    fs.mkdirSync(path.dirname(databaseFile), { recursive: true });
    this.db = new Database(databaseFile);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoint (id INTEGER PRIMARY KEY CHECK(id = 1), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY, customer TEXT, tenant TEXT, time REAL, payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_customer ON events(customer, id DESC);
      CREATE INDEX IF NOT EXISTS events_tenant_time ON events(tenant, time);
      CREATE INDEX IF NOT EXISTS events_legacy_time ON events(customer, time) WHERE tenant IS NULL;
      CREATE TABLE IF NOT EXISTS daily (
        customer TEXT NOT NULL, date TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY (customer, date)
      );
    `);
    this.insert = this.db.prepare("INSERT INTO events(customer, tenant, time, payload) VALUES (?, ?, ?, ?)");
    this.getDay = this.db.prepare("SELECT data FROM daily WHERE customer = ? AND date = ?");
    this.putDay = this.db.prepare("INSERT INTO daily VALUES (?, ?, ?) ON CONFLICT(customer, date) DO UPDATE SET data = excluded.data");
    this.refresh = this.db.transaction(() => this.sync()).immediate;
  }

  clear() {
    this.db.exec("DELETE FROM events; DELETE FROM daily; DELETE FROM checkpoint;");
  }

  ingest(line) {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.timestamp !== "string") return;
    const customer = typeof event.customer === "string" ? event.customer : null;
    // A malformed but present identity must never become a legacy name match.
    const tenant = event.customer_sha256 ? (typeof event.customer_sha256 === "string" ? event.customer_sha256 : "invalid-hash") : null;
    const time = Date.parse(event.timestamp);
    this.insert.run(customer, tenant, Number.isFinite(time) ? time : null, line);
    if (customer === null) return;
    const date = event.timestamp.slice(0, 10);
    const existing = this.getDay.get(customer, date);
    const bucket = existing ? JSON.parse(existing.data) : emptyBucket();
    bucket.savings += number(event.estimated_savings);
    // Background near-miss judge calls cost money (counted in savings above)
    // but are not customer requests and never pass through the router.
    if (event.cache_verification) {
      bucket.verificationChecks = number(bucket.verificationChecks) + 1;
      this.putDay.run(customer, date, JSON.stringify(bucket));
      return;
    }
    bucket.requests++;
    bucket.tokensRemoved += number(event.optimization?.estimated_tokens_removed);
    bucket.documentsSelected += number(event.optimization?.context_documents_selected);
    bucket.documentsReceived += number(event.optimization?.context_documents_received);
    if (event.cache_hit) bucket.cacheHits++;
    else if (event.matched_rule && event.matched_rule !== "default-fallback" && event.matched_rule !== "forced-flagship") bucket.routedCheaper++;
    else bucket.flagshipPassthrough++;
    this.putDay.run(customer, date, JSON.stringify(bucket));
  }

  sync() {
    let fd;
    try { fd = fs.openSync(this.logFile, "r"); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.clear();
      return;
    }
    try {
      const stat = fs.fstatSync(fd);
      const row = this.db.prepare("SELECT data FROM checkpoint WHERE id = 1").get();
      let previous = row ? JSON.parse(row.data) : null;
      const identity = `${stat.dev}:${stat.ino}`;
      if (previous && previous.version === ROLLUP_VERSION && previous.identity === identity && previous.size === stat.size && previous.mtime === stat.mtimeMs && previous.ctime === stat.ctimeMs) return;
      // Rotation, truncation, or an in-place rewrite must discard old summaries.
      let reset = previous && (previous.version !== ROLLUP_VERSION || previous.identity !== identity || stat.size <= previous.size);
      if (previous && !reset && previous.offset) {
        const tail = Buffer.alloc(Math.min(previous.offset, 128));
        const read = fs.readSync(fd, tail, 0, tail.length, previous.offset - tail.length);
        reset = read !== tail.length || tail.toString("base64") !== previous.tail;
      }
      if (reset) { this.clear(); previous = null; }
      let offset = previous?.offset ?? 0;
      let position = offset;
      let pending = Buffer.alloc(0);
      const buffer = Buffer.alloc(64 * 1024);
      while (position < stat.size) {
        const read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - position), position);
        if (!read) break;
        position += read;
        const chunk = Buffer.concat([pending, buffer.subarray(0, read)]);
        let start = 0;
        for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
          this.ingest(chunk.subarray(start, end).toString("utf8"));
          offset += end - start + 1;
          start = end + 1;
        }
        pending = Buffer.from(chunk.subarray(start));
      }
      const tail = Buffer.alloc(Math.min(offset, 128));
      fs.readSync(fd, tail, 0, tail.length, offset - tail.length);
      this.db.prepare("INSERT INTO checkpoint VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(JSON.stringify({ version: ROLLUP_VERSION, identity, size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs, offset, tail: tail.toString("base64") }));
    } finally { fs.closeSync(fd); }
  }

  stats(customerName) {
    this.refresh();
    const daily = this.db.prepare("SELECT date, data FROM daily WHERE customer = ? ORDER BY date").all(customerName).map(({ date, data }) => ({ date, ...JSON.parse(data) }));
    const totals = daily.reduce((out, day) => {
      out.totalRequests += day.requests;
      out.cacheHits += day.cacheHits;
      out.routedCheaper += day.routedCheaper;
      out.flagshipPassthrough += day.flagshipPassthrough;
      out.totalSavings += day.savings;
      return out;
    }, { totalRequests: 0, cacheHits: 0, routedCheaper: 0, flagshipPassthrough: 0, totalSavings: 0 });
    const recent = this.db.prepare("SELECT payload FROM events WHERE customer = ? AND json_extract(payload, '$.cache_verification') IS NULL ORDER BY id DESC LIMIT 25").all(customerName).map(({ payload }) => JSON.parse(payload));
    return { ...totals, daily, recent };
  }

  // Hash identity takes precedence; only legacy rows without a hash use names.
  // Epoch bounds preserve financialOverview's handling of timezone offsets.
  requestsForCustomer(customer, tenant, start, end) {
    this.refresh();
    return this.db.prepare(`
      SELECT id, payload FROM events WHERE tenant = ? AND time >= ? AND time <= ?
      UNION ALL
      SELECT id, payload FROM events WHERE tenant IS NULL AND customer = ? AND time >= ? AND time <= ?
      ORDER BY id
    `).all(tenant, start, end, customer, start, end).map(({ payload }) => JSON.parse(payload));
  }

  close() { this.db.close(); }
}

let store;
export function getRequestLogStore() {
  return store ??= new RequestLogStore(LOG_FILE);
}
