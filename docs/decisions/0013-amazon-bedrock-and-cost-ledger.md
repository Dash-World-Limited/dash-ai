# ADR 0013 — Amazon Bedrock (Amazon Nova) as an internal provider, and an estimated-cost ledger

**Status:** proposed (branch `feature/bedrock-first-live-provider`; awaiting the Director's approval).
Builds on [ADR 0012](0012-dash-ai-is-the-product.md); the DASH Intelligence Router is unchanged.

**Context.** The Director wants Amazon Bedrock, with the Amazon Nova models, available as a live
provider (possibly the first one in production) without exposing it to consumers, and wants each real
answer's cost recorded so spending can be followed per provider and model.

**Decision.**
- **Bedrock is one more `ProviderAdapter`** (`apps/api/src/providers/bedrock.ts`) with the internal id
  `bedrock`. The router, its policy format, retries, failover rules, the circuit breaker, Automates,
  tools and Demo Mode are unchanged; Bedrock enters through the provider registry and a default router
  profile like any provider.
- **Official SDK, streaming.** The adapter calls the Converse streaming API through
  `@aws-sdk/client-bedrock-runtime` (`ConverseStream`), so text reaches the person as it is generated
  and the idle timeout means what it means for the other providers. The SDK makes one attempt; DASH
  retries in the orchestrator as for every provider.
- **Two ways to authenticate**, chosen explicitly with `BEDROCK_AUTH`: `api_key` (a Bedrock API key as a
  bearer token, `BEDROCK_API_KEY`) or `iam` (the AWS SDK default credential chain, SigV4). AWS recommends
  IAM credentials for production; API keys are convenient to start with.
- **Nova tiers are the adapter's choice, not the router's.** The router picks the provider; the adapter
  picks among the Nova tiers the operator configured (`BEDROCK_MODEL_MICRO`, `_LITE`, `_NOVA2_LITE`) from
  internal routing hints (task, mode, preference, estimated input). The router relies on the smallest
  tier's context (128k), so it never promises more than every valid setup has. Output ceilings per tier
  are conservative (asking a model for more than it allows is a request error with no failover).
- **Bedrock-safe tool names.** Bedrock receives each DASH tool under an alias of letters, digits and
  `_`; its tool calls are mapped back, so the tool layer only sees DASH's names.
- **Errors are classified, never copied.** Bedrock errors map to DASH codes by type and HTTP status.
  Throttling becomes a rate limit, timeouts and outages become retryable, rejected credentials or model
  access (403/401) and a model id the account or Region cannot use (404) become configuration failures
  that may fall over to another provider. A request Bedrock rejects as invalid (400) is not sent elsewhere.
- **No fake twin.** Demo Mode keeps its two deterministic adapters; Bedrock settings are ignored while
  `PROVIDER_MODE=fake`.
- **Production refuses incomplete Bedrock settings at start-up**, naming variables only: a Region and at
  least one Nova model are required once a key or model is set, each model must be an id of its own
  tier, the Region must look like an AWS Region, and an API key with `BEDROCK_AUTH=iam` is refused. A
  Region or auth mode on its own (templates preset them) does not switch Bedrock on.
- **Estimated-cost ledger.** Every usage record gets `estimated_cost_usd` (migration 9): tokens × USD
  price per million for the model that served the answer. Built-in prices cover the three Nova tiers as
  estimates; `MODEL_PRICES` overrides them and prices OpenAI/Anthropic models, which otherwise stay
  `null` (unknown), never a guess. Demonstrations cost 0. The estimate is internal: it is in the
  database and in `/metrics` (`dash_ai_estimated_cost_usd_total{provider}`), never in consumer responses.
- **The model recorded is the one that served the answer** (chat and Automates alike): for Bedrock
  the Nova tier chosen for that request, for OpenAI/Anthropic the id the provider reports. Costs are
  therefore attributed to the right model.

**Consequences.**
- A server can run Bedrock alone, or Bedrock with OpenAI and/or Anthropic and fall over between them.
- The cost ledger is only as good as its prices: the built-in Nova prices must be confirmed for the
  deployed Region (`MODEL_PRICES` corrects them without a code change).
- Deploying this release requires running the database migration before starting the new version.
- Converse cannot switch tools off for one round; on the orchestrator's final tool round the tool list
  stays and the model is instructed to answer directly (the orchestrator never acts on tool calls from
  that round anyway).
