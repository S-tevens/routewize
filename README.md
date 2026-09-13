# routewise (MVP)

Drop-in proxy for OpenAI/Anthropic chat completions that:
1. **Caches** semantically similar prompts so repeat/near-duplicate requests don't hit the real API — matching is namespaced per customer, requested model, generation settings (temperature/max_tokens), and resolved route, so a hit can never reuse an answer generated under different instructions or model settings, while real embedding similarity still catches near-duplicate wording within that namespace.
2. **Routes** simple requests to a cheaper model using rules *you* configure — no auto quality detection.
3. **Compresses reference context** by removing duplicate prose paragraphs and excess paragraph whitespace, when explicitly enabled.
4. **Selects context documents** using lexical relevance to the latest user question within a configurable estimated token budget.

Point your app at this proxy instead of calling OpenAI/Anthropic directly. Everything else about your app stays the same.

## Context optimization

### Savings proof: compare paid requests

The **Savings proof** tab uses the current Playground input to run an original and an optimized model request. It requires a real provider key, an explicit paid-call confirmation, expected answer phrases, and an overhead amount supplied by the customer. It does not simulate live savings with demo data.

Enable this per customer only after verifying that customer's rates. Example configuration shape (replace `null` with confirmed USD per million token rates):

```yaml
evaluation:
  enabled: true
  pricing:
    openai/gpt-4o:
      input: null
      output: null
      cached_input: null
      source: "Your provider contract or pricing page"
      as_of: "2026-09-10"
```

Add a pricing entry for every model selected by routing if enabling routing in the comparison. Null, missing and generic fallback prices are rejected before any calls. Restart the server after changing customer configuration.

Authenticated `GET /v1/evaluations/config` checks readiness. `POST /v1/evaluations` accepts:

```json
{
  "confirm_paid_calls": true,
  "overhead_usd_per_request": 0.0001,
  "use_routing": false,
  "max_tokens": 512,
  "cases": [{
    "messages": [{"role": "user", "content": "What is the refund policy?"}],
    "expected_contains": ["30 days"],
    "rw_optimization": {
      "compression": true,
      "selection": true,
      "max_context_tokens": 2000,
      "context": [{"id": "policy", "text": "Refunds within 30 days.", "protected": true}]
    }
  }]
}
```

Send an `Idempotency-Key` header (16–100 letters, digits, hyphens or underscores). The API accepts 1–3 cases (2 paid calls each) and 1–1024 output tokens per call. SDK automatic retries are disabled, each call has a 30-second timeout, and response caching is bypassed. Failed/timed-out calls may still cost money; their unknown spend is never treated as zero in a net-savings claim. Duplicate requests share the same report for one hour in the running process. This protection does **not** survive restart or span multiple instances; do not retry an uncertain paid request after a restart without checking provider billing.

The original arm receives all reference documents without reduction on the customer's default model. The optimized arm uses the submitted settings and optionally configured routing. No production policies are modified. Both arms' token usage, model/response IDs, rates, response times, and answers appear in the downloadable JSON report. A separate billing receipt is saved in ignored `logs/evaluations.log` without prompts, answers, or expected phrases. The browser download does contain answers and phrase checks. No evaluation entries are mixed into the existing demo/request savings chart.

**Money accounting:** per-request net difference = baseline provider cost − optimized provider cost − supplied optimization overhead. The report separately shows the cost incurred by running both sides of the evaluation. It includes reported cached-input usage at the specified cached rate. Unsupported cache-write/audio billing or missing usage makes a result inconclusive. Costs are calculated from provider-reported tokens and supplied rates, **not reconciled invoices**: credits, taxes, contract tiers, unreported fees, and future workload changes are not inferred. Negative savings remain negative. Local compression makes no paid model call; include its infrastructure and any service fees in the supplied overhead.

**Quality checks:** both answers must contain every required phrase, case-insensitively, and finish normally. These checks do not prove semantic correctness or preservation of quality. The report gives a sample-specific verdict and next step; it never automatically rolls out a policy. Human answer review, representative evaluation data, exact billing reconciliation, monitoring and rollout/fallback controls remain necessary before production deployment.

**Protected context:** mark reference documents `protected: true` to retain their contents verbatim in preview and model requests. Protected documents take priority over the estimated token budget. `context_budget_exceeded` reports this explicitly, rather than dropping protected information.

Send optional `rw_optimization` alongside `messages` to `/v1/chat/completions`. The same payload sent to authenticated `POST /v1/optimize` previews transformed messages and metrics without calling a model or writing request logs:

