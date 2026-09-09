import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateCost, estimateTokens, priceFor } from "../src/logging/pricing.js";

test("estimateTokens is roughly 4 chars per token, and 0 for empty input", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens("a".repeat(400)), 100);
});

test("estimateCost scales linearly with token counts", () => {
  const price = priceFor("gpt-4o-mini");
  const cost = estimateCost("gpt-4o-mini", 1000, 1000);
  assert.ok(Math.abs(cost - (price.in + price.out)) < 1e-9);
});

test("cheaper model produces a lower cost estimate for identical token counts", () => {
  const flagshipCost = estimateCost("gpt-4o", 1000, 500);
  const cheapCost = estimateCost("gpt-4o-mini", 1000, 500);
  assert.ok(cheapCost < flagshipCost);
});

test("an unknown model falls back to a conservative default price rather than throwing", () => {
  assert.doesNotThrow(() => estimateCost("some-future-model-v9", 100, 100));
});
