# routewise — Gameplan

**Read this file first, before touching any code.** This is the living source of truth for "what's the current state and what should I work on next." It gets updated after every meaningful change — if something here looks stale, trust `git log` over this file for what actually happened, but this file for *priority and intent*.

For deeper context, read (in this order, as needed):
- [CONTEXT.md](CONTEXT.md) — business context: what this product is, who it's for, key decisions and their reasoning, the current real-world blocker.
- [SYSTEM_DESIGN.md](SYSTEM_DESIGN.md) — architecture: request lifecycle, component responsibilities, data model, failure modes.

## Before you write any code

1. `git fetch origin && git checkout master && git pull origin master` — work from current `master`, not a stale checkout.
2. Read the **Danger zone** section below before touching any file listed there.
3. Create a new branch off up-to-date master: `git checkout -b feature/<short-description>`. Never commit directly to `master`.
4. Run `npm test` before you start (confirm you're starting from a green baseline) and again before you push.
5. Push your branch and open a PR (`gh pr create` or via GitHub). Don't merge into `master` yourself — leave that for review.
6. **If your change alters the *behavior* of an existing shared mechanism** (not just adds something new), say so explicitly and prominently in the PR description: what the old behavior was, what it is now, and why. A PR titled "add dashboard feature" that also silently changes how caching works is exactly what caused the one real incident in this repo's history so far (see `git log --oneline` around the `codex/token-savings-dashboard` integration, and PR #1's description for the full story) — a one-line callout in review would have caught it immediately.

## Danger zone — flag any behavior change to these explicitly

These are shared, core mechanisms that other work depends on. Adding to them is fine; **silently changing how they already behave is the one thing that has caused real problems in this project.**

- `src/server.js` — specifically the cache-namespace construction and the `/v1/chat/completions` request flow
- `src/cache/semanticCache.js` — the semantic similarity matching itself. If you touch this, verify with a real test that near-duplicate prompts (not just exact-string duplicates) still produce cache hits — that property was accidentally destroyed once already.
- `src/router/rules.js` — routing must stay pure, deterministic, and driven only by customer-configured rules, never by any form of automatic "quality" judgment (this is a deliberate product decision, not an oversight — see CONTEXT.md).
- `scripts/dryRun.js` — this must stay behaviorally identical to the live server's cache+router logic. It's the sales-proof mechanism; if it diverges from what the live proxy actually does, every number it produces becomes a lie to a prospective customer.
- **Streaming (`handleStreamingCall` in `server.js`, `streamOpenAI`/`streamAnthropic`)** has no live end-to-end test in this environment (no real API key) — only the immediate-failure path and the Anthropic event-translation logic are live/unit-verified. If you have a real key, do one live streaming smoke test before trusting the successful-multi-chunk path, and update GAMEPLAN.md's row for it.

## Current state (as of 2026-09-13)

Merged to `master`: core proxy (now with streaming support), semantic cache (namespace-isolated + real embeddings), rules router, context optimization, cost evaluation subsystem, savings dashboard + financial overview, dry-run tool, live pricing feed, CI running `npm test` on every PR, verified-current model IDs, config hot-reload, env-var-based secrets (interim), and per-customer rate limits/spend caps. PR #2 merged the rebuildable SQLite request-log index with daily stats rollups and customer/date queries for financial overview. PR #3 merged the config comment-placeholder fix. The pitch one-pager is rebranded to routewise; 83 tests passing. Every item from the original "next things to add" roadmap is now done or explicitly deferred (see the two "later" rows below) — the roadmap continues past this point per SYSTEM_DESIGN.md §9 as new gaps surface.

**The actual bottleneck is not engineering** — it's that there is still no real customer traffic data. Every savings number produced so far is synthetic. Don't let engineering work substitute for getting that data; see CONTEXT.md's "Next steps" for the non-engineering sequence.

## Task queue

Pick the next `todo` item top-down unless you have a specific reason not to. Before starting one, check open PRs/branches so two people don't pick up the same thing — if in doubt, open a draft PR early to claim it.

