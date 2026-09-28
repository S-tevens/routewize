# Provider integrations

Routewize supports **11 provider IDs** for its existing text-chat interface.
The nine new adapters have offline SDK and HTTP fixture coverage, not live
provider certification. Model availability, access, accepted parameters and
quotas depend on the customer's account. Use a provider's exact model ID,
including any organization/account prefix; Routewize does not invent aliases.

| Config ID | Destination | Primary documentation |
|---|---|---|
| `openai` | Existing native adapter | Existing README |
| `anthropic` | Existing native adapter | Existing README |
| `gemini` | Google Gemini OpenAI compatibility API | https://ai.google.dev/gemini-api/docs/openai |
| `openrouter` | OpenRouter chat completions | https://openrouter.ai/docs/api/reference/overview |
| `groq` | Groq OpenAI-compatible API | https://console.groq.com/docs/api-reference |
| `mistral` | Mistral chat completions | https://docs.mistral.ai/resources/migration-guides |
| `deepseek` | DeepSeek chat completions | https://api-docs.deepseek.com/api/create-chat-completion/ |
| `together` | Together AI OpenAI-compatible API | https://docs.together.ai/docs/inference/openai-compatibility |
| `fireworks` | Fireworks inference API | https://docs.fireworks.ai/tools-sdks/openai-compatibility |
| `xai` | xAI chat completions | https://docs.x.ai/developers/rest-api-reference/inference |
| `cerebras` | Cerebras inference API | https://inference-docs.cerebras.ai/api-reference/chat-completions |

## Setup

1. Obtain a provider API key and model access in the customer's account. Ensure
   the customer authorizes sending their workload to that provider.
2. Add the key through an environment placeholder under `provider_keys` in
   local `customers.yaml`. Never commit credentials.
3. Select `provider` and `model` in `default` or a `routing.rules[].route_to`.
4. Add verified rates under `evaluation.pricing` for **each new-provider model**
   referenced by a default or rule. These are required even when live evaluation
   is disabled. Rates use USD per million tokens, with a source and date.
5. Config hot-reload validates the update and keeps the old config if invalid.
   Run a small JSON and streaming smoke test before using real customer traffic.

Illustrative configuration below: replace the model placeholder and all `null`
rates with actual values from your contract. It deliberately cannot pass
validation unchanged, rather than silently guessing a price.

```yaml
customers:
  - name: Your company
    api_key: "${ROUTEWIZE_CUSTOMER_KEY}"
    provider_keys:
      gemini: "${CUSTOMER_GEMINI_KEY}"
    default:
      provider: gemini
      model: YOUR_EXACT_MODEL_ID
    cache:
      enabled: false
    rate_limit:
      requests_per_minute: 60
      max_daily_spend_usd: 5
    evaluation:
      enabled: false
      pricing:
        "gemini/YOUR_EXACT_MODEL_ID":
          input: null
          output: null
          cached_input: null
          source: "Your verified provider pricing page or contract"
          as_of: "2026-09-28"
```

Change `gemini` to another ID above to use its adapter. For namespaced IDs such
as `org/model`, the pricing key is `together/org/model`, for example. Supplying
one provider's key never authorizes a call to another. Client request `model`
does not override the server's routing policy; the configured default/rules
continue to decide the destination.

Normal SDK clients keep using Routewize's `/v1/chat/completions`, including
`stream: true`. Authenticated `GET /api/providers` returns supported IDs and
configured-key flags. A configured flag is not a credential validity/health check.

## Supported scope and boundaries

- Text messages, a single text answer, optional temperature and max_tokens,
  JSON and SSE, existing deterministic rules, semantic response cache, and paid
  evaluation. Some models reject optional sampling parameters; omit those
  parameters or choose a compatible model rather than assuming universality.
- No tools, structured outputs, image/audio/video inputs, native Responses API,
  provider search, or agent APIs are added by these adapters. Use ordinary text
  models, not provider compound/search products with extra billable services.
- No automatic cross-provider fallback. An error does not silently send a
  customer's data to a different provider.
- Endpoints are fixed HTTPS destinations and redirects are rejected for new
  adapters. Arbitrary base URLs, Azure deployment URLs, Bedrock IAM, Vertex IAM,
  local inference and regional endpoint selection are not implemented here.
- Embeddings remain OpenAI or mock. Disable caching if the customer has only a
  non-OpenAI key, or supply their OpenAI embedding key for real semantic caching.
  Mock embeddings are for offline tests, not a production accuracy claim.
- Near-miss verification continues to use its existing OpenAI/Anthropic judges.
  OpenRouter chat support is separate from the Jev Decisions API feature PR.

## Cost and streaming behavior

New adapters require valid reported input/output token counts and normalize
DeepSeek cached tokens and Groq stream usage. Repeated cumulative usage emits
only one final usage event. Mistral/Cerebras use their ordinary streaming request
without `stream_options`; other profiles request `include_usage`. Missing final
usage, an unsuccessful finish, or an upstream stream error prevents caching and
logs unknown provider spend. Errors after headers are delivered as SSE errors.
Already-delivered partial text cannot be retracted. Failed calls can still cost
money, and unknown charges cannot be enforced precisely by the spend guard.

Provider-qualified configured rates avoid collisions between providers hosting
the same model name. Gemini and other direct providers are priced from reported
usage at those rates. OpenRouter financial spend requires reported `usage.cost`
to capture its billing; this is not invoice reconciliation. OpenRouter native
prompt-cache savings remain unknown because aggregate cost alone does not prove
the split. Known new-provider costs update spend limits and preserve negative
savings. Unsupported billing categories remain unknown, not free.

Routing/cache forecasts and dry runs are explicitly estimates using configured
input/output rates. They cannot predict dynamic pricing, tier changes, retries,
aggregator fees, cache state, or all future bills. Use rates appropriate to the
workload/context tier and compare against actual invoices before claiming savings.
OpenAI/Anthropic's historical estimate behavior remains unchanged.

## Validation

`npm test` covers all nine adapters' endpoints, credentials, payloads, streaming
usage normalization, evaluation, cost handling, and full proxy JSON/SSE paths.
Fixtures check tenant isolation, cache reuse, early/mid-stream failures, missing
usage, and unknown-spend records. No real provider calls or credentials are used.
Live smoke tests and model-specific compatibility checks remain required for
each production account/model. Public API integration does not imply a formal
provider partnership or blanket resale permission.
