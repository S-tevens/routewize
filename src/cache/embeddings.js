import crypto from "node:crypto";

const MOCK_DIMS = 256;

// Deterministic, dependency-free "embedding" for offline dry-run testing —
// NOT semantically meaningful beyond rewarding near-identical text. Never use
// this in production; set EMBEDDING_PROVIDER=openai for real similarity matching.
function mockEmbed(text) {
  const vec = new Array(MOCK_DIMS).fill(0);
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  const tokens = normalized.split(" ");
  for (const token of tokens) {
    const hash = crypto.createHash("sha256").update(token).digest();
    for (let i = 0; i < MOCK_DIMS; i++) {
      vec[i] += hash[i % hash.length] - 128;
    }
  }
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

export function createEmbeddingProvider({ provider, openaiClient, model }) {
  if (provider === "mock") {
    return { embed: async (text) => mockEmbed(text) };
  }

  return {
    embed: async (text, { signal } = {}) => {
      const response = await openaiClient.embeddings.create({ model, input: text }, { signal });
      return response.data[0].embedding;
    },
  };
}

export function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
