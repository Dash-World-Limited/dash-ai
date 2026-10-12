# Provider platform: providers, privacy, quotas, usage and cost control

DASH AI is the product; AI providers are internal infrastructure ([ADR 0012](decisions/0012-dash-ai-is-the-product.md)).
This page describes how providers are registered, which requests each may receive, how their quotas
and DASH's spending are tracked, and how a server is switched on safely. The design decision is
[ADR 0014](decisions/0014-provider-and-cost-control-foundation.md); routing itself is described in
[intelligence-router.md](intelligence-router.md).

Code: `apps/api/src/intelligence/` (`platform.ts`, `router.ts`, `policy.ts`, `quota.ts`, `spend.ts`,
`ledger.ts`, `settings.ts`) and `apps/api/src/providers/` (`compatible.ts`, `bedrock.ts`, `types.ts`).

Nothing on this page reaches consumers: no response, error, stream event or export names a provider,
a model, a price, a quota or a privacy class. Operators see all of it through `GET /v1/router`
(operator token only).

## Providers

Every provider is a `ProviderAdapter` with an internal id and a router **profile**. Provider ids are
open (`^[a-z][a-z0-9-]{1,31}$`), so a provider is added by registering an adapter and a profile, not
by changing the router or the API contracts.

| Provider | How it is registered | Default state |
| --- | --- | --- |
| `openai`, `anthropic` | Built in; key and model in the environment. | On when configured. |
| `bedrock` (Amazon Nova) | Built in; Region, Nova model ids and credentials in the environment. | **Off** until `BEDROCK_FALLBACK_ENABLED=true`, even when configured. |
| OpenAI-compatible providers | `COMPATIBLE_PROVIDERS` (JSON); one entry per approved API. | `unapproved` (receives nothing) until approved individually. |
| Demonstration adapters | `PROVIDER_MODE=fake`. | Send nothing anywhere, cost nothing, exempt from pools, privacy, quotas and spend limits. |

### Provider metadata

A profile (`policy.ts`, overridable with `ROUTER_POLICY`) carries:

| Field | Meaning |
| --- | --- |
| `enabled` | Off: never routed. |
| `capabilities` | `text`, `long_context`, `tool_use`, `image_input`, `image_generation`, `speech` … |
| `tasks` | Tasks it is suitable for (`null`: every task its capabilities allow). |
| `plans` | Account plans it may serve (`null`: every plan). |
| `inputModalities` / `outputModalities` | Default `["text"]`. |
| `streaming` | Whether answers stream. |
| `contextTokens` | Context the router may rely on. |
| `quality` | Starting quality per route key. |
| `privacy` | `approved_sensitive`, `non_sensitive_only` or `unapproved` (see below). |
| `pricing` | `free`, `promotional` or `paid`. |
| `costPerMillionInput` / `costPerMillionOutput` | Relative prices for scoring (accounting uses `MODEL_PRICES`). |

Live state is tracked beside the profile: health (reliability, latency, consecutive failures), the
circuit breaker, quota windows and pauses. The operator view (`GET /v1/router` → `platform`) shows the
profile, the models each provider may serve, their USD prices, quota status, health and circuit state,
and today's and this month's spend against the limits.

### Amazon Bedrock

Configured as before ([environment.md](environment.md): `BEDROCK_AUTH`, `BEDROCK_API_KEY` or the AWS
SDK credential chain, `BEDROCK_REGION`, `BEDROCK_MODEL_MICRO` / `_LITE` / `_NOVA2_LITE`), and in
addition switched on with `BEDROCK_FALLBACK_ENABLED=true`. Without the switch Bedrock is shown to
operators as configured but disabled and receives no requests. Credentials come only from the server's
environment (or its IAM role); the Region and model ids are configuration. The adapter streams with
`ConverseStream`, honours the request's abort signal and timeouts, reports Bedrock's token usage, and
maps errors to DASH codes the router can fail over on.

### OpenAI-compatible providers

`COMPATIBLE_PROVIDERS` is a JSON array; each entry registers one API that speaks the OpenAI Chat
Completions protocol. Only add legitimate, officially offered APIs whose terms permit this use; never
scraped, leaked, reverse-engineered or unofficial endpoints. Example with placeholder values only:

