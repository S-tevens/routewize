import { choiceAnswer, scoreAnswer, sigmoid } from "./contract.js";

// Stage-1 decision backend: deterministic lexical + structural signals, no
// model, no network. Answers have the same typed shape a model-backed backend
// will return, so it can be swapped without touching the composer.

const LEXICON = {
  classify: ["classify", "categorize", "categorise", "label", "sentiment", "which category", "is this spam", "urgent or", "intent", "yes or no", "true or false"],
  extract: ["extract", "pull out", "parse", "find all", "fields", "as json", "into json", "key-value"],
  summarize: ["summarize", "summarise", "summary", "tl;dr", "tldr", "key points", "condense", "recap"],
  rewrite: ["rewrite", "rephrase", "paraphrase", "translate", "proofread", "fix the grammar", "fix grammar", "reformat", "make it shorter", "polish", "reword"],
  answer: ["what is", "what's", "who is", "when did", "when is", "where is", "how many", "define", "meaning of", "faq"],
  write: ["write", "draft", "compose", "email", "blog", "essay", "story", "post", "cover letter", "announcement"],
  code: ["```", "function", "code", "bug", "stack trace", "typescript", "python", "javascript", "sql", "regex", "implement", "refactor", "compile", "exception", "unit test"],
  reason: ["why", "prove", "analyze", "analyse", "compare", "trade-off", "tradeoff", "trade-offs", "design", "architecture", "plan", "strategy", "evaluate", "pros and cons", "step by step", "root cause", "optimize", "debug"],
  chat: ["hi", "hello", "hey", "thanks", "thank you", "how are you", "good morning"],
};

const REASONING_CUES = ["why", "prove", "analyze", "analyse", "compare", "trade-off", "tradeoff", "design", "architecture", "plan", "strategy", "step by step", "root cause", "evaluate", "pros and cons", "optimize", "debug", "migrate", "migration"];
const CONSTRAINT_CUES = ["must", "should not", "must not", "requirements", "edge case", "edge cases", "ensure", "at least", "exactly", "constraint"];
const LENGTH_CUES = ["detailed", "comprehensive", "in depth", "in-depth", "thorough", "essay", "report", "whitepaper"];

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const phraseRegex = new Map();
function hits(text, phrases) {
  let n = 0;
  for (const phrase of phrases) {
    if (phrase === "```") {
      if (text.includes(phrase)) n++;
      continue;
    }
    let re = phraseRegex.get(phrase);
    if (!re) {
      re = new RegExp(`(^|[^a-z0-9])${escape(phrase)}($|[^a-z0-9])`);
      phraseRegex.set(phrase, re);
    }
    if (re.test(text)) n++;
  }
  return n;
}

function taskKind(question, text) {
  const options = Object.keys(question.options);
  const logits = options.map((option) => {
    if (option === "other") return 0.6;
    const n = hits(text, LEXICON[option] ?? []);
    // greetings only count as chat when the message is basically just a greeting
    if (option === "chat") return n > 0 && text.length < 60 ? 1.6 * n + 0.6 : 0;
    return 1.4 * n;
  });
  return choiceAnswer(options, logits);
}

function rawDifficulty(state, kind) {
  const { signals, text } = state;
  const p = kind.probabilities;
  let r = 1.0;
  if (signals.prompt_tokens > 800) r += 0.3;
  if (signals.prompt_tokens > 2000) r += 0.4;
  if (signals.prompt_tokens > 6000) r += 0.4;
  r += Math.min(1.2, 0.45 * hits(text, REASONING_CUES));
  r += Math.min(0.4, 0.1 * hits(text, CONSTRAINT_CUES));
  if (hits(text, LENGTH_CUES) > 0) r += 0.3;
  if (signals.code_blocks > 0) r += 0.35 + (signals.code_blocks > 1 ? 0.15 : 0);
  if (signals.turns > 6) r += 0.2;
  if (text.length < 120) r -= 0.3;
  r -= 0.9 * ((p.classify ?? 0) + (p.extract ?? 0) + (p.rewrite ?? 0) + (p.chat ?? 0));
  r += 0.6 * (p.reason ?? 0) + 0.4 * (p.code ?? 0);
  return Math.min(3, Math.max(0, r));
}

export const rulesBackend = {
  name: "rules-v1",
  evaluate(state, questions) {
    const text = state.text.toLowerCase();
    const answers = {};
    const kind = questions.task_kind ? taskKind(questions.task_kind, text) : null;
    if (kind) answers.task_kind = kind;
    const r = rawDifficulty({ ...state, text }, kind ?? { probabilities: {} });
    if (questions.difficulty) {
      const levels = questions.difficulty.levels.length;
      const sigma = 0.6;
      answers.difficulty = scoreAnswer(Array.from({ length: levels }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma))));
    }
    if (questions.needs_deep_reasoning) answers.needs_deep_reasoning = { type: "bool", probability: sigmoid(2.5 * (r - 1.9)) };
    if (questions.cheaper_model_sufficient) answers.cheaper_model_sufficient = { type: "bool", probability: sigmoid(2.5 * (1.3 - r)) };
    return answers;
  },
};
