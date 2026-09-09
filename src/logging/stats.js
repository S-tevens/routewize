import fs from "node:fs";
import { LOG_FILE } from "./logger.js";

// Aggregates the append-only request log into the numbers the dashboard
// shows: same source of truth as the log file itself, just summarized.
export function computeStats(customerName) {
  const empty = { totalRequests: 0, cacheHits: 0, routedCheaper: 0, flagshipPassthrough: 0, totalSavings: 0, daily: [], recent: [] };
  if (!fs.existsSync(LOG_FILE)) return empty;

  const lines = fs.readFileSync(LOG_FILE, "utf8").split("\n").filter(Boolean);
  const events = lines
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((e) => e && e.customer === customerName);

  if (events.length === 0) return empty;

  let cacheHits = 0;
  let routedCheaper = 0;
  let flagshipPassthrough = 0;
  let totalSavings = 0;
  const byDay = new Map(); // "YYYY-MM-DD" -> { requests, savings, cacheHits, routedCheaper, flagshipPassthrough }

  for (const e of events) {
    totalSavings += e.estimated_savings ?? 0;
    const day = e.timestamp.slice(0, 10);
    const bucket = byDay.get(day) ?? { requests: 0, savings: 0, cacheHits: 0, routedCheaper: 0, flagshipPassthrough: 0 };
    bucket.requests += 1;
    bucket.savings += e.estimated_savings ?? 0;

    if (e.cache_hit) {
      cacheHits++;
      bucket.cacheHits++;
    } else if (e.matched_rule && e.matched_rule !== "default-fallback" && e.matched_rule !== "forced-flagship") {
      routedCheaper++;
      bucket.routedCheaper++;
    } else {
      flagshipPassthrough++;
      bucket.flagshipPassthrough++;
    }

    byDay.set(day, bucket);
  }

  const daily = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v }));
  const recent = events.slice(-25).reverse();

  return {
    totalRequests: events.length,
    cacheHits,
    routedCheaper,
    flagshipPassthrough,
    totalSavings,
    daily,
    recent,
  };
}
