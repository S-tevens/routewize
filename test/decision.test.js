import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "../src/decision/index.js";
import { compose, DEFAULT_POLICY } from "../src/decision/composer.js";
import { choiceAnswer, scoreAnswer, validateAnswers } from "../src/decision/contract.js";
import { DEFAULT_QUESTIONS } from "../src/decision/questions.js";
import { rulesBackend } from "../src/decision/rulesBackend.js";
import { buildState } from "../src/decision/state.js";

const user = (content) => [{ role: "user", content }];

test("rules backend returns valid typed answers for every question", () => {
  const state = buildState(user("Classify this ticket as urgent or normal"));
  const answers = rulesBackend.evaluate(state, DEFAULT_QUESTIONS);
  assert.doesNotThrow(() => validateAnswers(DEFAULT_QUESTIONS, answers));
  const probs = Object.values(answers.task_kind.probabilities);
  assert.ok(Math.abs(probs.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.equal(answers.difficulty.distribution.length, 4);
});

test("validateAnswers rejects malformed backend output", () => {
  const good = rulesBackend.evaluate(buildState(user("hello")), DEFAULT_QUESTIONS);
  assert.throws(() => validateAnswers(DEFAULT_QUESTIONS, { ...good, task_kind: { ...good.task_kind, choice: "nonsense" } }));
  assert.throws(() => validateAnswers(DEFAULT_QUESTIONS, { ...good, needs_deep_reasoning: { type: "bool", probability: 1.5 } }));
  assert.throws(() => validateAnswers(DEFAULT_QUESTIONS, { ...good, difficulty: { ...good.difficulty, distribution: [1, 1, 0, 0] } }));
  const { difficulty, ...missing } = good;
  assert.throws(() => validateAnswers(DEFAULT_QUESTIONS, missing));
});

test("simple, templated asks are advised to the quick tier", () => {
  for (const prompt of [
    "Classify this ticket as urgent or normal: App crashes on login",
    "hi, thanks!",
    "Translate this into French: Your order has shipped.",
    "Summarize the key points of this FAQ for a customer.",
  ]) {
    assert.equal(decide(user(prompt)).suggested_tier, "quick", prompt);
  }
});

test("debugging code is floored at standard or above", () => {
  const d = decide(user("```js\nfunction add(a,b){return a-b}\n```\nWhy does add(2,2) return 0? Fix the bug."));
  assert.equal(d.answers.task_kind.choice, "code");
  assert.ok(["standard", "high", "premium"].includes(d.suggested_tier));
});

test("multi-step design work is advised to the premium tier", () => {
  const d = decide(user(
    "Design a multi-region architecture for our payments service. Compare the trade-offs of active-active vs active-passive, " +
    "plan the migration step by step, and explain why. It must handle edge cases like partial outages and must not lose writes.",
  ));
  assert.equal(d.answers.task_kind.choice, "reason");
  assert.equal(d.suggested_tier, "premium");
});

test("decisions are deterministic for the same input", () => {
  const messages = user("Compare Postgres and MySQL for our analytics workload and recommend one.");
  const { latency_ms: _a, ...first } = decide(messages);
  const { latency_ms: _b, ...second } = decide(messages);
  assert.deepEqual(first, second);
});

test("the decision record never contains prompt text", () => {
  const secret = "zebra-marker-7731";
  const record = JSON.stringify(decide(user(`Summarize this: ${secret} is our internal codename.`)));
  assert.ok(!record.includes(secret));
});

test("uncertain difficulty uses the cumulative-probability rule, not the mean", () => {
  const answers = {
    task_kind: choiceAnswer(Object.keys(DEFAULT_QUESTIONS.task_kind.options), Object.keys(DEFAULT_QUESTIONS.task_kind.options).map(() => 0)),
    // mean ≈ 1.2 (standard) but 30% mass on "hard"+ keeps the 80% cumulative point at "hard"
    difficulty: scoreAnswer([0.3, 0.35, 0.3, 0.05]),
    needs_deep_reasoning: { type: "bool", probability: 0.5 },
    cheaper_model_sufficient: { type: "bool", probability: 0.5 },
  };
  assert.ok(answers.difficulty.confidence < DEFAULT_POLICY.confidence.score);
  const result = compose(answers);
  assert.equal(result.low_confidence, true);
  assert.equal(result.tier, "high");
  assert.match(result.reason, /cumulative rule/);
});

test("kind floors only apply when the kind answer is confident", () => {
  const kinds = Object.keys(DEFAULT_QUESTIONS.task_kind.options);
  const trivial = scoreAnswer([0.9, 0.08, 0.01, 0.01]);
  const base = { difficulty: trivial, needs_deep_reasoning: { type: "bool", probability: 0.05 }, cheaper_model_sufficient: { type: "bool", probability: 0.95 } };
  const confidentCode = choiceAnswer(kinds, kinds.map((k) => (k === "code" ? 5 : 0)));
  const unsureCode = choiceAnswer(kinds, kinds.map((k) => (k === "code" ? 0.2 : 0)));
  assert.equal(compose({ ...base, task_kind: confidentCode }).tier, "standard");
  assert.equal(compose({ ...base, task_kind: unsureCode }).tier, "quick");
});

test("a pluggable backend with the same contract drives the same composer", () => {
  const stub = {
    name: "stub",
    evaluate: () => ({
      task_kind: choiceAnswer(Object.keys(DEFAULT_QUESTIONS.task_kind.options), Object.keys(DEFAULT_QUESTIONS.task_kind.options).map((k) => (k === "reason" ? 6 : 0))),
      difficulty: scoreAnswer([0, 0.02, 0.08, 0.9]),
      needs_deep_reasoning: { type: "bool", probability: 0.95 },
      cheaper_model_sufficient: { type: "bool", probability: 0.02 },
    }),
  };
  const d = decide(user("anything"), { backend: stub });
  assert.equal(d.engine, "stub");
  assert.equal(d.suggested_tier, "premium");
});
