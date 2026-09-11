import { cosineSimilarity } from "./embeddings.js";

// In-memory per-customer vector store. Good enough to prove out the router
// end-to-end; swap for Redis + pgvector/Qdrant when it needs to survive
// restarts or scale past one process (see README).
export class SemanticCache {
  constructor({ maxEntries = 1000 } = {}) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error("maxEntries must be a positive integer");
    this.maxEntries = maxEntries;
    this.entriesByCustomer = new Map();
  }

  _entriesFor(customerApiKey) {
    if (!this.entriesByCustomer.has(customerApiKey)) {
      this.entriesByCustomer.set(customerApiKey, []);
    }
    return this.entriesByCustomer.get(customerApiKey);
  }

  _isFresh(entry, now) {
    return now - entry.storedAt < entry.ttlSeconds * 1000;
  }

  find(customerApiKey, embedding, { similarityThreshold, ttlSeconds }) {
    const now = Date.now();
    const entries = this.entriesByCustomer.get(customerApiKey) ?? [];

    let best = null;
    let bestSimilarity = -1;

    for (const entry of entries) {
      if (!this._isFresh(entry, now)) continue;
      const similarity = cosineSimilarity(embedding, entry.embedding);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        best = entry;
      }
    }

    if (best && bestSimilarity >= similarityThreshold) {
      return { hit: true, similarity: bestSimilarity, entry: best };
    }
    return { hit: false, similarity: bestSimilarity };
  }

  store(customerApiKey, { embedding, promptText, response, model, ttlSeconds }) {
    this.prune();
    while ([...this.entriesByCustomer.values()].reduce((n, e) => n + e.length, 0) >= this.maxEntries) {
      const key = this.entriesByCustomer.keys().next().value;
      const bucket = this.entriesByCustomer.get(key);
      bucket.shift();
      if (!bucket.length) this.entriesByCustomer.delete(key);
    }
    const entries = this._entriesFor(customerApiKey);
    entries.push({ embedding, promptText, response, model, storedAt: Date.now(), ttlSeconds });
  }

  // Drops expired entries so long-running processes don't leak memory.
  prune() {
    const now = Date.now();
    for (const [key, entries] of this.entriesByCustomer) {
      const fresh = entries.filter((e) => this._isFresh(e, now));
      if (fresh.length) this.entriesByCustomer.set(key, fresh);
      else this.entriesByCustomer.delete(key);
    }
  }
}
