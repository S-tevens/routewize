import OpenAI from "openai";

// Straight passthrough — the customer's request is already OpenAI-shaped.
export async function callOpenAI({ apiKey, model, messages, temperature, max_tokens }) {
  const client = new OpenAI({ apiKey });
  const completion = await client.chat.completions.create({
    model,
    messages,
    ...(temperature !== undefined ? { temperature } : {}),
    ...(max_tokens !== undefined ? { max_tokens } : {}),
  });

  return {
    content: completion.choices[0].message.content,
    usage: {
      prompt_tokens: completion.usage?.prompt_tokens ?? 0,
      completion_tokens: completion.usage?.completion_tokens ?? 0,
    },
    raw: completion,
  };
}
