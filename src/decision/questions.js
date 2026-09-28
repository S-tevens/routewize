// The question set asked about every request. Option descriptions matter:
// they are the contract a future model-backed backend is trained/prompted on,
// so keep them distinct.
export const DEFAULT_QUESTIONS = {
  task_kind: {
    type: "choice",
    instructions: "What kind of task is the latest user message?",
    options: {
      classify: "Assign a label, category, sentiment or yes/no to given input.",
      extract: "Pull specific fields or facts out of provided text into a fixed shape.",
      summarize: "Condense provided text without adding new information.",
      rewrite: "Rephrase, translate, proofread or reformat provided text.",
      answer: "Answer a short factual or lookup-style question.",
      write: "Produce new prose: emails, posts, stories, documents.",
      code: "Write, fix, explain or review source code.",
      reason: "Multi-step analysis, planning, design, comparison or debugging.",
      chat: "Greeting, thanks or small talk with no real task.",
      other: "None of the above fits.",
    },
  },
  difficulty: {
    type: "score",
    instructions: "How hard is this task for a language model?",
    levels: ["trivial", "routine", "hard", "expert"],
  },
  needs_deep_reasoning: {
    type: "bool",
    statement: "Answering well requires multi-step reasoning, search or planning.",
  },
  cheaper_model_sufficient: {
    type: "bool",
    statement: "A small, fast model would very likely handle this correctly.",
  },
};
