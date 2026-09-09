import fs from "node:fs";
import { createEmbeddingProvider, cosineSimilarity } from "../src/cache/embeddings.js";

// Temporary diagnostic: replays the dataset through cache-matching logic with
// full bucket/id metadata carried alongside each embedding (rather than
// reconstructed from stored text, which loses structure), so cross-bucket
// false-positive hits can be told apart from real same-bucket duplicates.

const inputPath = process.argv[2];
const lines = fs.readFileSync(inputPath, "utf8").split("\n").filter(Boolean);

function classify(record) {
  const hasSystem = record.messages.some((m) => m.role === "system");
  if (hasSystem) return "complex";
  const content = record.messages[0].content.toLowerCase();
  if (/^(classify|sentiment analysis|categorize|faq:|extract)/.test(content)) return "templated";
  return "repeated";
}

const embedder = createEmbeddingProvider({ provider: "mock" });
const stored = []; // { embedding, bucket, text }

let sameBucketHits = 0;
let crossBucketHits = 0;
const crossExamples = [];
const bucketCounts = {};

for (const line of lines) {
  const record = JSON.parse(line);
  const bucket = classify(record);
  bucketCounts[bucket] = (bucketCounts[bucket] || 0) + 1;
  const promptText = record.messages.map((m) => m.content).join("\n");
  const embedding = await embedder.embed(promptText);

  let best = null;
  let bestSim = -1;
  for (const entry of stored) {
    const sim = cosineSimilarity(embedding, entry.embedding);
    if (sim > bestSim) {
      bestSim = sim;
      best = entry;
    }
  }

  if (best && bestSim >= 0.92) {
    if (best.bucket === bucket) {
      sameBucketHits++;
    } else {
      crossBucketHits++;
      if (crossExamples.length < 6) {
        crossExamples.push({ queryBucket: bucket, matchedBucket: best.bucket, similarity: bestSim, query: promptText.slice(0, 90), matched: best.text.slice(0, 90) });
      }
    }
  }

  stored.push({ embedding, bucket, text: promptText });
}

console.log("Bucket counts:", bucketCounts);
console.log(`Same-bucket hits (true duplicates): ${sameBucketHits}`);
console.log(`Cross-bucket hits (real false positives): ${crossBucketHits}`);
console.log("\nExample cross-bucket false positives:");
for (const ex of crossExamples) {
  console.log(`  similarity=${ex.similarity.toFixed(3)}  ${ex.queryBucket} matched ${ex.matchedBucket}`);
  console.log(`    query:   ${ex.query}`);
  console.log(`    matched: ${ex.matched}`);
}