```json
{
  "messages": [{"role": "user", "content": "What is the refund policy?"}],
  "rw_optimization": {
    "compression": true,
    "selection": true,
    "max_context_tokens": 2000,
    "context": [
      {"id": "refunds", "text": "Refunds are available within 30 days.\n\nRefunds are available within 30 days."},
      {"id": "shipping", "text": "Standard shipping takes five days."}
    ]
  }
}
```

Both reduction switches default to false. Per-customer `optimization` configuration can set `compression`, `selection`, and `max_context_tokens`; explicit request values override those defaults. References are inserted before the last user message, with their source IDs and an untrusted-data label. This label is not a prompt-injection security boundary.

Selection retains whole documents, ranks word overlap with the question, and drops documents that do not fit. It can drop every document if none fits. Inspect `selected_context_ids` and `dropped_context_ids` in preview metrics before enabling on a workload. Compression preserves conversation messages and skips reference text containing code fences, braces, or brackets. It is conservative deduplication, not learned semantic compression or summarization.

Responses expose before/after estimates and document counts under `rw_meta.optimization`; the dashboard aggregates these per selected period. Token counts use characters divided by four, not a model tokenizer, so budgets are approximate. Savings in dollars still describe caching/routing only; compression savings are not inferred from these estimates. Quality and latency must be evaluated on customer examples before rollout.

The live endpoint currently supports non-streaming text messages only. Streaming, tool calls and response formats are rejected explicitly. Cache capacity is 1,000 entries per process, in memory, with TTL; it does not survive restart or synchronize between instances. These features are a tested implementation baseline, not a claim of full production readiness.

## Setup

```bash
npm install
cp src/config/customers.example.yaml src/config/customers.yaml
```

Edit `src/config/customers.yaml`: set a real `api_key` for your app to authenticate with this proxy, and your real `provider_keys.openai` / `provider_keys.anthropic` (this proxy never eats your inference cost — it calls providers with your own keys).

Copy `.env.example` to `.env` and adjust if needed.

```bash
npm start
```

### Keeping real keys out of the config file

`provider_keys` values support `${ENV_VAR_NAME}` placeholders, resolved from the environment at load time — put the real secret in `.env` (or your deploy environment), not in `customers.yaml` itself:

```yaml
provider_keys:
  openai: "${DEMO_AGENT_CO_OPENAI_KEY}"
```

A referenced env var that isn't set fails loudly at startup (or reload — see below) rather than silently treating the customer as unconfigured. This is an interim improvement, not a real secrets manager — see `GAMEPLAN.md` for when that becomes worth the investment.

### Editing config without restarting

The server watches `customers.yaml` and hot-reloads it on change — add a customer, tweak a routing rule, or update a key, and it takes effect within a second, no restart needed. If the edited file fails to parse (bad YAML, missing `api_key`, an unresolved env var), the previously loaded config stays in place and the error is logged — a mid-edit typo never takes the whole proxy down.

## Using it

Same shape as the OpenAI chat completions API, just pointed at this server:

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer rw_live_demo_4a21" \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4o", "messages": [{"role": "user", "content": "Classify: I love this product!"}]}'
```

The response includes an `rw_meta` field showing whether it was a cache hit, which routing rule fired, and the estimated savings for that request.

Force a request to skip caching/routing and always hit the flagship default:

```bash
curl ... -H "x-force-model: flagship" ...
```

### Streaming

Set `"stream": true` for a standard OpenAI-compatible SSE stream — Anthropic-routed requests are translated to the same `chat.completion.chunk` format, so a client never needs to know which provider actually served it, same as the non-streaming path.

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer rw_live_demo_4a21" \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4o", "messages": [{"role": "user", "content": "Classify: I love this product!"}], "stream": true}'
```

A cache hit sends the full cached answer as a single chunk immediately, rather than faking a token-by-token typing effect — a client accumulating `choices[0].delta.content` across chunks gets the same result either way, just faster. `rw_meta` (cache hit, matched rule, estimated savings) rides on the *last* chunk instead of the response body, since usage/cost is only known once the stream finishes.

One tradeoff worth knowing: once the first chunk is sent, the HTTP response is already committed to `200` with `Content-Type: text/event-stream` — a failure after that point can only be reported as an in-stream error event, not a clean error status code. A failure *before* the first chunk (e.g. an invalid provider key) still returns a normal `502` JSON error, same as the non-streaming path. `tools` and `response_format` remain unsupported either way.

