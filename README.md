# routewise

Drop-in proxy for OpenAI/Anthropic chat completions that:
1. **Caches** semantically similar prompts so repeat/near-duplicate requests don't hit the real API.
2. **Routes** simple requests to a cheaper model using rules *you* configure — no auto quality detection.

Point your app at this proxy instead of calling OpenAI/Anthropic directly. Everything else about your app stays the same.

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

Note: the live feed didn't have entries for `gpt-4o` / `claude-3-5-sonnet-20241022` / etc. (the models in `customers.example.yaml`) as of this writing — worth checking whether those model names are still current before going live with a real customer.

## How routing works

Rules live in each customer's `routing.rules` list in `customers.yaml`. First matching rule wins; anything unmatched — or any request sent with `x-force-model: flagship` — falls through to that customer's `default` model. See the example config for the rule shape (`max_prompt_tokens`, `keywords`).

## Savings dashboard (read-only, V2)

With the server running, open `http://localhost:8787/dashboard.html` and enter a customer's API key. It reads the same `logs/requests.log` the proxy already writes — no new data store — and shows total requests, cache hit rate, % routed to a cheaper model, total estimated savings, a per-day savings chart, and a recent-activity table. There's no login system; the API key itself is the credential, same as the proxy endpoint, and it's only ever sent to this same server (never a third party).

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
