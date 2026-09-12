# routewise — Team Context

Last updated: 2026-09-09

## What this is

A drop-in proxy for OpenAI/Anthropic chat completions. A customer changes one config value (their SDK's `base_url`) to point at this proxy instead of the provider directly. The proxy then:

1. **Caches** semantically similar prompts — a close-enough repeat request returns instantly, no API call, no cost.
2. **Routes** simple/short/templated requests to a cheaper model, using rules the customer configures themselves (no auto quality detection — the spec deliberately avoids that as the "hard, trust-killing" problem).

Everything else about the customer's app stays identical: same request shape, same response shape.

Full product spec: see the original `finops-mvp-spec.md`-style scope notes referenced in [README.md](README.md). Section 3 of that spec explicitly lists what's cut from v1 (dashboard, auto quality detection, agent budget controls, payments) — those cuts are still the operating plan.

## Repo

Private: **https://github.com/S-tevens/routewise**

## What's built and working

All of this has been manually and automatically verified (not just written):

- **Core proxy** ([src/server.js](src/server.js)) — `/v1/chat/completions`, OpenAI-compatible in and out. Auth via per-customer API key ([src/middleware/auth.js](src/middleware/auth.js)).
- **Semantic cache** ([src/cache/](src/cache/)) — in-memory, per-customer, cosine similarity + TTL. Pluggable embeddings: real OpenAI `text-embedding-3-small`, or a free deterministic "mock" mode for testing without API cost.
- **Rules-based router** ([src/router/rules.js](src/router/rules.js)) — first-match-wins, 100% customer-configured (keywords, token-count thresholds), falls back to the customer's flagship default. `x-force-model: flagship` header bypasses everything.
- **Provider adapters** ([src/providers/](src/providers/)) — OpenAI passthrough, Anthropic request/response translation (so the customer always sees an OpenAI-shaped response regardless of which provider actually served it).
- **Live pricing feed** ([src/logging/pricing.js](src/logging/pricing.js)) — pulls real per-model $/token from `tokenscost.com` at startup (425 models, daily updates), falls back to a small built-in table if that fails or is disabled (`PRICING_SOURCE=static`).
- **Cost logging** ([src/logging/logger.js](src/logging/logger.js), [stats.js](src/logging/stats.js)) — append-only log of every request; `stats.js` aggregates it into per-day breakdowns (cache hits / routed / flagship / savings).
- **Savings dashboard** ([public/dashboard.html](public/dashboard.html)) — read-only, served at `/dashboard.html`. Enter a customer's API key to see cache hit rate, routing breakdown, a savings sparkline, and a real (client-side, no re-fetch) 7D/14D/30D/All period filter. Branded as **routewise** per the team's design direction.
- **Dry-run tool** ([scripts/dryRun.js](scripts/dryRun.js)) — replays a historical request log through the real cache+router logic with **zero live API calls**, and prints the "this would've cut your bill by X%" number. This is the actual sales proof mechanism (spec section 6).
- **Automated tests** — 18 tests (`npm test`, Node's built-in runner) covering router rules, cache hit/miss/TTL/isolation logic, and pricing math. All passing.
- **Pitch one-pager** ([pitch-one-pager.html](pitch-one-pager.html)) — draft outreach doc. Still branded "AI Cost Router" (not yet renamed to routewise) and has a clearly-marked **"Pending"** slot for the real customer case study number — deliberately not filled with a fake number.

## How to run it

```bash
npm install
cp src/config/customers.example.yaml src/config/customers.yaml   # then fill in real provider keys
cp .env.example .env
npm start                                    # http://localhost:8787
node scripts/seedDemoLog.js sample-data/llm_api_requests_300.jsonl   # optional: populate dashboard with demo data
```

Dashboard: `http://localhost:8787/dashboard.html`, demo key `rw_live_demo_4a21`.

Dry run: `npm run dry-run -- sample-data/llm_api_requests_300.jsonl`

**Note:** `src/config/customers.yaml` and `.env` are gitignored (real keys never get committed). Anyone pulling this repo needs to create their own copies from the `.example` files.

## Key decisions / things worth knowing before touching this

- **The cache store is in-memory, not Redis/pgvector.** Fine for a single-process pilot; explicitly documented in the README as the thing to swap before it needs to survive a restart or scale past one process.
- **Model names in the example config may be stale.** `gpt-4o`, `gpt-4o-mini`, `claude-3-5-sonnet-20241022`, `claude-3-5-haiku-20241022` don't appear in the live tokenscost.com pricing feed as of when this was checked — worth verifying these are still callable before pointing at a real customer's traffic.
- **The "mock" embedding mode is a crude bag-of-hashed-tokens average**, used only for offline/free testing. It's known to overweight shared template phrasing (e.g. two different support tickets run through the same classification prompt template can look more similar to it than they really are). This inflates cache-hit-rate numbers on synthetic template-heavy datasets — confirmed via a diagnostic that showed **zero cross-topic false positives** (a billing ticket never gets served a sentiment answer), so it's a calibration issue, not a correctness bug. Real production embeddings won't share this limitation. Don't trust a dry-run cache-hit % that used mock embeddings as a real-world number — only real OpenAI embeddings (or real customer data) should go into an actual pitch.
- **No payments/billing integration**, deliberately. First customers get a Stripe Payment Link or an invoice. This was a direct decision after discussing it as a team — building real billing infra before closing a single customer was judged premature.
- **Dashboard is intentionally read-only**, no login system beyond the same API key the proxy itself uses. No multi-tenant admin, no user accounts.

## The actual blocker

**We do not have real customer traffic data.** Every savings number produced so far (43.9%, 64.0%, and others) came from either an externally-generated synthetic dataset or our own generator — useful for proving the mechanism works and getting a believable range, but **not usable as a real case study or a real pitch number.**

Two synthetic datasets tested so far, for reference:
- 300 requests (low-repeat mix): 35.7% cache hit rate, 43.9% estimated savings
- 1,000 requests (higher-repeat mix): 54.5% cache hit rate, 64.0% estimated savings

Target for a believable pitch, per the original spec: **>20% savings**.

## Next steps, in order

1. **Get a real historical traffic export** from the pilot customer/friend's company — even a rough one (prompts + token counts if available, prompts alone if not). This is the only real blocker; everything else is built and tested.
2. **Convert + run it through `dry-run`** — produces the real number.
3. **Drop that real number into the pitch one-pager's "Pending" slot.**
4. **If it clears ~20%+: go live on a low-risk slice** of real traffic (e.g. FAQ/classification calls, not core agent logic) using a real provider key.
5. **After 1-2 weeks live, get the real before/after number** — that's the actual case study.
6. **Outreach** to similar small AI-agent/support-automation companies using that case study. Priority ICP: companies that hold their own API key and pay for all their end-users' usage (bundled pricing, not BYOK) with visibly repetitive traffic (support/FAQ/classification-heavy products score highest).

## Open/optional items not yet started

- Rebrand `pitch-one-pager.html` from "AI Cost Router" to "routewise" (dashboard and backend are already renamed; the pitch doc is not).
- Gemini support (spec lists it as an optional "+maybe" — not built, no immediate need).
- Verify/replace the possibly-stale model names in `customers.example.yaml`.