```json
[
  {
    "id": "example-free",
    "displayName": "Example inference (internal name)",
    "baseUrl": "https://api.example.com/v1",
    "apiKeyEnv": "EXAMPLE_FREE_API_KEY",
    "model": "example-model-id",
    "enabled": true,
    "timeoutMs": 30000,
    "capabilities": ["text"],
    "contextTokens": 32000,
    "maxOutputTokens": 4000,
    "tasks": ["chat", "automation"],
    "plans": null,
    "quality": 0.7,
    "pricing": "free",
    "inputPerMillion": 0,
    "outputPerMillion": 0,
    "privacy": "non_sensitive_only",
    "quota": { "windows": [{ "type": "requests_per_day", "limit": 1000 }], "softThreshold": 0.9 },
    "streamUsage": true
  }
]
```

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Internal id; may not reuse `openai`, `anthropic` or `bedrock`. Unique. |
| `baseUrl` | yes | `https://` only (plain `http://` only for `localhost` outside production); no credentials in the URL. |
| `apiKeyEnv` | yes | The **name** of the variable holding the key, ending in `_API_KEY`. It may not name one of DASH's own settings. The key itself is set separately (secret store), never in this JSON. |
| `model` | yes | Model id sent to the API. |
| `contextTokens` | yes | Context the router may rely on. |
| `pricing` | yes | `free`, `promotional` or `paid`: stated by the operator, never assumed. |
| `privacy` | no | Default `unapproved`. |
| `inputPerMillion` / `outputPerMillion` | no | USD list prices; also used for accounting unless `MODEL_PRICES` lists the model. A paid provider needs a price before production starts. |
| `capabilities`, `tasks`, `plans`, `quality`, `maxOutputTokens`, `timeoutMs`, `quota`, `enabled`, `streamUsage` | no | As in the profile table. `streamUsage: false` for APIs that reject `stream_options`. |

At most 20 entries. A provider whose key variable is unset stays off (a start-up warning says so). The
adapter asks for token usage at the end of the stream, records cached input tokens and a
provider-reported charge (`usage.cost`) when the API returns them, honours timeouts and cancellation,
and maps 429 (with `Retry-After`), exhausted quota (`insufficient_quota` and similar codes), 5xx and
credential failures to the same normalized errors as the built-in adapters. Provider error text is
never copied into DASH's messages.

## Privacy classes

| Class | Receives |
| --- | --- |
| `approved_sensitive` | Any request. The built-in providers have this class. |
| `non_sensitive_only` | Only requests DASH classified as `standard`. |
| `unapproved` | Nothing. The default for every compatible provider. |

Every request is **sensitive** unless classified otherwise. `AI_DEFAULT_SENSITIVITY=standard` lets
ordinary chat and Automates requests count as standard, but a request with attached documents or
enabled tools (private files, connected accounts) is always sensitive. The router never relaxes this:
when no eligible provider may receive a sensitive request, the request is refused with DASH AI's
neutral "temporarily unavailable" message; it is never sent anyway, and a free price does not change
that. Approving a provider is a deliberate configuration change for that one provider (its `privacy`
field), made after reviewing its data-handling terms.

## Routing

The router ([intelligence-router.md](intelligence-router.md)) filters, then scores. The filters, in order:
configured, enabled, not excluded, its pool switched on (`FREE_POOL_ENABLED` / `PAID_PROVIDERS_ENABLED`),
capabilities, task, input modalities, context window, plan, **privacy**, **spend limits** (paid only),
**per-request cost ceiling** (paid only), **paused**, **quota exhausted**. Then:

1. Providers with an open circuit or a quota above its soft threshold go to the back (last resort).
2. A provider the person named in their own words, when eligible.
3. **Free first:** a free or promotional provider that passed every filter, has quality ≥ 0.7 and
   reliability ≥ 0.8 (`ROUTER_POLICY` → `freePool`), a closed circuit and no soft quota is preferred to
   paid ones. It is never chosen *because* it costs nothing: it must already be eligible and good enough.
