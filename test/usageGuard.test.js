import { test } from "node:test";
import assert from "node:assert/strict";
import { UsageGuard } from "../src/middleware/usageGuard.js";

test("rate limit: allows requests up to the limit, then blocks", () => {
  const guard = new UsageGuard();
  for (let i = 0; i < 3; i++) {
    assert.equal(guard.checkRateLimit("cust_1", 3).allowed, true);
  }
  const blocked = guard.checkRateLimit("cust_1", 3);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds > 0 && blocked.retryAfterSeconds <= 60);
});

test("rate limit: 0/null/undefined disables the check entirely", () => {
  const guard = new UsageGuard();
  for (let i = 0; i < 500; i++) {
    assert.equal(guard.checkRateLimit("cust_1", 0).allowed, true);
    assert.equal(guard.checkRateLimit("cust_1", null).allowed, true);
    assert.equal(guard.checkRateLimit("cust_1", undefined).allowed, true);
  }
});

test("rate limit: resets after the 60s window elapses", () => {
  const guard = new UsageGuard();
  guard.checkRateLimit("cust_1", 1);
  assert.equal(guard.checkRateLimit("cust_1", 1).allowed, false);

  // Simulate the window having elapsed instead of sleeping in the test.
  guard.requestWindows.get("cust_1").windowStart = Date.now() - 61_000;
  assert.equal(guard.checkRateLimit("cust_1", 1).allowed, true);
});

test("rate limit: windows are isolated per customer", () => {
  const guard = new UsageGuard();
  guard.checkRateLimit("cust_1", 1);
  assert.equal(guard.checkRateLimit("cust_1", 1).allowed, false);
  assert.equal(guard.checkRateLimit("cust_2", 1).allowed, true, "a different customer's window must be unaffected");
});

test("spend cap: null/undefined means no cap, regardless of spend", () => {
  const guard = new UsageGuard();
  guard.recordSpend("cust_1", 10_000);
  assert.equal(guard.checkSpendCap("cust_1", null).allowed, true);
  assert.equal(guard.checkSpendCap("cust_1", undefined).allowed, true);
});

test("spend cap: blocks once cumulative spend today reaches the cap", () => {
  const guard = new UsageGuard();
  guard.recordSpend("cust_1", 4);
  assert.equal(guard.checkSpendCap("cust_1", 5).allowed, true);
  guard.recordSpend("cust_1", 1);
  const result = guard.checkSpendCap("cust_1", 5);
  assert.equal(result.allowed, false);
  assert.equal(result.spentToday, 5);
});

test("spend cap: a $0 spend (cache hit) never counts against the cap", () => {
  const guard = new UsageGuard();
  guard.recordSpend("cust_1", 0);
  guard.recordSpend("cust_1", null);
  guard.recordSpend("cust_1", undefined);
  assert.equal(guard.checkSpendCap("cust_1", 0.01).spentToday, 0);
});

test("spend cap: tracking is isolated per customer", () => {
  const guard = new UsageGuard();
  guard.recordSpend("cust_1", 100);
  assert.equal(guard.checkSpendCap("cust_2", 5).allowed, true, "a different customer's spend must be unaffected");
});

test("spend cap: resets on a new UTC day", () => {
  const guard = new UsageGuard();
  guard.recordSpend("cust_1", 5);
  assert.equal(guard.checkSpendCap("cust_1", 5).allowed, false);

  // Simulate a day boundary having passed instead of waiting for one.
  guard.dailySpend.get("cust_1").day = "2000-01-01";
  const result = guard.checkSpendCap("cust_1", 5);
  assert.equal(result.allowed, true);
  assert.equal(result.spentToday, 0);
});
