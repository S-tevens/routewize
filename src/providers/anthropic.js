import Anthropic from "@anthropic-ai/sdk";

// Translates an OpenAI-shaped chat request to Anthropic's Messages API and
// back, so the customer always sees an OpenAI-compatible response no matter
// which provider actually served the request.
export async function callAnthropic({ apiKey, model, messages, temperature, max_tokens, timeout = 60000, maxRetries = 2 }) {
  const client = new Anthropic({ apiKey, timeout, maxRetries });

  const systemMessages = messages.filter((m) => m.role === "system").map((m) => m.content);
  const conversation = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));

  const response = await client.messages.create({
    model,
    system: systemMessages.join("\n") || undefined,
    messages: conversation,
    max_tokens: max_tokens ?? 1024,
    ...(temperature !== undefined ? { temperature } : {}),
  });

  const content = response.content.map((block) => (block.type === "text" ? block.text : "")).join("");

  return {
    content,
    finish_reason: response.stop_reason === "max_tokens" ? "length" : "stop",
    usage: {
      prompt_tokens: response.usage?.input_tokens ?? 0,
      completion_tokens: response.usage?.output_tokens ?? 0,
    },
    raw: response,
  };
}