4. Score (quality, reliability, latency, relative cost), then a stable order.

The rest of the order are internal fallbacks. A provider that fails before any output or tool run with
a retryable error, an exhausted quota, or a configuration refusal (401/403/404) hands over to the next;
once text reached the person or a tool ran, the failure is final (no duplicate answers).

Refusals reach people in DASH AI's words: unavailable (503), "DASH AI is very busy right now" (429, all
suitable providers paused or out of quota), "You've reached today's DASH AI usage limit" (429, a
personal or plan limit), "This request is too large for DASH AI right now" (413, the per-request cost
ceiling). Automates runs record the matching neutral error.

## Quotas

`PROVIDER_QUOTAS` (JSON, keyed by provider id; compatible providers may also declare `quota` inline)
lists each provider's windows, because providers measure differently:

| Window | Counts |
| --- | --- |
| `requests_per_minute`, `requests_per_day` | Attempts. |
| `tokens_per_minute`, `tokens_per_day`, `tokens_per_month` | Input + output tokens (provider-reported, else estimated). |
| `promotional_balance` | USD of usage (`unit: "usd"`) or tokens (`unit: "tokens"`), with optional `expiresAt`; after expiry the balance counts as spent. |
| `unknown` | Nothing DASH can track: only the provider's own rate-limit answers tell. |
| `unlimited` | Contractual or unmetered capacity. |

Days and months are UTC. `softThreshold` (default 0.9) is the share of a limit at which a provider is
"approaching exhaustion": it moves behind the others but still serves as a last resort. At 100 % it is
skipped until its window resets. The status of each window (used, remaining, reset time) is in the
operator view.

**Temporary disablement.** A provider that answers with an exhausted quota is paused for its
`Retry-After` (or one hour when it gives none); a rate limit asking to wait 10 seconds or more pauses it
for that long. A paused provider is skipped and is not retried; another eligible provider serves the
request. Pauses are bounded to 24 hours and end on their own.

Counts are kept per API instance and seeded from the inference ledger at start-up (today, this month,
and all time for promotional balances), so a restart does not reset them. With several instances each
counts its own traffic between restarts; the provider's own 429 remains the final authority.

## Inference ledger (usage and cost accounting)

Every provider attempt (each retry, tool round and fallback) is one row in `inference_attempts`
(migration 10), written once and never updated:

| Column | |
| --- | --- |
| `id`, `inference_id` | The attempt, and the answer it belongs to (the chat message id or the Automates run id). |
| `user_id`, `plan`, `task`, `mode` | Who and what (user id becomes `NULL` when the account is deleted). |
| `provider`, `model`, `pricing` | Internal provider id, the model that served (or was asked), `free` / `promotional` / `paid` / `demo`. |
| `created_at`, `latency_ms` | When the attempt started, how long it took. |
| `outcome`, `error_code`, `http_status` | `success`, `failure` or `cancelled`; DASH's normalized code (`quota_exhausted`, `rate_limited`, `provider_timeout`, `provider_error`, `cancelled`). |
| `retry`, `round`, `fallback_index` | Position: retry of the same request, tool round, place in the fallback order. |
| `input_tokens`, `output_tokens`, `cached_input_tokens` | **Provider-reported**, or `NULL` when not reported. |
| `estimated_input_tokens`, `estimated_output_tokens`, `token_source` | DASH's estimate and whether the row's tokens are `provider` or `estimated`. |
| `estimated_cost_usd`, `provider_cost_usd`, `currency` | Tokens × `MODEL_PRICES` for the model that served; the provider's own charge when it reports one; `USD`. |
| `route` | Routing metadata for debugging: route key, order, scored candidates, rejections, sensitivity, the spend limit in force. |

Rules:

- Provider-reported tokens are preferred. When a provider reports none, tokens are estimated at about
  three characters per token (deliberately conservative; the router's four-characters estimate is
  never used for accounting) and labelled `estimated`.
- Cost: the provider's own charge is preferred, then the estimate; an unknown price is `NULL`, never a guess.
- An attempt the provider **refused** (an HTTP error before any output) generated nothing billable:
  estimated tokens and cost are 0. A timeout, a cancel or a failure after output may be billed and is
  estimated.
