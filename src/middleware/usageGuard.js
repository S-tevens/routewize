// Per-customer protection against runaway usage: a fast-loop bug firing
// requests rapidly (rate limit) and a leaked/misused key draining spend
// slowly over a day (spend cap). Both are in-memory, per-process, reset on
// restart — matches the rest of the system's current single-process scope
// (see SYSTEM_DESIGN.md §9 for when that stops being good enough).
export class UsageGuard {
  constructor() {
    this.requestWindows = new Map(); // apiKey -> { windowStart, count }
    this.dailySpend = new Map(); // apiKey -> { day, spent }
  }

  // Fixed 60s window per customer. `requestsPerMinute` of 0/null/undefined
  // disables the check entirely for that customer.
  checkRateLimit(apiKey, requestsPerMinute) {
    if (!requestsPerMinute) return { allowed: true };

    const now = Date.now();
    const window = this.requestWindows.get(apiKey);

    if (!window || now - window.windowStart >= 60_000) {
      this.requestWindows.set(apiKey, { windowStart: now, count: 1 });
      return { allowed: true };
    }

    if (window.count >= requestsPerMinute) {
      const retryAfterSeconds = Math.ceil((60_000 - (now - window.windowStart)) / 1000);
      return { allowed: false, retryAfterSeconds };
    }

    window.count += 1;
    return { allowed: true };
  }

  // UTC calendar day. `maxDailySpendUsd` of null/undefined means no cap —
  // this is opt-in per customer, since we can't guess an acceptable spend
  // level without them telling us.
  checkSpendCap(apiKey, maxDailySpendUsd) {
    if (maxDailySpendUsd == null) return { allowed: true, spentToday: 0 };

    const record = this._currentDayRecord(apiKey);
    return { allowed: record.spent < maxDailySpendUsd, spentToday: record.spent };
  }

  // Only call this after a real provider spend (not on cache hits, which
  // cost $0 and should never count against the cap).
  recordSpend(apiKey, amountUsd) {
    if (!amountUsd) return;
    const record = this._currentDayRecord(apiKey);
    record.spent += amountUsd;
    this.dailySpend.set(apiKey, record);
  }

  _currentDayRecord(apiKey) {
    const today = new Date().toISOString().slice(0, 10);
    const existing = this.dailySpend.get(apiKey);
    if (existing && existing.day === today) return existing;
    return { day: today, spent: 0 };
  }
}
