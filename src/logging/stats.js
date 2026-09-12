import { getRequestLogStore } from "./requestLogStore.js";

// Daily rollups and the latest 25 events are indexed by customer. New JSONL
// bytes are imported once; unchanged history is never scanned per request.
export function computeStats(customerName) {
  return getRequestLogStore().stats(customerName);
}
