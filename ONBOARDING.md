# Onboarding a Real Customer

Last updated: 2026-09-21

Step-by-step for setting up routewize for an actual paying/pilot customer — not a demo, not synthetic data. Counterpart to [NON_TECHNICAL.md](NON_TECHNICAL.md) (finding and pitching a customer) and [GAMEPLAN.md](GAMEPLAN.md) (engineering state) — this is what happens the moment someone says yes.

## Phase 0 — Before touching any config (business/legal)

- Get informal agreement on pilot terms in writing (email is fine) — free for N days, in exchange for usage data + feedback. Template already drafted in NON_TECHNICAL.md's outreach section.
- Point them to (or attach) [TERMS_OF_SERVICE.txt](TERMS_OF_SERVICE.txt) and [public/privacy.html](public/privacy.html) — even in draft form, showing you have them signals seriousness. Fill in the bracketed placeholders (contact email, at minimum) before sending anything externally.
- Get their explicit confirmation they're comfortable pointing their app's base URL at a third party — some won't be, for compliance reasons. That's a real disqualifier, not something to talk them out of.

## Phase 1 — Infrastructure (do this once, before the first real customer, not per-customer)

- **Deploy the server somewhere real** — `localhost` won't work for an external customer. Cheapest path: a small VM or a platform like Railway/Render/Fly.io. This is the first time actual hosting decisions matter — see GAMEPLAN.md's production-readiness checklist (most of it is still fine to skip at 1 customer, but you need *a* running, reachable instance).
- Set `ADMIN_TOKEN` on that deployment (`openssl rand -hex 32`) so you can watch the `/admin` overview once real traffic starts.
- Confirm HTTPS is in place (most hosting platforms give this for free) — sending API keys over plain HTTP would be a real security failure at the first real customer.

## Phase 2 — Get their credentials securely

- Ask for their OpenAI/Anthropic API keys through a secure channel (not Slack/email plaintext ideally — even a temporary secret-sharing link is better). Be explicit about what you'll do with them: stored server-side, used only for their own traffic, never resold or shared — this is literally what the privacy policy commits to, make sure the ask matches the promise.
- Set these as environment variables on your deployment (`${CUSTOMER_NAME_OPENAI_KEY}` style, per the existing `${ENV_VAR_NAME}` convention in `src/config/customers.example.yaml`) — never paste a real key directly into `customers.yaml`.

## Phase 3 — Configure their account

Add one entry to `customers.yaml`:
- `api_key` — generate a real, random routewize key for them (not something guessable)
- `provider_keys` — reference the env vars from Phase 2
- `default` — their current model (whatever they're already using — this is the fallback/baseline)
- `cache` — start with `enabled: true`, default `similarity_threshold: 0.92`, `ttl_seconds: 86400`. Conservative defaults, don't need tuning yet.
- `routing` — **start with no rules, or very conservative ones.** Don't invent routing rules for their traffic on day one — you don't know their prompt patterns yet. Cache-only for the first stretch is safer and still produces real savings data.
- `rate_limit` — set `max_daily_spend_usd` to something sane relative to their stated current spend. A safety net, not a restriction, in case of a routing/integration bug on either side.
- `evaluation.pricing` — **the one field that must be exactly right.** Real, current per-model rates (input/output/cached_input/cache_write_input if Anthropic) sourced from their actual provider contract or the public pricing page, with `source` and `as_of` filled in honestly. This is what makes the savings dashboard numbers real instead of estimates.

Save the file — hot-reload picks it up with no restart. Verify via server logs ("Customer config reloaded").

## Phase 4 — Verify before they ever send real traffic

- Run one real request yourself, using their new key and their real provider keys, against `/v1/chat/completions` — confirm a normal response, not a config error.
- Check `/api/stats` and `/api/financial-overview` with their key — confirm the request shows up, correctly priced.
- Check `/admin/api/overview` with your `ADMIN_TOKEN` — confirm you can see them in the cross-customer view.
- If they use streaming: this is where GAMEPLAN.md's still-open "live streaming smoke test" item finally gets resolved for real — test it explicitly before telling them to flip the switch.

## Phase 5 — Go live

- Give them one instruction: change their app's OpenAI/Anthropic base URL to your deployed routewize URL, and use the routewize key instead of their own provider key in the `Authorization` header. Nothing else in their code changes.
- **Watch closely for the first 24–48 hours** — this is a single pilot, not production-hardened infra. Check the admin overview daily.
- Confirm their `max_daily_spend_usd` cap doesn't trip unexpectedly (shows as 429s in their logs) — adjust if their real traffic volume is higher than estimated.

## Phase 6 — During the pilot

- Check in after the first few days — anything broke, latency feel different, answers feel different (routing should never change quality — verify it hasn't).
- Weekly: pull their `/api/financial-overview` numbers yourself, and manually reconcile `known_provider_spend_usd` against their actual OpenAI/Anthropic invoice for the same period. **This is the single most important step** — the whole pitch's credibility rests on this number being real, and it's the first time you'll actually know if the `evaluation.pricing` rates you configured were correct.

## Phase 7 — Wrap-up

- At the end of the pilot period, present the reconciled savings number back to them — this is the first real case study.
- Ask for a testimonial and permission to reference them (even anonymized, e.g. "a Series A SaaS company") if they're not comfortable being named.
- Decide together whether to convert to paid — this is also the point where the pricing-model decision (flat fee vs. percentage-of-savings, see NON_TECHNICAL.md) stops being theoretical.

---

One honest note: several of these steps (real hosting, HTTPS, manual invoice reconciliation) haven't been needed yet because there's been no real customer to do them for. The first pilot isn't just a sales milestone — it's also the first time several "should work in theory" pieces of the system get proven for real.
