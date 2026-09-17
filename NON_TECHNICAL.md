# routewize — Non-Technical Notes

Last updated: 2026-09-16

This is the counterpart to [GAMEPLAN.md](GAMEPLAN.md), [CONTEXT.md](CONTEXT.md) and [SYSTEM_DESIGN.md](SYSTEM_DESIGN.md) — those cover engineering; this covers everything else: go-to-market, positioning, outreach, and the people around the project. Nothing here is code and none of it needs a PR to update — just keep it current.

## Team & Advisors

- **Faculty guide**: a professor advising the project. Background: worked at Yahoo, SWE II at Microsoft, researcher at Oracle. *(Add name/contact here.)*

## Competitive landscape

### quotientlabs.com — "Fermat's Last Token"
- **What they do**: reduces Claude API costs 34–51% via context pruning/compression and reducing repeated tool calls, specifically for **Claude Code** (Anthropic's coding CLI).
- **Target**: developers using Claude Code who want a lower bill without changing workflow.
- **Integration**: runs alongside Claude Code as a sidecar — not a general-purpose API proxy.
- **Provider scope**: Claude only (Opus/Sonnet/Haiku/Fable). No OpenAI.
- **Pricing**: $20/mo unlimited + 10% of realized savings (metered), 2-week free trial.
- **Backing**: Y Combinator, team from Stanford/AWS/Apple/Accenture.

**How routewize differs:**

| | Fermat's Last Token | routewize |
|---|---|---|
| Target | Claude Code users specifically | Any app/product calling OpenAI or Anthropic's API |
| Integration | Sidecar to one dev tool | Drop-in proxy — swap the base URL, works with any codebase |
| Mechanism | Context compression + tool-call reduction inside the coding-agent loop | Semantic caching (skip duplicate calls) + rules-based model routing + provider-native prompt caching |
| Provider scope | Claude only | OpenAI + Anthropic |
| Use case | "Claude Code is expensive for me as a developer" | "My product/agent calls LLMs in production and the bill is too high" |

**Takeaway**: not a head-on competitor (different wedge), but real evidence the category — "cut LLM costs" as a fundable, payable problem — is validated by outside money, not just our own hypothesis.

*(Add other competitors here as they're found — OpenRouter and Backboard.io were discussed early on; see conversation history/CONTEXT.md for that comparison if it needs restating here.)*

## Finding a pilot customer

**The actual bottleneck right now is not engineering** — every savings number produced so far is synthetic. Getting one real pilot with real traffic unlocks: the live streaming smoke test, a real case study, and the dry-run tool's numbers becoming credible.

**Where to look:**
- Your own network first — anyone running an AI agent/chatbot with real LLM spend. Free, fastest trust.
- Indie hacker communities (r/SaaS, r/artificial, Indie Hackers forum, X/Twitter AI-builder circles).
- Discord/Slack communities for AI agent frameworks (LangChain, CrewAI, AutoGPT-style tools).
- Cold outreach to small AI SaaS founders who've publicly complained about their bill.

**Real, current leads found via search (2026-09-15) — people who've publicly stated this exact pain point:**
- ["We were burning $400/mo on 5 different AI API bills. So we built a single router to slash costs by 70%."](https://www.indiehackers.com/post/we-were-burning-400-mo-on-5-different-ai-api-bills-so-we-built-a-single-router-to-slash-costs-by-70-57c340190e) — Indie Hackers
- ["Bootstrapping an AI indie product in 2026? Stop overpaying for API credits"](https://www.indiehackers.com/post/bootstrapping-an-ai-indie-product-in-2026-stop-overpaying-for-api-credits-and-how-to-use-deepseek-qwen-seamlessly-dd2aad88df) — Indie Hackers
- ["The uncomfortable truth about AI tool pricing in 2026"](https://www.indiehackers.com/post/the-uncomfortable-truth-about-ai-tool-pricing-in-2026-92944b6a4d) — Indie Hackers (check replies for more leads)
- [The $4,000/Month AI Agent Bill](https://medium.com/@tijo_19511/the-4-000-month-ai-agent-bill-that-taught-me-how-to-actually-optimize-cost-e46bd114ff0e) — Medium, good citation for outreach copy

**What makes a good pilot:**
- Already spending real money on OpenAI/Anthropic (not just prototyping)
- Comfortable pointing a base URL at a third party (some won't be, for compliance reasons — skip those)
- Willing to share before/after usage data — that's the actual ask, not their money

**The offer**: free/discounted access in exchange for real traffic data + a testimonial if it works. Removes their risk, gets us the one thing blocking everything else.

## Outreach templates

**Short DM/Twitter version:**
```
Hey [name] — saw you're running [their AI product/agent]. I built routewize, a drop-in proxy for OpenAI/Anthropic that caches repeat prompts and routes simple requests to cheaper models — typically cuts LLM spend 20-50% with zero code changes beyond swapping a base URL.

Looking for 1-2 pilot users to test it on real traffic. Free to use, no strings — I just want honest before/after numbers and feedback. Interested in a quick chat?
```

**Longer email version:**
```
Subject: Free pilot — cut your OpenAI/Anthropic bill 20-50%

Hi [name],

I've been building routewize — a drop-in proxy that sits in front of your existing OpenAI/Anthropic calls. It caches semantically similar requests (instant, free reuse) and routes simple requests to cheaper models based on rules you control — same code, same model quality, lower bill.

I'm looking for 1-2 pilot customers to run it against real traffic. In exchange for early access (free), I'd just ask for:
- Permission to see aggregate usage/savings data
- Honest feedback on what breaks or what's missing

Setup is a one-line change (point your existing OpenAI/Anthropic base URL at the proxy) — nothing else in your app changes. Happy to walk you through it live if that's easier than reading docs.

Worth a 15-minute call this week?

[your name]
```

Personalize the first line per recipient — generic cold outreach gets ignored, one specific detail about what they're building gets replies.

**Working the lead list**: comment publicly on each thread first (low-effort, builds credibility), then DM the original poster directly using the template above, personalized around their specific complaint. Check replies on each thread for more leads with the same problem.

## Domain & hosting

- **Don't buy a domain yet.** A free subdomain (Vercel/Netlify/GitHub Pages) is enough to look credible in outreach DMs and doesn't block anything.
- Buy a real domain (~$10-15/yr) once a real pilot is about to click the link and it's worth looking permanent.

## Landing page spec

Goal: convert a cold visitor (from a DM/forum reply) into a pilot signup — one specific ask, not a general marketing page.

**Sections:**
1. **Header** — logo/wordmark only, no nav menu, single CTA focus.
2. **Hero** — headline ("Cut your OpenAI/Anthropic bill 20–50% — same code, same model quality"), subheadline explaining the mechanism in one sentence, primary CTA ("Apply for the free pilot"), secondary text link to "How it works."
3. **The problem** — 3 bullets max, no more.
4. **How it works** — 3 numbered steps (point base URL at us → we cache/route → you see savings live). Optional simple SVG diagram, not an image asset.
5. **What the pilot actually is** — explicit bullets: free for N days, setup < 15 min, zero lock-in, what we ask for (usage data + feedback), what we don't ask for (keys stored elsewhere, access to actual conversation content beyond routing needs).
6. **Signup form** (the functional core) — name, email, company, rough monthly spend (dropdown, qualifies leads), optional "what are you building." Wire to Formspree/Getform free tier if no backend — zero build cost, real form.
7. **Objection-handling / mini FAQ** — "Is my data safe?", "Do you see my prompts?", "What if routewize goes down?", "Can I leave anytime?"
8. **Credibility section** — no YC badge to lean on yet, so lean into transparency instead: link to the GitHub repo, link to a simplified SYSTEM_DESIGN.md, "open architecture, no black box." Once real pilot data exists, "validated on real production traffic" beats any logo wall.
9. **Footer** — GitHub link, contact email. No pricing page yet — would undercut the "free pilot" framing.

**Functional requirements (more important than visuals):** form actually submits somewhere visible, mobile-responsive, fast load (no heavy framework/build step), one clear repeated CTA, works as a raw shared link (no localhost references).

**Styling**: reuse existing brand (lime/lavender/dark palette, Plus Jakarta Sans + JetBrains Mono, established in `public/dashboard.html`/`pitch-one-pager.html`). Single column, generous whitespace, dark mode default, no carousel/animation.

**Current build status (2026-09-16)**: hero, badge ("30-day free pilot"), headline/subhead/CTA, and an interactive "request explorer" demo are already built — the interactive demo is a strong differentiator, keep it. Still missing: "How it works" section, explicit pilot-terms section, the actual wired-up signup form, objection-handling FAQ, credibility/transparency section, footer.

## Motion graphic ad concept

Chosen style: **Track Matte** (clean geometric wipe transitions), picked over Camera Pull-Back (too cinematic) and Match Cut (higher execution risk) because it best matches a "clean, Google-like" feel — flat shapes, precise wipes, restrained whitespace, no camera trickery.

Concept: use the routewize logo's own lightning-bolt shape as the recurring wipe-transition mask (ties the transition device to brand recall on every cut, instead of a generic bar/brush wipe). ~12-15 second ad: problem statement → wipe reveal of "Not with routewize" → mechanism (3 lines) → proof number count-up ("20–50% lower bill") → final logo lockup + CTA, held on a static frame.

Full beat-by-beat storyboard exists in conversation history if it needs to be handed to a motion designer — ask to have it re-generated here in full if needed.

## Positioning notes (from earlier discussion)

- **vs. OpenRouter**: OpenRouter is a model marketplace/router; routewize adds semantic caching and customer-configured routing rules with per-customer economics/savings tracking, not just access to many models.
- **vs. Backboard.io**: discussed early on — see prior conversation for the detail if this needs to be re-derived.
- **The pitch in one line**: same model quality, same code, 20–50% lower bill — because a large chunk of real-world LLM traffic is either near-duplicate (cacheable) or simple enough not to need the flagship model (routable), and both cost full price today for no reason.
