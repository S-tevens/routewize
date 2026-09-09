import fs from "node:fs";
import path from "node:path";

// Generates a synthetic historical-request dataset for the dry-run tool, with
// an explicit, tunable traffic mix instead of whatever an external LLM
// happens to produce. Modeled on a small AI-agent/support-automation company
// (the ICP from the spec): some traffic is genuinely repetitive, some is
// short/templated-but-unique, and some is long, high-stakes, one-off
// reasoning that must never be downgraded.
//
// Usage: node scripts/generateSyntheticDataset.js [outputPath] [totalRequests]

const TOTAL = Number(process.argv[3]) || 400;
const OUTPUT = process.argv[2] || "sample-data/generated-realistic.jsonl";
const CUSTOMER_KEY = "rw_live_demo_4a21";

// Target mix — chosen to be a believable *middle ground* between the two
// external datasets we've already tested (44% savings on low-repeat, 64% on
// very-high-repeat traffic), not the ceiling.
const MIX = {
  repeated: 0.30, // recurring FAQ/support questions — drives cache hits
  templated: 0.40, // short, one-off classification/extraction — drives cheap routing
  complex: 0.30, // long, unique, high-stakes — must stay on flagship
};

function estTokens(text) {
  return Math.max(5, Math.round(text.length / 4));
}

// A small pool of canonical recurring questions. Real support traffic isn't
// uniform — a handful of questions account for a disproportionate share of
// volume — so weights below are deliberately skewed (roughly power-law).
const RECURRING_POOL = [
  { text: "What's your return policy for electronics purchased more than 30 days ago?", weight: 5, completion: 90 },
  { text: "How do I reset my account password if I no longer have access to my recovery email?", weight: 4, completion: 70 },
  { text: "Why was I charged twice for my subscription this month?", weight: 4, completion: 55 },
  { text: "Can I change my billing cycle from monthly to annual mid-subscription?", weight: 3, completion: 60 },
  { text: "The agent worker shows offline in the console even though it's running locally — what should I check?", weight: 3, completion: 65 },
  { text: "How do I isolate API access between test and production environments?", weight: 2, completion: 50 },
  { text: "Why did my automation job stop running after about 15 minutes?", weight: 2, completion: 55 },
  { text: "Is it safe to include an API key in frontend JavaScript?", weight: 2, completion: 40 },
];

// Slight rewordings for a fraction of "repeat" traffic, so the cache is also
// exercised on near-duplicates, not just exact string matches.
function reword(text) {
  const prefixes = ["Quick question: ", "Hey, ", "", "", "Support ticket: ", ""];
  const suffixes = ["", " Thanks!", " Please advise.", ""];
  const p = prefixes[Math.floor(Math.random() * prefixes.length)];
  const s = suffixes[Math.floor(Math.random() * suffixes.length)];
  return `${p}${text}${s}`;
}

function weightedPick(pool) {
  const total = pool.reduce((sum, item) => sum + item.weight, 0);
  let r = Math.random() * total;
  for (const item of pool) {
    r -= item.weight;
    if (r <= 0) return item;
  }
  return pool[pool.length - 1];
}

// Short, templated, classification/extraction-style tasks — realistic
// one-off tickets, not duplicates, but structurally simple and short.
const TEMPLATE_KINDS = [
  {
    build: (subject) => `classify this support ticket as billing, authentication, integration, reliability, permissions, or product_bug. Ticket: ${subject}`,
    completion: 12,
  },
  {
    build: (subject) => `sentiment analysis: label this customer message as positive, neutral, frustrated, or urgent. Message: ${subject}`,
    completion: 10,
  },
  {
    build: (subject) => `categorize this incoming issue by team: support, billing, security, infrastructure, or product. Issue: ${subject}`,
    completion: 15,
  },
  {
    build: (subject) => `faq: summarize this note in under 40 words. Note: ${subject}`,
    completion: 45,
  },
  {
    build: (subject) => `extract the key entities and requested action from this note. Return compact JSON. Note: ${subject}`,
    completion: 60,
  },
];

