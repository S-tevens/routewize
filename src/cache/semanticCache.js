import { cosineSimilarity } from "./embeddings.js";

// In-memory per-customer vector store. Good enough to prove out the router
// end-to-end; swap for Redis + pgvector/Qdrant when it needs to survive
// restarts or scale past one process (see README).
export class SemanticCache {
  constructor() {
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
    const entries = this._entriesFor(customerApiKey);

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
    const entries = this._entriesFor(customerApiKey);
    entries.push({ embedding, promptText, response, model, storedAt: Date.now(), ttlSeconds });
  }

  // Drops expired entries so long-running processes don't leak memory.
  prune() {
    const now = Date.now();
    for (const [key, entries] of this.entriesByCustomer) {
      this.entriesByCustomer.set(key, entries.filter((e) => this._isFresh(e, now)));
    }
  }
}
