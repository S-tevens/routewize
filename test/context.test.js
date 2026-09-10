import test from "node:test";
import assert from "node:assert/strict";
import { optimizeContext } from "../src/optimization/context.js";
import { SemanticCache } from "../src/cache/semanticCache.js";

const messages = [{ role: "system", content: "Keep all instructions.\n\nKeep all instructions." }, { role: "user", content: "What is the refund policy?" }];
test("default preserves messages and supplied references without reduction", () => {
  const result = optimizeContext(messages, { context: [{ id: "a", text: "hello\n\nhello" }] });
  assert.equal(result.metrics.estimated_tokens_removed, 0);
  assert.deepEqual(result.messages[0], messages[0]);
  assert.deepEqual(result.messages.at(-1), messages.at(-1));
});
test("compression removes exact duplicate paragraphs only in explicit context", () => {
  const result = optimizeContext(messages, { compression: true, context: [{ id: "a", text: "Refunds within thirty days.\n\nRefunds within thirty days." }] });
  assert.ok(result.metrics.estimated_tokens_removed > 0);
  assert.equal(result.messages[1].content.split("Refunds within thirty days.").length, 2);
  assert.deepEqual(result.messages[0], messages[0]);
});
test("code and structured reference content is preserved byte for byte", () => {
  const text = '```js\nconst x = {};\n\nconst x = {};\n```';
  const result = optimizeContext(messages, { compression: true, context: [{ id: "code", text }] });
  assert.ok(result.messages[1].content.endsWith(text));
  assert.equal(result.metrics.estimated_tokens_removed, 0);
});
test("selection prioritizes relevant documents within the estimated budget", () => {
  const result = optimizeContext(messages, { selection: true, max_context_tokens: 40, context: [{ id: "irrelevant", text: "The weather is sunny." }, { id: "refund", text: "Our refund policy allows returns." }] });
  assert.deepEqual(result.metrics.selected_context_ids, ["refund"]);
  assert.deepEqual(result.metrics.dropped_context_ids, ["irrelevant"]);
});
test("oversized documents are dropped whole rather than truncating facts", () => {
  const result = optimizeContext(messages, { selection: true, max_context_tokens: 1, context: [{ id: "large", text: "Refund policy details" }] });
  assert.deepEqual(result.messages, messages);
  assert.equal(result.metrics.context_documents_selected, 0);
});
test("rejects malformed options and ambiguous document ids", () => {
  assert.throws(() => optimizeContext(messages, { max_context_tokens: -1 }));
  assert.throws(() => optimizeContext(messages, { context: [{ id: "a", text: "x" }, { id: "a", text: "y" }] }));
  assert.throws(() => optimizeContext([{ role: "user", content: [] }]));
  assert.throws(() => optimizeContext(messages, { compression: "yes" }));
});
test("cache remains bounded and misses do not allocate namespaces", () => {
  const cache = new SemanticCache({ maxEntries: 2 });
  for (let i = 0; i < 10; i++) cache.find(String(i), [1], { similarityThreshold: 1 });
  assert.equal(cache.entriesByCustomer.size, 0);
  for (let i = 0; i < 3; i++) cache.store(String(i), { embedding: [1], ttlSeconds: 60 });
  assert.equal(cache.entriesByCustomer.size, 2);
  assert.equal(cache.find("0", [1], { similarityThreshold: 1 }).hit, false);
});
