// Typed decision contract. A backend answers narrow typed questions about a
// request; it never picks a model and never returns prose. Policy lives in
// composer.js. Any backend (rules today, a self-hosted model later) must
// return answers that pass validateAnswers().
//
//   choice: { type, choice, probabilities: {option: p}, confidence }
//           confidence is chance-corrected: 0 = uniform, 1 = certain.
//   score:  { type, score, distribution: [p per level], confidence }
//           score is the probability-weighted level; confidence is the peak p.
//   bool:   { type, probability }

const isProbability = (v) => Number.isFinite(v) && v >= 0 && v <= 1;
const sumsToOne = (values) => Math.abs(values.reduce((s, v) => s + v, 0) - 1) <= 1e-6;

export function validateAnswers(questions, answers) {
  for (const [name, question] of Object.entries(questions)) {
    const a = answers?.[name];
    if (!a || a.type !== question.type) throw new Error(`Decision answer "${name}" missing or wrong type`);
    if (question.type === "choice") {
      const options = Object.keys(question.options);
      const probs = options.map((o) => a.probabilities?.[o]);
      if (!options.includes(a.choice) || !probs.every(isProbability) || !sumsToOne(probs) || !isProbability(a.confidence)) {
        throw new Error(`Decision answer "${name}" is not a valid choice distribution`);
      }
      if (probs.some((p) => p > a.probabilities[a.choice] + 1e-9)) throw new Error(`Decision answer "${name}" choice is not the most likely option`);
    } else if (question.type === "score") {
      const d = a.distribution;
      if (!Array.isArray(d) || d.length !== question.levels.length || !d.every(isProbability) || !sumsToOne(d) ||
          !Number.isFinite(a.score) || a.score < 0 || a.score > question.levels.length - 1 || !isProbability(a.confidence)) {
        throw new Error(`Decision answer "${name}" is not a valid score distribution`);
      }
    } else if (question.type === "bool") {
      if (!isProbability(a.probability)) throw new Error(`Decision answer "${name}" is not a valid probability`);
    } else {
      throw new Error(`Unknown decision question type "${question.type}"`);
    }
  }
  return answers;
}

export function softmax(logits) {
  const max = Math.max(...logits);
  const exps = logits.map((l) => Math.exp(l - max));
  const total = exps.reduce((s, v) => s + v, 0);
  return exps.map((v) => v / total);
}

// Builds a well-formed choice answer from per-option logits.
export function choiceAnswer(options, logits) {
  const probs = softmax(logits);
  let best = 0;
  probs.forEach((p, i) => { if (p > probs[best]) best = i; });
  const uniform = 1 / options.length;
  return {
    type: "choice",
    choice: options[best],
    probabilities: Object.fromEntries(options.map((o, i) => [o, probs[i]])),
    confidence: Math.max(0, (probs[best] - uniform) / (1 - uniform)),
  };
}

// Builds a well-formed score answer from an unnormalized distribution over levels.
export function scoreAnswer(weights) {
  const total = weights.reduce((s, v) => s + v, 0);
  const distribution = weights.map((w) => w / total);
  return {
    type: "score",
    score: distribution.reduce((s, p, i) => s + p * i, 0),
    distribution,
    confidence: Math.max(...distribution),
  };
}

export const sigmoid = (x) => 1 / (1 + Math.exp(-x));