## Dry run (prove savings before going live)

Run a customer's historical request log through the router+cache logic with **no real API calls** and get one number: how much this would have saved.

```bash
npm run dry-run -- sample-data/historical-requests.jsonl
```

Input is JSONL, one request per line:

```json
{"customer_api_key": "rw_live_demo_4a21", "messages": [{"role": "user", "content": "..."}], "model_requested": "gpt-4o", "usage": {"prompt_tokens": 120, "completion_tokens": 40}}
```

`usage` is optional — omit it and token counts are estimated from text length.

By default the dry run uses a deterministic local "mock" embedding (no embedding-API cost) so you can get a number for free. Set `EMBEDDING_PROVIDER=openai` in `.env` to use real embeddings for more accurate similarity matching once you're ready to spend a few cents on it.

## Pricing data

Cost estimates (used in logging and the dry-run report) pull live per-model pricing from [tokenscost.com](https://tokenscost.com/data) at startup — 400+ models, updated daily, CC-BY-4.0. If that fetch fails (offline, timeout) it falls back to a small built-in table covering the example config's default models, so nothing breaks either way. Set `PRICING_SOURCE=static` to skip the network call entirely and always use the built-in table.

Note: tokenscost.com's model `id` strings don't reliably match the real provider API model strings (e.g. it lists `claude-sonnet-4.6`, the real Anthropic API id is `claude-sonnet-4-6`), so the live feed rarely matches current Anthropic models by exact id — cost estimates for those lean on the static fallback table more than the feed. It's kept anyway since it does match many OpenAI ids and covers hundreds of other models the fallback table doesn't.

**Model status, verified 2026-09-12 against provider docs** (this needs periodic re-checking, providers retire models on their own schedule):
- `claude-3-5-sonnet-20241022` and `claude-3-5-haiku-20241022` (previously used in `customers.example.yaml`) are **retired** — Anthropic: "Requests to retired models will fail." Config now uses the active replacements, `claude-sonnet-4-6` and `claude-haiku-4-5-20251001`.
- `gpt-4o` / `gpt-4o-mini` are still **active**, just no longer OpenAI's recommended/flagship tier (that's now the GPT-6/5.6 series) — left as-is since they still work, but worth revisiting if OpenAI schedules them for retirement.

## How routing works

Rules live in each customer's `routing.rules` list in `customers.yaml`. First matching rule wins; anything unmatched — or any request sent with `x-force-model: flagship` — falls through to that customer's `default` model. See the example config for the rule shape (`max_prompt_tokens`, `keywords`).

## Rate limits and spend caps

Two independent, optional protections per customer (`rate_limit` in `customers.yaml`), against a fast-loop bug and a slow leaked-key drip respectively:

