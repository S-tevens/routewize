import { performance } from "node:perf_hooks";
import { validateAnswers } from "./contract.js";
import { compose, DEFAULT_POLICY } from "./composer.js";
import { DEFAULT_QUESTIONS } from "./questions.js";
import { rulesBackend } from "./rulesBackend.js";
import { buildState } from "./state.js";

// Advisory decision for one request: which capability tier it appears to
// need, and why. It never selects the model -- the customer's routing rules
// still do. The returned record contains no prompt text.
export function decide(messages, { backend = rulesBackend, questions = DEFAULT_QUESTIONS, policy = DEFAULT_POLICY } = {}) {
  const started = performance.now();
  const state = buildState(messages);
  const answers = validateAnswers(questions, backend.evaluate(state, questions));
  const composed = compose(answers, policy);
  const round = (v) => Math.round(v * 1000) / 1000;
  return {
    engine: backend.name,
    suggested_tier: composed.tier,
    demand: round(composed.demand),
    low_confidence: composed.low_confidence,
    reason: composed.reason,
    answers: Object.fromEntries(Object.entries(answers).map(([name, a]) => [name,
      a.type === "choice" ? { choice: a.choice, confidence: round(a.confidence), probabilities: Object.fromEntries(Object.entries(a.probabilities).map(([k, v]) => [k, round(v)])) }
        : a.type === "score" ? { score: round(a.score), confidence: round(a.confidence), distribution: a.distribution.map(round) }
          : { probability: round(a.probability) },
    ])),
    latency_ms: round(performance.now() - started),
  };
}