// A larger, varied pool than templatedCount draws so (template, subject)
// combinations rarely repeat by chance — this bucket is meant to exercise
// the ROUTER (short/simple → cheap model), not the cache. Too small a pool
// here accidentally turns "one-off" traffic into disguised duplicates.
const TICKET_SUBJECTS = [
  "I upgraded to Pro and still see the old monthly request limit.",
  "The billing portal says my card is invalid even though another purchase worked.",
  "Getting a 403 error when calling the /v1/agents endpoint since this morning.",
  "Customer says the refund was promised three days ago and still hasn't arrived.",
  "Our webhook stopped firing after we rotated the signing secret.",
  "A teammate can't see the shared workspace after being re-invited.",
  "The dashboard shows zero usage even though we've made hundreds of calls today.",
  "Requesting a copy of last quarter's invoices for an internal audit.",
  "The export button on the reports page does nothing when clicked.",
  "We were downgraded to the free tier without any notice.",
  "API responses have been taking over 10 seconds since the last deploy.",
  "Two different team members were both charged for the same seat.",
  "The nightly export job silently failed and nobody was notified.",
  "Our custom domain stopped resolving after the SSL cert renewal.",
  "A user was able to see another workspace's data for about ten minutes.",
  "The mobile app crashes immediately after the latest update.",
  "Support macros are inserting the wrong customer name in replies.",
  "We can't delete a workspace member who left the company months ago.",
  "The usage graph and the invoice total don't match this billing period.",
  "Single sign-on stopped working for everyone on the enterprise plan.",
  "A scheduled report went out with last month's numbers instead of this month's.",
  "The API returned a 500 error on every request for about six minutes.",
  "Our Slack integration duplicated every notification for two days.",
  "A refund was issued but the customer says they never requested one.",
  "The onboarding checklist keeps resetting itself for new team members.",
  "We were auto-renewed on annual billing despite cancelling last quarter.",
  "The search bar returns zero results for queries that used to work fine.",
  "An admin's permissions were silently downgraded after a role rename.",
  "The CSV export is missing the last column that used to be included.",
  "Two-factor authentication codes are arriving several minutes late.",
  "A webhook retry storm sent the same event forty times in a row.",
  "The trial extension we were promised by support was never applied.",
  "Our custom branding reverted to the default theme after the update.",
  "A deleted project is still showing up in the billing summary.",
  "The API rate limit error message doesn't match our actual plan limits.",
  "A customer's data export request has been stuck in 'processing' for a week.",
];

// The fixed list above is too small on its own once draw counts get into the
// hundreds — 36 subjects x 5 template kinds = 180 combinations is still a
// tight fit for 160+ draws (birthday-paradox collisions kick in well before
// the pool is "full"). For any real-sized run, build subjects
// combinatorially instead so the collision space is in the thousands.
const FEATURES = [
  "the billing portal", "the API rate limiter", "the export pipeline", "single sign-on",
  "the mobile app", "the notification center", "the audit log", "the webhook delivery system",
  "the search index", "the invoicing engine", "the permissions system", "the onboarding flow",
  "the CSV export", "the Slack integration", "the usage dashboard", "the trial-extension flow",
];
const PROBLEMS = [
  "stopped working after the latest deploy", "is returning inconsistent results",
  "silently failed without any error message", "is showing data for the wrong account",
  "has been intermittently timing out", "duplicated an action that should only happen once",
  "reverted to default settings unexpectedly", "is missing data since this morning",
  "sent duplicate notifications to the same user", "is blocking a customer from finishing checkout",
  "is several minutes slower than it used to be", "returned a 500 error on a routine request",
];
const TIME_REFS = [
  "since this morning", "for the past two days", "after the last release",
  "starting last night", "since we rotated credentials", "since the weekend deploy", "",
];

function generateSubject() {
  const feature = FEATURES[Math.floor(Math.random() * FEATURES.length)];
  const problem = PROBLEMS[Math.floor(Math.random() * PROBLEMS.length)];
  const timeRef = TIME_REFS[Math.floor(Math.random() * TIME_REFS.length)];
  const capitalized = feature.charAt(0).toUpperCase() + feature.slice(1);
  return `${capitalized} ${problem}${timeRef ? " " + timeRef : ""}.`;
}

// Long, unique, high-stakes tasks — real agent-architecture / ops questions
// that a router must never downgrade. Each "core" question below is combined
// with a randomly drawn stack/scale/constraint sentence at generation time —
// otherwise reusing 8 static strings across ~120 draws would just recreate
// the same accidental-duplication bug as the ticket-subject pool.
const COMPLEX_CORES = [
  "Design a safety-conscious semantic caching strategy for a multi-tenant customer-support agent platform. Cover cache-key construction, tenant isolation, similarity thresholds, TTL policy, dynamic-field detection, invalidation triggers, and which request types must be excluded entirely to avoid leaking one customer's data into another's cached response.",
  "Propose a migration strategy from a deterministic rules engine to an LLM-driven agent platform that preserves reliability while introducing probabilistic behavior gradually: workflow inventory, risk tiering, shadow execution, side-by-side evaluation, human approval gates, tool sandboxing, and criteria for declaring a workflow safe to leave shadow mode.",
  "An operations agent pages engineers, opens tickets, and posts customer-facing status updates during infrastructure incidents. Build a decision framework limiting blast radius under model uncertainty: confidence gates, deterministic policy checks, action budgets, approval requirements, idempotency, retry limits, and an incident-replay mechanism for postmortems.",
  "Our sales agent reads CRM records, email threads, call notes, and pricing rules to draft next-step recommendations across integrations with different permission scopes. Design a data-access architecture preventing cross-account leakage and stale-context decisions while keeping latency acceptable, including tenant isolation, document versioning, and retrieval ranking.",
  "A customer-success agent scores renewal risk for enterprise accounts from usage data, support history, contract terms, and meeting notes. Design a workflow producing reliable risk recommendations without overreacting to a single noisy signal — evidence weighting, recency handling, missing/conflicting data, human review gates, and feedback loops from actual renewal outcomes.",
  "We want a customer-facing agent to modify subscription settings and trigger account actions from natural-language requests. Design a verification and authorization architecture that separates user intent from allowed operations, resists ambiguous requests and stale sessions, and prevents prompt content from bypassing account-level permissions.",
  "Propose an incident-triage architecture that decides, from logs, traces, deployment history, and alert streams, when to page a team, when to gather more evidence, and when to suppress noisy alerts — including uncertainty handling, rate limiting, and post-incident learning.",
  "Design an evaluation harness for comparing agent responses before and after a prompt or model change, covering regression detection, human-review sampling, statistical significance, and rollback criteria for a production agent handling real customer requests.",
];

