import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RequestLogStore } from "../src/logging/requestLogStore.js";
import { summarizeFinancials } from "../src/logging/financialOverview.js";
import { createHash } from "node:crypto";

const event = (overrides = {}) => ({ customer: "Acme", timestamp: "2026-09-12T12:00:00Z", estimated_savings: 0.25, ...overrides });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routewize-log-"));
  const log = path.join(dir, "requests.log");
  const store = new RequestLogStore(log);
  const stores = [store];
  t.after(() => { for (const s of stores) if (s.db.open) s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { log, store, reopen: () => { const s = new RequestLogStore(log); stores.push(s); return s; }, write: (events) => fs.writeFileSync(log, events.map(JSON.stringify).join("\n") + "\n"), append: (e) => fs.appendFileSync(log, JSON.stringify(e) + "\n") };
}

test("missing log and unknown customers return the existing empty stats shape", (t) => {
  const { store } = fixture(t);
  assert.deepEqual(store.stats("unknown"), { totalRequests: 0, cacheHits: 0, routedCheaper: 0, flagshipPassthrough: 0, totalSavings: 0, daily: [], recent: [] });
});

test("historical backfill preserves routing, optimization, date ordering and tenant isolation", (t) => {
  const { store, write } = fixture(t);
  const events = [event({ cache_hit: true, optimization: { estimated_tokens_removed: 10, context_documents_selected: 2, context_documents_received: 3 } }), event({ matched_rule: "cheap" }), event({ matched_rule: "forced-flagship" }), event({ matched_rule: "default-fallback", timestamp: "2026-09-11T00:00:00Z", estimated_savings: -0.5 }), event({ customer: "Other", estimated_savings: 100 })];
  write(events);
  assert.deepEqual(store.stats("Acme"), {
    totalRequests: 4, cacheHits: 1, routedCheaper: 1, flagshipPassthrough: 2, totalSavings: 0.25,
    daily: [
      { date: "2026-09-11", requests: 1, savings: -0.5, cacheHits: 0, routedCheaper: 0, flagshipPassthrough: 1, tokensRemoved: 0, documentsSelected: 0, documentsReceived: 0, verificationChecks: 0 },
      { date: "2026-09-12", requests: 3, savings: 0.75, cacheHits: 1, routedCheaper: 1, flagshipPassthrough: 1, tokensRemoved: 10, documentsSelected: 2, documentsReceived: 3, verificationChecks: 0 },
    ], recent: events.slice(0, 4).reverse(),
  });
});

test("background near-miss checks keep their spend but are not counted as requests or flagship traffic", (t) => {
  const { store, write } = fixture(t);
  write([event({ matched_rule: "cheap" }), event({ cache_hit: false, matched_rule: null, estimated_savings: -0.01, cache_verification: { similarity: 0.9, outcome: "not_equivalent" } })]);
  const stats = store.stats("Acme");
  assert.equal(stats.totalRequests, 1);
  assert.equal(stats.routedCheaper, 1);
  assert.equal(stats.flagshipPassthrough, 0);
  assert.equal(stats.totalSavings, 0.24);
  assert.equal(stats.daily[0].verificationChecks, 1);
  assert.equal(stats.recent.length, 1, "recent activity lists only customer requests");
});

test("rollups from an older counting version are rebuilt even when the log is unchanged", (t) => {
  const { store, write, reopen } = fixture(t);
  write([event(), event({ cache_verification: { outcome: "promoted" } })]);
  store.stats("Acme");
  const checkpoint = JSON.parse(store.db.prepare("SELECT data FROM checkpoint").get().data);
  store.db.prepare("UPDATE checkpoint SET data = ?").run(JSON.stringify({ ...checkpoint, version: undefined }));
  store.db.prepare("UPDATE daily SET data = ?").run(JSON.stringify({ requests: 99 }));
  store.close();
  assert.equal(reopen().stats("Acme").totalRequests, 1);
});

test("recent requests use append order and stay capped at 25", (t) => {
  const { store, write } = fixture(t);
  const events = Array.from({ length: 40 }, (_, id) => event({ id, timestamp: id % 2 ? "2026-09-10T00:00:00Z" : "2026-09-12T00:00:00Z" }));
  write(events);
  assert.deepEqual(store.stats("Acme").recent, events.slice(-25).reverse());
});

test("unchanged history reads no log bytes; appends read only the tail and new bytes", (t) => {
  const { store, write, append } = fixture(t);
  write(Array.from({ length: 1000 }, () => event()));
  store.stats("Acme");
  const original = fs.readSync;
  let bytes = 0;
  t.mock.method(fs, "readSync", (...args) => { const n = original(...args); bytes += n; return n; });
  assert.equal(store.stats("Acme").totalRequests, 1000);
  assert.equal(bytes, 0);
  append(event({ id: "new" }));
  assert.equal(store.stats("Acme").totalRequests, 1001);
  assert.ok(bytes < 1024, `only new bytes and checkpoint tails should be read, read ${bytes}`);
});

test("persisted checkpoints survive restarts and concurrent readers do not duplicate events", (t) => {
  const { store, write, append, reopen } = fixture(t);
  write([event()]);
  assert.equal(store.stats("Acme").totalRequests, 1);
  const other = reopen();
  append(event());
  assert.equal(other.stats("Acme").totalRequests, 2);
  assert.equal(store.stats("Acme").totalRequests, 2);
  store.close(); other.close();
  const restored = reopen();
  assert.equal(restored.stats("Acme").totalRequests, 2);
  assert.equal(restored.db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 2);
});

test("malformed and incomplete records do not poison import; split UTF-8 is preserved", (t) => {
  const { store, log } = fixture(t);
  const e = event({ text: "a".repeat(65500) + "🚀 café" });
  const payload = Buffer.from(JSON.stringify(e) + "\n");
  const split = payload.indexOf(Buffer.from("🚀")) + 2;
  fs.writeFileSync(log, 'invalid\nnull\n{}\n');
  fs.appendFileSync(log, payload.subarray(0, split));
  assert.equal(store.stats("Acme").totalRequests, 0);
  fs.appendFileSync(log, payload.subarray(split));
  assert.deepEqual(store.stats("Acme").recent, [e]);
});

test("truncation, same-size replacement, rotation and removal reset stale summaries", (t) => {
  const { store, log, write } = fixture(t);
  write([event(), event()]);
  assert.equal(store.stats("Acme").totalRequests, 2);
  write([event({ customer: "Else" })]);
  assert.equal(store.stats("Acme").totalRequests, 0);
  write([event()]);
  assert.equal(store.stats("Else").totalRequests, 0);
  assert.equal(store.stats("Acme").totalRequests, 1);
  fs.renameSync(log, `${log}.old`);
  write([event({ customer: "Other" })]);
  assert.equal(store.stats("Acme").totalRequests, 0);
  fs.unlinkSync(log);
  assert.equal(store.stats("Other").totalRequests, 0);
});

test("truncate-and-regrow detects a changed checkpoint tail", (t) => {
  const { store, write } = fixture(t);
  write([event()]); store.stats("Acme");
  write([event({ customer: "Other" }), event({ customer: "Other" })]);
  assert.equal(store.stats("Acme").totalRequests, 0);
  assert.equal(store.stats("Other").totalRequests, 2);
});

test("failed import rolls back rows, summaries and checkpoint together", (t) => {
  const { store, write, append } = fixture(t);
  write([event()]); store.stats("Acme");
  append(event()); append(event());
  const ingest = store.ingest.bind(store);
  let calls = 0;
  store.ingest = (line) => { ingest(line); if (++calls === 2) throw new Error("simulated disk failure"); };
  assert.throws(() => store.stats("Acme"), /simulated disk failure/);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 1);
  store.ingest = ingest;
  assert.equal(store.stats("Acme").totalRequests, 3);
});

