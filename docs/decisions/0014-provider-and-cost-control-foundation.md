# ADR 0014 — Provider and cost-control foundation

**Status:** proposed (branch `feature/provider-cost-control-foundation`; awaiting the Director's approval).
Builds on [ADR 0012](0012-dash-ai-is-the-product.md) and [ADR 0013](0013-amazon-bedrock-and-cost-ledger.md).

**Context.** DASH AI must be able to use more providers than OpenAI and Anthropic (Amazon Bedrock,
approved OpenAI-compatible APIs, free or promotional capacity) without exposing them to consumers,
without sending private content to providers that are not approved for it, and without spending more
than the business has decided to spend. Production currently runs with demonstration adapters only.

**Decision.**
- **Open provider identity, same contract.** A provider id is any lowercase slug; `openai`, `anthropic`
  and `bedrock` are the built-in ones. `ProviderAdapter`, the router, retries, failover and the circuit
  breaker are unchanged; new providers enter through the registry and a profile. Clients already accept
  unknown ids (Android `ProviderId.fromWire`), and consumers never see them anyway.
- **One generic OpenAI-compatible adapter**, configured by `COMPATIBLE_PROVIDERS` (base URL, model, the
  *name* of the key variable, capabilities, tasks, plans, quality, pricing class, prices, privacy class,
  quota). HTTPS only; the key variable may not name a DASH setting; unapproved by default. Only
  legitimate, officially offered APIs are to be configured.
- **Privacy classes** (`approved_sensitive`, `non_sensitive_only`, `unapproved`) and request
  **sensitivity**. Requests are sensitive by default, and always when documents or tools are involved.
  A privacy mismatch is a hard filter: such a request is refused rather than sent.
- **Pricing classes** (`free`, `promotional`, `paid`) with pool switches. A free provider is preferred
  only after it passed every hard filter and meets a quality and reliability bar; zero cost is never a
  reason on its own.
- **Quotas as windows** (requests/tokens per minute/day/month, promotional balance, unknown,
  unlimited), with a soft threshold that demotes a provider and hard exhaustion that skips it. A
  provider-reported exhausted quota or a long `Retry-After` pauses the provider for a bounded time and
  allows failover; a paused provider is not retried.
- **An append-only inference ledger** (`inference_attempts`, migration 10): one row per provider
  attempt with provider-reported tokens preferred, conservative estimates labelled as such, provider
  charges preferred over estimates, and routing metadata. No content. Rows survive account deletion
  without the account link.
- **Spend circuit breakers** read the ledger: system daily and monthly, per plan and per person, plus
  a per-request worst-case ceiling. When one trips, paid providers are excluded; free ones may still
  serve. Global switches: `AI_ENABLED`, `FREE_POOL_ENABLED`, `PAID_PROVIDERS_ENABLED`,
  `BEDROCK_FALLBACK_ENABLED`.
- **Fail closed in production.** With live paid providers, production refuses to start without daily
  and monthly limits and a price for each paid model. Bedrock, the free pool and compatible providers
  are off unless switched on. Demonstration mode is unaffected.
- **Router stays synchronous and single.** Spend status is computed before routing and passed in;
  quota state is read from an in-process tracker seeded from the ledger at start-up.

**Consequences.**
- New providers need configuration and an explicit privacy approval, not code (unless their protocol
  is new).
- Spend limits are guards with a small overshoot under concurrency, and quota counters are per instance
  between restarts; both are documented operator expectations.
- Deploying requires migrations 9 and 10 (additive) after a database snapshot; an older server refuses
  to start on the migrated schema, so rollback is by snapshot.
- Plans per account and content-based sensitivity classification remain future work.