const STACK_VARIANTS = [
  "The current stack is a Python API service, async workers, PostgreSQL, and Redis.",
  "The current stack is a Node.js backend with Kafka event streams and MongoDB.",
  "The current stack is a Go microservices architecture behind an API gateway, backed by CockroachDB.",
  "The current stack is a Ruby on Rails monolith with Sidekiq background jobs and MySQL.",
  "The current stack runs on Kubernetes with a Python control plane, gRPC internal services, and a managed Postgres instance.",
];

const SCALE_VARIANTS = [
  "This serves roughly 2 million requests per month across 40 enterprise tenants.",
  "This serves around 500,000 requests per month across 12 mid-market customers.",
  "This handles about 8 million requests per month across 200 small-business accounts.",
  "This is a newer product doing roughly 50,000 requests per month across 5 pilot customers.",
  "This runs at a steady 1.2 million requests per month, concentrated among 6 large accounts.",
];

const CONSTRAINT_VARIANTS = [
  "The team has 14 engineers and no dedicated ML platform function yet.",
  "The team has 40 engineers split across three time zones with an on-call rotation.",
  "There is minimal automated regression coverage and heavy reliance on manual review before releases.",
  "Several customers operate under regulated-industry compliance requirements.",
  "The team recently moved from pilot deployments to contractual uptime commitments.",
];

function buildRecord({ messages, model_requested, prompt_tokens, completion_tokens }) {
  return JSON.stringify({
    customer_api_key: CUSTOMER_KEY,
    messages,
    model_requested,
    usage: { prompt_tokens, completion_tokens },
  });
}

function main() {
  const records = [];
  const models = ["gpt-4o", "claude-3-5-sonnet-20241022"];
  const pickModel = () => models[Math.floor(Math.random() * models.length)];

  const repeatedCount = Math.round(TOTAL * MIX.repeated);
  const templatedCount = Math.round(TOTAL * MIX.templated);
  const complexCount = TOTAL - repeatedCount - templatedCount;

  for (let i = 0; i < repeatedCount; i++) {
    const item = weightedPick(RECURRING_POOL);
    const useExact = Math.random() < 0.5;
    const content = useExact ? item.text : reword(item.text);
    const prompt = estTokens(content);
    records.push(
      buildRecord({
        messages: [{ role: "user", content }],
        model_requested: pickModel(),
        prompt_tokens: prompt,
        completion_tokens: item.completion + Math.round(Math.random() * 10),
      })
    );
  }

  for (let i = 0; i < templatedCount; i++) {
    const kind = TEMPLATE_KINDS[Math.floor(Math.random() * TEMPLATE_KINDS.length)];
    // Mostly combinatorial subjects (huge collision space) with a minority
    // drawn from the hand-written pool for flavor/readability.
    const subject = Math.random() < 0.8 ? generateSubject() : TICKET_SUBJECTS[Math.floor(Math.random() * TICKET_SUBJECTS.length)];
    const content = kind.build(subject);
    records.push(
      buildRecord({
        messages: [{ role: "user", content }],
        model_requested: pickModel(),
        prompt_tokens: estTokens(content),
        completion_tokens: kind.completion + Math.round(Math.random() * 10),
      })
    );
  }

  const randomFrom = (arr) => arr[Math.floor(Math.random() * arr.length)];
  for (let i = 0; i < complexCount; i++) {
    const core = randomFrom(COMPLEX_CORES);
    const content = `${core} ${randomFrom(STACK_VARIANTS)} ${randomFrom(SCALE_VARIANTS)} ${randomFrom(CONSTRAINT_VARIANTS)}`;
    records.push(
      buildRecord({
        messages: [
          { role: "system", content: "You are a senior AI platform architect. Prioritize reliability, security, and measurable outcomes." },
          { role: "user", content },
        ],
        model_requested: pickModel(),
        prompt_tokens: estTokens(content) + 40,
        completion_tokens: 500 + Math.round(Math.random() * 600),
      })
    );
  }

  // Shuffle so the dry-run's cache-building simulation sees requests in a
  // realistic interleaved order rather than all repeats first.
  records.sort(() => Math.random() - 0.5);

  const outPath = path.resolve(process.cwd(), OUTPUT);
  fs.writeFileSync(outPath, records.join("\n") + "\n", "utf8");
  console.log(`Wrote ${records.length} requests to ${outPath}`);
  console.log(`Mix: ${repeatedCount} repeated, ${templatedCount} templated, ${complexCount} complex`);
}

main();
