import { estimateTokens } from "../logging/pricing.js";

const MAX_CHARS = 4000;

// Everything a backend gets to see. The latest user message is included for
// backends that read text (it never leaves the process with the rules
// backend); the rest are signals computed in code. Nothing here is logged.
export function buildState(messages, { maxChars = MAX_CHARS } = {}) {
  const textMessages = messages.filter((m) => typeof m?.content === "string");
  const lastUser = [...textMessages].reverse().find((m) => m.role === "user")?.content ?? "";
  const fullText = textMessages.map((m) => m.content).join("\n");
  return {
    text: lastUser.slice(0, maxChars),
    truncated: lastUser.length > maxChars,
    signals: {
      prompt_tokens: estimateTokens(fullText),
      message_tokens: estimateTokens(lastUser),
      turns: textMessages.filter((m) => m.role === "user").length,
      code_blocks: (lastUser.match(/```/g) ?? []).length >> 1,
      question_marks: (lastUser.match(/\?/g) ?? []).length,
    },
  };
}
