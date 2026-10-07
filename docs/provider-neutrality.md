# Provider neutrality, routing and internal observability

DASH AI is the product. OpenAI, Anthropic and any future provider (Gemini, a DASH model) are
infrastructure DASH chooses per request. Decision record: [ADR 0012](decisions/0012-dash-ai-is-the-product.md).

## What people see, and what they never see

| Surface | Shows | Never shows |
| --- | --- | --- |
| Web and Android chat | "DASH AI" on every answer ("Demo · DASH AI (simulated)" in Demo Mode); the composer line "DASH AI · <mode>" | Provider or model names, a provider chip or sheet, Compare, "Try <provider>", "Change provider" |
| Failures | "DASH AI couldn't complete that response", "…is very busy right now", "…took too long to respond", "DASH AI is temporarily unavailable"; actions **Retry** and **Continue later** (plus **Regenerate** on any answer) | Which provider failed, any offer to switch provider |
| Settings | Appearance, chat defaults (mode), privacy & security, sessions, tools, data/sync, documents, Demo Mode, server (Android dev builds) | A provider selector or per-provider rows |
| Account | Usage as one DASH AI total | Per-provider usage |
| Privacy text | "DASH AI may use third-party artificial-intelligence service providers to process requests." (processor disclosure) | Provider brands |
| API / SSE (`PROVIDER_DETAILS=hidden`, the default) | `stream.start` targets `{messageId, demo}`; neutral `routingReason`; `message.error` with neutral text and `recovery.alternatives: []`; messages with `origin: null, model: null`; `GET /v1/assistant` → `{available, demo, research}` | Provider/model fields; `/v1/providers` without the operator token (404) |
| Export (`/v1/me/export`, Android local export) | Conversations, messages, prompts, documents | Provider and model per message |

Tools and plugins are user capabilities ("Tools & Connections"), unrelated to providers.

`PROVIDER_DETAILS=exposed` restores the engineering view (provider and model in responses, explicit
routes, Compare). It exists for the API test suite and the live provider smoke run
([provider-verification.md](provider-verification.md)); production config warns if it is set.

## Routing (server)

1. **Route.** `smartRoute(mode, configured, hint)` in `packages/contracts/src/routing.ts`: every
   configured provider, ordered by the mode's preference table (`SMART_ROUTING`, shared with Android and
   checked against `fixtures/smart-routing.json`).
2. **Natural-language hint.** `providerHint(text)` returns a provider only when the person's own message
   names exactly one ("ask Claude", "like ChatGPT"); it moves that provider to the front if configured.
   Nothing is shown or promised. Unknown names (Gemini today) are ignored.
3. **Retries.** Bounded retries of retryable errors before any output (unchanged from ADR 0011).
4. **Failover.** If the provider still fails **before any text or tool run reached the person**, the same
   message goes to the next provider in the route. After partial output or a tool run there is no
   failover: the answer fails neutrally and the partial text is kept.
5. **Identity.** `IDENTITY_INSTRUCTIONS` (`apps/api/src/providers/instructions.ts`) tells every provider it
   is DASH AI, never Claude or ChatGPT, and how to answer "what are you?" honestly without naming the
   provider: "I'm DASH AI. DASH AI may use third-party AI infrastructure to help process requests."
6. **History.** Earlier answers are DASH AI's turns, sent as plain text to whichever provider answers.
   Thinking blocks and tool-call continuations never cross providers.

Clients send `modelChoice: "smart"` (or nothing). Older clients sending `openai`, `claude` or `compare`
are routed the same way in hidden mode.

## Internal observability (kept on purpose)

| Where | What is recorded |
| --- | --- |
| `messages.origin`, `messages.model` (PostgreSQL) | The provider and model that actually wrote each answer |
| `usage_records` rows | Provider, model, input/output tokens, demo flag, per answer |
| `tool_invocations` | Provider per tool call (names and outcomes only) |
| Logs | `retrying provider request`, `provider fallback {from,to,code,attempts}`, served-model mismatches |
| Metrics (`/metrics`, `METRICS_TOKEN`) | `dash_ai_request_seconds{provider,status}`, `dash_provider_failures_total{provider,code,retryable}`, `dash_provider_retries_total{provider,code}`, `dash_provider_fallbacks_total{from,to,code}` |
| `GET /v1/providers` with `Authorization: Bearer $METRICS_TOKEN` | Configured providers, modes and models |

Metric labels are identifier-only (no prompt or answer text can become a label).

## Super Admin: data that is preserved (not built yet)

No Super Admin console is built in this milestone. The data it will need already exists or is defined:

- **Provider usage, routing and fallback:** usage rows (provider, model, tokens per answer), the fallback
  and failure counters above, and the per-message `origin`/`model`.
- **Latency:** `dash_ai_request_seconds` per provider and status.
- **Cost:** derivable from usage tokens × a per-model price table (to be added with the console; prices
  are not hard-coded today).
- **People and reach, kept as distinct concepts:**
  - *registered users* — accounts (`users` table);
  - *active users* — accounts with a session or message in a period (sessions and messages carry
    timestamps);
  - *installs*, *first opens* and *downloads* — **not measured yet**. They need store and analytics data
    (Google Play Console for downloads/installs; a privacy-reviewed first-open event for the apps) and
    must not be inferred from accounts.
- **No invasive device fingerprinting.** Any future install or first-open measurement uses an app-scoped
  random identifier or store statistics, never hardware identifiers or fingerprinting.

## Model independence

Providers are adapters behind `ProviderAdapter` (`apps/api/src/providers/`). A future DASH model is one
more adapter and one more id in the routing table; clients, contracts for consumers and fixtures do not
change, because consumers never see provider identity.

## Tests that hold this in place

- API: `provider-neutrality.test.ts` (leak scan of every consumer response and SSE event, explicit routes
  coerced, operator-only provider view, failover before output only, neutral errors after partial output
  and after tool runs, identity prompt, named-provider hint, internal diagnostics keep the provider).
- Contracts: consumer fixtures contain no provider names; routing helpers.
- Web: unit tests for labels and recovery; E2E scan of visible text, `aria-label`, `title`, `alt` and
  placeholders on Home, Chat, the mode sheet, Settings, Account, Tools, Documents, Prompts and recovery.
- Android: core tests (labels, recovery, Demo Mode, routing, history), live API contract tests against
  the neutral API, and UI tests scanning text and content descriptions on Chat, the mode sheet,
  Settings, Account and recovery.