| Status | Task | Notes |
|---|---|---|
| ✅ Done | CI pipeline (`npm test` on every PR) | `.github/workflows/test.yml` |
| ✅ Done | Verify model IDs are still live | Confirmed against provider docs 2026-09-12: `claude-3-5-sonnet-20241022` and `claude-3-5-haiku-20241022` are **retired** (would fail live). Updated `customers.example.yaml`/`customers.yaml` to `claude-sonnet-4-6` / `claude-haiku-4-5-20251001`. `gpt-4o`/`gpt-4o-mini` confirmed still active. See README's "Pricing data" section. Re-check periodically — providers retire models on their own schedule. |
| ✅ Done | Config hot-reload | `watchCustomersConfig()` in `src/config/loadConfig.js` — server watches `customers.yaml`, reloads on change, keeps the previous good config if the edit fails to parse. Verified live (edited the file while a running server served a request against the new key, no restart) plus 2 automated tests. |
| ✅ Done (interim) | Secrets out of plaintext — env-var substitution | `provider_keys` now support `${ENV_VAR_NAME}` placeholders resolved at load/reload time (see README's "Keeping real keys out of the config file"). Explicit team decision: this is the interim fix; a real secrets manager (Vault/AWS/GCP) is deferred until there's enough customer volume to justify it — see "Later" row below. |
| ✅ Done | Per-customer rate limits / usage caps | `src/middleware/usageGuard.js` — per-customer requests/minute (default 120, configurable, 0 disables) and an optional daily spend cap in USD (UTC day, cache hits never count against it). Both checked in `server.js` before any provider spend is committed. Verified live (2/min limit via hot-reload, 3rd request in the same minute got a real 429 + `Retry-After`) plus 9 unit tests. |
| ✅ Done (test-coverage caveat) | Streaming support | `stream: true` supported on `/v1/chat/completions` for both providers — see SYSTEM_DESIGN.md §3 "Streaming" for the full design (cache-hit = single chunk, cache-miss = real pass-through, two-phase header commit so an immediate failure still gets a clean 502). Anthropic event translation is a pure, unit-tested function (8 tests). **Caveat: no real API key in this environment, so a successful multi-chunk stream is verified by code review + unit tests, not a live run** — the immediate-failure path (both providers) and non-streaming regression *are* live-verified. Whoever has a real key first should do one live streaming smoke test and update this row. |
| ⬜ todo | Live streaming smoke test | Streaming (above) has no live end-to-end verification in this environment — no real provider key was available. First person with a real OpenAI/Anthropic key should run one real streaming request against each provider, confirm chunks arrive correctly and the final chunk carries correct usage/rw_meta, then update the streaming row above to remove the caveat. Quick, high-value — do this before building anything else streaming-related. |
| ✅ Done (merged PR #2) | Queryable request log | `requestLogStore.js` incrementally indexes JSONL into SQLite, persists checkpoints and daily rollups, and serves indexed customer/date queries. Stats no longer scans historical requests; financial overview uses the index too. 11 new tests cover recovery, isolation and bounded reads. Live streaming smoke test skipped: no provider key available in project config/environment. |
| ✅ Done (merged PR #3) | Example-config comment placeholders | Parse YAML before substituting string values: comment placeholders are ignored, environment values stay literal, mapping keys stay literal, and missing value variables still fail. Four regression tests; live smoke/pilot analysis still await real keys/data. |
| ✅ Done | Rebrand `pitch-one-pager.html` | Title, main heading and footer now say routewise. Real case-study result stays Pending; synthetic traffic labels remain. No provider key available for the live streaming smoke test. |
| ⬜ later (explicit decision, not forgotten) | Persistent, shared cache (Redis + pgvector/Qdrant) | Team decision 2026-09-12: no Redis instance yet, deliberately deferred rather than building speculative infrastructure. Revisit once there's more than one pilot customer or a reason to run more than one server process. See SYSTEM_DESIGN.md §9 for why the in-memory cache is the actual scaling blocker when this becomes relevant. |
| ⬜ later (explicit decision, not forgotten) | Real secrets manager (Vault/AWS/GCP Secrets Manager) | Team decision 2026-09-12: env-var substitution (above) is the interim fix. Move to a real secrets manager once there's meaningful customer volume — pick the provider based on where the app ends up hosted. |
| ⬜ optional | Gemini support | Spec lists as an optional "+maybe" — not started, no immediate need. |
| ⬜ blocked (not engineering) | Real customer case study | Waiting on real traffic export from a pilot customer — this is the actual product bottleneck. Not a Codex task; needs a human to go get the data. |

## Updating this file

Whenever a task above is completed, merged, or a new priority emerges: update its status in the table, and update the "Current state" date and summary. Keep entries terse — this file is meant to be read cold by an agent in under a minute, not to duplicate CONTEXT.md or SYSTEM_DESIGN.md.