test("financial query preserves hash precedence, legacy fallback, date bounds and unknown costs", (t) => {
  const { store, write } = fixture(t);
  const customer = { name: "Acme", api_key: "key" };
  const tenant = createHash("sha256").update(customer.api_key).digest("hex");
  const events = [
    event({ customer_sha256: tenant, financials: { provider_spend_usd: 0 } }),
    event({ customer_sha256: "another-tenant", financials: { provider_spend_usd: 999 } }),
    event({ timestamp: "2026-09-11T23:30:00-01:00" }),
    event({ customer: "Renamed", customer_sha256: tenant, financials: { provider_spend_usd: null } }),
    event({ timestamp: "2026-09-10T00:00:00Z" }),
    event({ timestamp: "2026-09-13T00:00:00Z" }),
    event({ timestamp: "invalid" }),
    event({ customer_sha256: 123, financials: { provider_spend_usd: 999 } }),
  ];
  write(events);
  const now = new Date("2026-09-12T18:00:00Z");
  const selected = store.requestsForCustomer(customer.name, tenant, Date.parse("2026-09-12T00:00:00Z"), now.getTime());
  assert.deepEqual(selected, [events[0], events[2], events[3]]);
  assert.deepEqual(summarizeFinancials(selected, [], customer, 1, now), summarizeFinancials(events, [], customer, 1, now));
  assert.equal(store.requestsForCustomer(customer.name, tenant, -Infinity, now.getTime()).length, 4);
});

test("customer and date queries use SQLite indexes", (t) => {
  const { store } = fixture(t);
  for (const [sql, args] of [
    ["SELECT payload FROM events WHERE customer = ? ORDER BY id DESC LIMIT 25", ["Acme"]],
    ["SELECT data FROM daily WHERE customer = ? ORDER BY date", ["Acme"]],
    ["SELECT payload FROM events WHERE tenant = ? AND time >= ? AND time <= ?", ["hash", 0, 100]],
  ]) {
    const plan = store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args);
    assert.ok(plan.some(({ detail }) => /SEARCH .*INDEX/.test(detail)), JSON.stringify(plan));
    assert.ok(plan.every(({ detail }) => !/SCAN/.test(detail)), JSON.stringify(plan));
  }
});
