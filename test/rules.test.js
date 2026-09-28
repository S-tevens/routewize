import { test } from "node:test";
import assert from "node:assert/strict";
import { selectRoute } from "../src/router/rules.js";

const customer = {
  default: { provider: "openai", model: "gpt-4o" },
  routing: {
    rules: [
      {
        name: "short-classification",
        match: { max_prompt_tokens: 200, keywords: ["classify", "sentiment"] },
        route_to: { provider: "openai", model: "gpt-4o-mini" },
      },
      {
        name: "faq-templated",
        match: { keywords: ["faq", "summarize"], max_prompt_tokens: 800 },
        route_to: { provider: "anthropic", model: "claude-3-5-haiku-20241022" },
      },
    ],
  },
};

test("forceFlagship always wins, regardless of prompt content", () => {
  const route = selectRoute({ customer, promptText: "classify this", forceFlagship: true });
  assert.equal(route.provider, "openai");
  assert.equal(route.model, "gpt-4o");
  assert.equal(route.matchedRule, "forced-flagship");
});

test("short classification prompt routes to the cheap model", () => {
  const route = selectRoute({ customer, promptText: "classify: I love this product", forceFlagship: false });
  assert.equal(route.model, "gpt-4o-mini");
  assert.equal(route.matchedRule, "short-classification");
});

test("keyword match is case-insensitive", () => {
  const route = selectRoute({ customer, promptText: "Please CLASSIFY this ticket", forceFlagship: false });
  assert.equal(route.matchedRule, "short-classification");
});

test("keyword present but over the token budget falls through to the next rule", () => {
  const longPrompt = "classify " + "word ".repeat(300); // ~300 tokens, over the 200 budget
  const route = selectRoute({ customer, promptText: longPrompt, forceFlagship: false });
  assert.notEqual(route.matchedRule, "short-classification");
});

test("no keyword match falls all the way through to the customer default", () => {
  const route = selectRoute({
    customer,
    promptText: "Draft a retention email referencing this customer's full ticket history",
    forceFlagship: false,
  });
  assert.equal(route.model, "gpt-4o");
  assert.equal(route.matchedRule, "default-fallback");
});

test("rules are evaluated in order — first match wins", () => {
  // Contains both "classify" and "faq" keywords; short-classification is listed first.
  const route = selectRoute({ customer, promptText: "faq: classify this", forceFlagship: false });
  assert.equal(route.matchedRule, "short-classification");
});

test("every route explains why it was chosen, without echoing prompt text", () => {
  const matched = selectRoute({ customer, promptText: "Please CLASSIFY this private-note-991", forceFlagship: false });
  assert.deepEqual(matched.why, [`~${Math.ceil("Please CLASSIFY this private-note-991".length / 4)} tokens ≤ 200`, 'keyword "classify"']);
  assert.ok(!matched.why.join(" ").includes("private-note-991"));
  assert.deepEqual(selectRoute({ customer, promptText: "classify", forceFlagship: true }).why, ["client forced the flagship model"]);
  assert.deepEqual(selectRoute({ customer, promptText: "write a poem", forceFlagship: false }).why, ["no routing rule matched (2 checked)"]);
});

test("customer with no routing rules always falls through to default", () => {
  const bareCustomer = { default: { provider: "openai", model: "gpt-4o" } };
  const route = selectRoute({ customer: bareCustomer, promptText: "classify anything", forceFlagship: false });
  assert.equal(route.matchedRule, "default-fallback");
});
