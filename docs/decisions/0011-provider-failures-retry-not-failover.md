# ADR 0011 — Provider failures: bounded retries, explicit recovery, no silent failover

**Status:** superseded by [ADR 0012](0012-dash-ai-is-the-product.md) (retries kept; DASH AI now fails over internally before any output, and the consumer never chooses or sees a provider)

**Context.** When OpenAI or Anthropic fail (rate limits, 5xx, timeouts, malformed or cut-off streams), the
user's answer fails. Retrying can help; switching to the other provider automatically would also "help",
but it answers with a model the user did not choose (Explicit OpenAI/Claude choices, the second half of a
Compare, or the provider Dash Smart picked and labelled), and it could forward conversation context to a
provider the user did not select for it ([ADR 0005](0005-no-cross-provider-forwarding.md)).

**Decision.**
- The server retries a retryable failure **only before that request produced any output**:
  `PROVIDER_MAX_RETRIES` (default 2) with exponential backoff and jitter from `PROVIDER_RETRY_BASE_MS`
  (×4 after rate limiting, capped at 8 s, never past `PROVIDER_TIMEOUT_MS`). Once text reached the client
  or the model requested a tool, a retry would duplicate it, so the failure is final. Permanent errors
  (400/401/403/404/422) are never retried. A user cancel during a backoff stops immediately.
- SDK-level retries are off, so retries happen in one place and are counted (`dash_provider_retries_total`).
- Tools that already ran are never re-run by a retry: their results are part of the retried request.
- **No silent cross-provider failover.** A final failure is stored as a failed message and sent as
  `message.error` with `recovery: { attempts, alternatives }`; `alternatives` lists the other configured
  providers so the app can offer an explicit "try with Claude/OpenAI". Retrying the same user message with
  another choice replaces the failed answer in the same conversation (no fork, no duplicate).

**Consequences.** A provider outage still fails answers that the other provider could have given, but
never surprises the user about who answered. There is no circuit breaker: each request pays its own
attempts during an outage (bounded by the retry count and the time limit).
