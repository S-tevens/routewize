import { test } from "node:test";
import assert from "node:assert/strict";
import { SemanticCache } from "../src/cache/semanticCache.js";
import { cosineSimilarity } from "../src/cache/embeddings.js";

function makeResponse(model = "gpt-4o") {
  return { content: "cached answer", usage: { prompt_tokens: 10, completion_tokens: 5 }, model };
}

test("cosineSimilarity is 1 for identical vectors and 0 for orthogonal ones", () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});

test("a fresh, near-identical embedding is a cache hit above the threshold", () => {
  const cache = new SemanticCache();
  cache.store("cust_1", { embedding: [1, 0], promptText: "hi", response: makeResponse(), model: "gpt-4o", ttlSeconds: 3600 });

  const result = cache.find("cust_1", [0.99, 0.14], { similarityThreshold: 0.92, ttlSeconds: 3600 });
  assert.equal(result.hit, true);
});

test("a dissimilar embedding below the threshold is a miss", () => {
  const cache = new SemanticCache();
  cache.store("cust_1", { embedding: [1, 0], promptText: "hi", response: makeResponse(), model: "gpt-4o", ttlSeconds: 3600 });

  const result = cache.find("cust_1", [0, 1], { similarityThreshold: 0.92, ttlSeconds: 3600 });
  assert.equal(result.hit, false);
});

test("entries are namespaced per customer — no cross-customer leakage", () => {
  const cache = new SemanticCache();
  cache.store("cust_1", { embedding: [1, 0], promptText: "hi", response: makeResponse(), model: "gpt-4o", ttlSeconds: 3600 });

  const result = cache.find("cust_2", [1, 0], { similarityThreshold: 0.92, ttlSeconds: 3600 });
  assert.equal(result.hit, false);
});

test("an expired entry (past its TTL) is not returned as a hit", () => {
  const cache = new SemanticCache();
  cache.store("cust_1", { embedding: [1, 0], promptText: "hi", response: makeResponse(), model: "gpt-4o", ttlSeconds: 3600 });

  // Manually backdate the entry past its TTL instead of sleeping in the test.
  cache.entriesByCustomer.get("cust_1")[0].storedAt = Date.now() - 3601 * 1000;

  const result = cache.find("cust_1", [1, 0], { similarityThreshold: 0.92, ttlSeconds: 3600 });
  assert.equal(result.hit, false);
});

test("prune() drops expired entries but keeps fresh ones", () => {
  const cache = new SemanticCache();
  cache.store("cust_1", { embedding: [1, 0], promptText: "old", response: makeResponse(), model: "gpt-4o", ttlSeconds: 3600 });
  cache.store("cust_1", { embedding: [0, 1], promptText: "new", response: makeResponse(), model: "gpt-4o", ttlSeconds: 3600 });
  cache.entriesByCustomer.get("cust_1")[0].storedAt = Date.now() - 3601 * 1000;

  cache.prune();

  const entries = cache.entriesByCustomer.get("cust_1");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].promptText, "new");
});

test("finds the best match among multiple entries, not just the first", () => {
  const cache = new SemanticCache();
  cache.store("cust_1", { embedding: [0.99, 0.14], promptText: "close", response: makeResponse(), model: "gpt-4o", ttlSeconds: 3600 });
  cache.store("cust_1", { embedding: [1, 0], promptText: "exact", response: makeResponse(), model: "gpt-4o", ttlSeconds: 3600 });

  const result = cache.find("cust_1", [1, 0], { similarityThreshold: 0.92, ttlSeconds: 3600 });
  assert.equal(result.hit, true);
  assert.equal(result.entry.promptText, "exact"); // higher similarity than "close", even though stored second
});