- Demonstration answers are recorded with pricing `demo` and cost 0.
- **No content**: no prompt, document, answer, tool argument or provider error text is stored.
- Accounting never breaks an answer: a failed write is logged and the answer continues.

## Cost control

| Setting | Default | Effect |
| --- | --- | --- |
| `AI_ENABLED` | `true` | `false` refuses every AI request (demonstrations included). |
| `PAID_PROVIDERS_ENABLED` | `true` | `false` keeps every paid provider out of routing. |
| `FREE_POOL_ENABLED` | `false` | Free and promotional providers may serve requests. |
| `BEDROCK_FALLBACK_ENABLED` | `false` | Bedrock may serve requests. |
| `MAX_DAILY_AI_SPEND` | — | System-wide paid spend per UTC day (USD). |
| `MAX_MONTHLY_AI_SPEND` | — | System-wide paid spend per UTC month (USD). |
| `MAX_USER_DAILY_AI_SPEND` | — | Paid spend per account per UTC day. |
| `AI_PLAN_DAILY_SPEND` | — | JSON `{"<plan>": usd}`: paid spend per plan per UTC day. |
| `MAX_REQUEST_AI_COST` | — | Ceiling on a paid provider's worst case for one request: the dearest model it may use, the conservative input estimate and the full `MAX_OUTPUT_TOKENS`. A paid model with no price is not used under a ceiling. |
| `AI_DEFAULT_PLAN` | `standard` | Every account's plan until plans are assigned per account. |
| `AI_DEFAULT_SENSITIVITY` | `sensitive` | See privacy classes. |

**The spend circuit breaker.** Before routing, DASH sums paid spend from the ledger (provider charge,
else estimate) and works out the tightest allowance left across the configured limits (monthly, daily,
plan, person). A paid provider may serve the request only if its **worst case** fits in that allowance:
the dearest model it may use, everything sent (system prompt, tool schemas, history, documents and the
message, at about three characters per token) and the full `MAX_OUTPUT_TOKENS`, once for each provider
request the answer may make (a request that offers tools may take `TOOL_MAX_ROUNDS` tool rounds and a
final answer). A paid model with **no price** never fits: under any configured limit it is not used, at
run time as well as at start-up. Excluded paid providers leave free providers to serve the requests
they are eligible for; otherwise the request is refused neutrally. Free, promotional and demonstration
usage never counts against the paid limits. System totals are cached for at most five seconds and
refreshed after every paid attempt on the same instance.

An answer whose served model id has no price (providers often report a dated snapshot of the alias the
operator priced) is charged at the configured model's price, so it can never count as free.

**Safe defaults.** With none of the new variables set, a server behaves as before for OpenAI and
Anthropic, Bedrock stays off, no compatible provider exists, and the free pool is off. Production with
`PROVIDER_MODE=live` and any paid provider enabled **refuses to start** without `MAX_DAILY_AI_SPEND` and
`MAX_MONTHLY_AI_SPEND` and without a `MODEL_PRICES` price for each paid model (OpenAI, Anthropic, each
configured Nova tier when Bedrock is enabled, each paid compatible provider), so spend limits can never
silently count nothing. `PROVIDER_MODE=fake` is unaffected.

**What a limit guarantees.** A request admitted on its own cannot take spend past a limit: it was let
in only because its worst case fitted. Requests running at the same time are each admitted against the
same recorded spend, so together they can pass a limit by at most the sum of their worst cases (and,
across instances, by what was spent in the last five seconds of cached totals). An attempt that a
timeout or cancellation cut short is estimated as possibly billed; a provider retry of such an attempt
is not part of the worst case. Because admission reserves the worst case, a limit stops new paid
requests slightly before it is reached: lower `MAX_OUTPUT_TOKENS` to leave more of a small limit usable.

## Metrics (internal)

