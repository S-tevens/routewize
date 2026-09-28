// Deterministic policy: typed answers in, capability tier + reason out.
// The backend only judges; everything here is plain, testable code.

export const TIERS = ["quick", "standard", "high", "premium"];

export const DEFAULT_POLICY = {
  // demand = difficulty + reasoningWeight * (needs_deep_reasoning - cheaper_model_sufficient), clamped to [0, 3]
  reasoningWeight: 0.75,
  // demand cut points between quick | standard | high | premium
  tierCuts: [0.9, 1.7, 2.4],
  // minimum tier for a task kind, applied only when the kind answer is confident
  kindFloors: { code: "standard", reason: "standard" },
  // confidence semantics differ per answer type, so thresholds do too
  confidence: { choice: 0.3, score: 0.45 },
  // when difficulty is uncertain: lowest level whose cumulative probability reaches this
  cumulativeThreshold: 0.8,
};

const fmt = (n) => n.toFixed(2);

export function compose(answers, policy = DEFAULT_POLICY) {
  const difficulty = answers.difficulty;
  const deep = answers.needs_deep_reasoning?.probability ?? 0.5;
  const cheap = answers.cheaper_model_sufficient?.probability ?? 0.5;
  const demand = Math.min(3, Math.max(0, difficulty.score + policy.reasoningWeight * (deep - cheap)));

  let tierIndex = policy.tierCuts.filter((cut) => demand >= cut).length;
  const notes = [];

  const lowConfidence = difficulty.confidence < policy.confidence.score;
  if (lowConfidence) {
    let cumulative = 0;
    let level = difficulty.distribution.length - 1;
    for (let i = 0; i < difficulty.distribution.length; i++) {
      cumulative += difficulty.distribution[i];
      if (cumulative >= policy.cumulativeThreshold) { level = i; break; }
    }
    tierIndex = Math.min(TIERS.length - 1, level);
    notes.push(`uncertain difficulty (conf ${fmt(difficulty.confidence)}) → cumulative rule`);
  }

  const kind = answers.task_kind;
  if (kind && kind.confidence >= policy.confidence.choice) {
    const floor = policy.kindFloors[kind.choice];
    if (floor && TIERS.indexOf(floor) > tierIndex) {
      tierIndex = TIERS.indexOf(floor);
      notes.push(`${kind.choice} floor`);
    }
  }

  const tier = TIERS[tierIndex];
  const kindLabel = kind ? `${kind.choice} (${fmt(kind.confidence)})` : "task ?";
  const reason = `${kindLabel} · difficulty ${fmt(difficulty.score)}/3 · deep ${fmt(deep)} · cheap-ok ${fmt(cheap)} → ${tier}` +
    (notes.length ? ` · ${notes.join(" · ")}` : "");
  return { demand, tier, low_confidence: lowConfidence, reason };
}
