# ADR 0012 — DASH AI is the product; AI providers are internal infrastructure

**Status:** accepted (Director's provider-neutrality direction, October 2026). Supersedes
[ADR 0005](0005-no-cross-provider-forwarding.md) and [ADR 0011](0011-provider-failures-retry-not-failover.md).

**Context.** The apps used to let people choose OpenAI, Claude, "Dash Smart" or Compare, labelled every
answer with its provider and model, and offered "Try Claude" / "Change provider" on failures. That made
DASH AI look like a front end for other companies' products. The Director's direction: DASH AI is the
product; OpenAI, Anthropic, Gemini and future DASH models are infrastructure DASH chooses.

**Decision.**
- **No provider on any consumer surface** (Web, Android, API responses, SSE, fixtures, screenshots,
  accessibility labels, Demo Mode, errors). Production runs with `PROVIDER_DETAILS=hidden` (the default):
  stream targets carry only `{messageId, demo}`, routing text is DASH AI's, recovery offers no
  alternatives, conversation/sync messages have no origin/model, usage is one DASH AI total, tool activity
  has no provider, `/v1/providers` needs the operator token and consumers use `GET /v1/assistant`.
  `PROVIDER_DETAILS=exposed` is an engineering view (tests, the live smoke run); production warns if set.
- **Compare is removed** from the consumer apps (no "Model A / Model B" replacement). Explicit provider
  routes or `compare` sent by an old client are treated as DASH AI routing in hidden mode.
- **Routing is DASH's responsibility.** DASH AI's route is every configured provider, best first for the
  mode. A provider failure that happens **before anything reached the person** (no text, no tool run) and
  is retryable moves the same message to the next provider (`dash_provider_fallbacks_total{from,to,code}`).
  After partial output or a tool run there is no failover: the answer fails with a neutral message and the
  person can Retry, Regenerate or Continue later. Bounded retries from ADR 0011 still apply first.
- **Natural-language preference.** If the person's own words name a provider ("ask Claude…"), that
  provider is preferred internally when configured. Nothing is promised and nothing is shown.
- **Identity.** Every provider is instructed that it is DASH AI. Asked what it is, it answers honestly
  without naming the provider: "I'm DASH AI. DASH AI may use third-party AI infrastructure to help process
  requests." It never claims to be Claude or ChatGPT, and never says which provider served a request.
- **History is one thread.** Earlier answers are DASH AI's turns and are sent as plain text to whichever
  provider handles the request. Thinking blocks and tool-call continuations never cross providers.
- **Internal truth is kept.** Stored messages and usage records keep the real provider and model; logs and
  metrics keep provider labels. This is what a future Super Admin needs (see `provider-neutrality.md`).
- **Legal disclosure stays.** Privacy text says: "DASH AI may use third-party artificial-intelligence
  service providers to process requests." This is a processor disclosure, not branding.

**Consequences.** Clients are simpler (no selector, no Compare, two recovery actions). A provider outage
before output is invisible to the person. Model independence: a future DASH model is one more adapter in
the route, with no client change. Requires Director approval of: the export no longer including provider
identity, cross-provider plain-text history, and the operator token reusing `METRICS_TOKEN`.