`dash_ai_inference_attempts_total{provider,pricing,outcome}`, `dash_ai_attempt_cost_usd_total{pricing}`,
`dash_ai_provider_pauses_total{provider,reason}`, `dash_ai_spend_blocked_total{scope}` (requests for which a
limit kept paid providers out), `dash_ai_ledger_write_failures_total` (alert on any increase: spend limits
under-count while ledger writes fail), plus the existing
router, failure, retry, fallback and estimated-cost counters.

## Safe production rollout

Nothing here is deployed by merging. When the operator decides to roll it out:

1. **Back up the database** (snapshot) before upgrading.
2. **Migrations.** This release adds three additive migrations (no existing data is changed or deleted):
   - `9 usage_estimated_cost`: `ALTER TABLE usage_records ADD COLUMN estimated_cost_usd double precision` (nullable).
   - `10 inference_ledger`: `CREATE TABLE inference_attempts (…)` with indexes on `created_at`,
     `(user_id, created_at)` and `inference_id`; `user_id` references `users` with `ON DELETE SET NULL`.
   - `11 inference_ledger_integrity`: adds the nullable `configured_model` column and CHECK constraints
     (known pricing, outcome, token source and currency values; no negative tokens, counts, latency or
     costs) so the database refuses ledger rows that would corrupt spend totals.
   Production has `DATABASE_AUTO_MIGRATE=false`: run `pnpm --filter @dash-ai/api migrate` (or
   `node apps/api/dist/migrate-cli.js`) against the production database before starting the new
   version. **Rollback:** the previous server version refuses to start on a database that has
   migrations it does not know, so going back after migrating means restoring the snapshot from step 1
   (or an operator reverting migrations 11, 10 and 9 by hand, which discards the ledger and the cost column).
3. **Deploy with the current mode first.** With `PROVIDER_MODE=fake` nothing changes for people;
   check `/health`, `/ready` and that demonstration answers appear in `inference_attempts` with
   pricing `demo` and cost 0.
4. **Before any live provider:**
   - CI is green on the exact commit being deployed.
   - Set `MAX_DAILY_AI_SPEND`, `MAX_MONTHLY_AI_SPEND` (and optionally the per-person, per-plan and
     per-request limits) and `MODEL_PRICES` for every paid model, confirmed against the provider's
     current official price list for the deployed Region (the built-in Amazon Nova prices are estimates).
   - Configure the provider's own budget alerts or hard limits where it offers them (AWS Budgets, the
     provider console's usage limits): DASH's limits are the first line, not the only one.
   - Review the provider's current privacy and data-use terms for the traffic it will receive, and
     record the decision in its privacy class (`ROUTER_POLICY` or `COMPATIBLE_PROVIDERS`).
   - Keep provider credentials in the server's secret store only, never in app bundles or the repository.
   - Keep `FREE_POOL_ENABLED=false` and `BEDROCK_FALLBACK_ENABLED=false` unless that provider is part of the plan.
5. **Switch one provider on in staging** first ([staging-runbook.md](staging-runbook.md)) with an
   explicitly approved, tiny and bounded smoke test; watch the ledger, `/metrics` (alert on
   `dash_ai_ledger_write_failures_total`) and the operator view, then repeat in production with one
   provider and a rollback path to the previous provider mode.
6. **Emergency stops:** `AI_ENABLED=false` stops all AI; `PAID_PROVIDERS_ENABLED=false` stops paid
   inference; a lower spend limit stops paid inference once spend reaches it. Each needs only an
   environment change and a restart, and applies from the first request after it.

## Known limits

- Quota counters and health are per instance (seeded from the ledger at start-up).
- Plans: every account is on `AI_DEFAULT_PLAN`; assigning plans per account is future work.
- Spend sums read the ledger; at very high volume they should move to pre-aggregated totals.
- Retention: ledger rows hold no content, but they are kept indefinitely until a retention period is
  decided (accounting usually needs at least the current and previous financial year); a purge would
  then delete rows older than the period, which only lowers sums for windows already closed.
- Concurrent requests can together pass a limit by the sum of their worst cases (see *What a limit
  guarantees*); with several API instances, add up to five seconds of cached system totals.
- Sensitivity is classified from structure (documents, tools) and the operator default, not from
  content; content classification is future work.