- **`requests_per_minute`** — a fixed 60s window. Defaults to 120/min server-wide if a customer doesn't set one; `0` disables it for that customer. Exceeding it returns `429` with a `Retry-After` header, before any cache lookup or provider call happens.
- **`max_daily_spend_usd`** — cumulative estimated spend (our own pricing-table estimate, not a customer's real provider bill), UTC calendar day, resets at midnight UTC. Unset by default — we can't guess an acceptable budget without the customer telling us. **Cache hits are always free and never count against it** — only actual model calls do, so a customer over their cap still gets served from cache, just can't trigger new provider spend until it resets.

Both are in-memory, per-process (`src/middleware/usageGuard.js`) — reset on restart, same current-scope caveat as the semantic cache (see SYSTEM_DESIGN.md §9).

## Savings dashboard (read-only, V2)

Open the dashboard through the running server, not by opening `public/dashboard.html` as a file. File URLs cannot load the server-relative assets or authenticated APIs. If you start with `PORT=8788`, use `http://localhost:8788/dashboard.html`. Restart `npm start` after backend edits, or use `npm run dev` to reload them automatically.

The financial overview shows gateway provider spend only when provider usage can be priced with the configured rates. Unknown charges remain unavailable. Cost saved is an estimate from gateway logs, not invoice-verified savings. Potential savings and the comparison graph come from saved paid evaluations; potential savings counts pairs passing both phrase checks and includes supplied overhead. Evaluation charges are shown separately. No comparison chart is fabricated when evaluation records are absent.

With the server running, open `http://localhost:8787/dashboard.html` and enter a customer's API key. It reads an automatically maintained SQLite index of the same `logs/requests.log` the proxy already writes, and shows total requests, cache hit rate, % routed to a cheaper model, total estimated savings, a per-day savings chart, and a recent-activity table. There's no login system; the API key itself is the credential, same as the proxy endpoint, and it's only ever sent to this same server (never a third party).

To see it with data before any real traffic exists, seed the log from a sample dataset:

```bash
node scripts/seedDemoLog.js sample-data/llm_api_requests_300.jsonl
```

This **overwrites** `logs/requests.log` with simulated entries spread across the past week — useful for a demo, but clear it (delete the file) before real traffic starts, so real and simulated numbers don't mix.

Deliberately not built here (still deferred until a real customer asks, per the spec): billing/payments, multi-customer login, and anything beyond what a single API key's own log already contains.

## What's intentionally not built (v1 scope)

- No automatic quality detection — routing rules are 100% customer-configured.
- No agent budget/governance controls.
- No payments/billing integration — first customers get a Stripe Payment Link or invoice, not a checkout flow.
- Only OpenAI + Anthropic providers.
- Cache store is in-process memory, not Redis/pgvector — fine for a single-process pilot; swap `src/cache/semanticCache.js` for a real vector store before it needs to survive restarts or run across multiple instances.

See `finops-mvp-spec.md`-style scope notes above — this mirrors the "2 subsystems, not 6" MVP plan.


### Request-log index

`logs/requests.log` remains the authoritative, append-only JSONL log. On the first stats or financial-overview read, `src/logging/requestLogStore.js` backfills `logs/requests.log.sqlite`. Subsequent reads import only newly appended bytes; a persisted checkpoint prevents reimport after a restart. SQLite transactions commit events, daily rollups and the checkpoint together.

Stats reads customer/day rollups and the latest 25 records through indexes: work scales with that customer's number of days plus new log bytes, rather than historical request count. Financial overview queries only the customer's requested date range (hash identity first, name fallback for legacy records), then keeps the existing financial calculations. Its separate `evaluations.log` receipt scan is unchanged.

Behavior details: only newline-terminated records are indexed, so a partly written final line becomes visible once completed. Malformed JSON and records without a string timestamp are skipped; nonnumeric/nonfinite stats metrics contribute zero. Record order for recent activity remains append order. Replacing, removing or truncating the log resets the index, including demo reseeding. The file is append-only: arbitrary edits to earlier bytes while also growing the file are unsupported (a 128-byte checkpoint-tail check catches common truncate-and-regrow cases, not all historical edits).

The first backfill and any rebuild run synchronously and may delay that read on large logs; normal unchanged reads parse no historical events. The index adds disk usage and requires a writable log directory. SQLite failures fail the reporting request rather than silently returning stale totals; proxy logging still appends JSONL independently. To rebuild a damaged index, stop every process using it, remove only `logs/requests.log.sqlite` and its `-wal`/`-shm` sidecars, and restart. Keep `requests.log`. The next reporting request rebuilds the index. Database files are gitignored.

SQLite uses `better-sqlite3` 12.x to retain Node 20 compatibility (CI uses Node 24). `npm install` normally downloads a native prebuild; platforms without one need the package's native build prerequisites. This index does not change the deferred shared-cache work.


Environment placeholders are resolved in parsed YAML **string values**, including nested lists and block strings. Comments are ignored, and mapping keys remain literal. Environment values are inserted verbatim, so quotes, hashes and newlines cannot alter the YAML structure; a value such as `false` stays a string. Missing variables in actual values still fail with a list of variable names. This applies both at startup and on hot reload. Set the two `DEMO_AGENT_CO_*_KEY` variables used by the example config; the `ENV_VAR_NAME` shown in its comment is documentation only.


### Offline streaming verification

`npm test` includes `test/streamingIntegration.test.js`. It starts local synthetic OpenAI/Anthropic HTTP endpoints and an isolated copy of the real proxy, using the installed SDK adapters, fake keys, mock embeddings and static pricing. It checks that chunks arrive before upstream completion, final usage and `rw_meta`, configured-rate spend (including Anthropic cached input), cache reuse by streaming/non-streaming requests, clean JSON 502s before streaming, and SSE errors after partial output. Failed partial answers must not enter the cache. Temporary configs, logs, processes and listeners are cleaned up.

These tests require local loopback sockets but no internet, provider credentials or paid calls. They do not certify current provider behavior; the live streaming smoke test remains pending real keys.
