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
| `bedrock` (Amazon Nova) | Built in; Region, Nova model ids and credentials in the environment. | **Off** until `BEDROCK_ENABLED=true`, even when configured. |
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
addition switched on with `BEDROCK_ENABLED=true` (formerly `BEDROCK_FALLBACK_ENABLED`, see below). Without the switch Bedrock is shown to
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
| `BEDROCK_ENABLED` | `false` | Bedrock may serve requests. `BEDROCK_FALLBACK_ENABLED` is its deprecated former name (see below). |
| `MAX_DAILY_AI_SPEND` | — | System-wide paid spend per UTC day (USD). |
| `MAX_MONTHLY_AI_SPEND` | — | System-wide paid spend per UTC month (USD). |
| `MAX_USER_DAILY_AI_SPEND` | — | Paid spend per account per UTC day. |
| `AI_PLAN_DAILY_SPEND` | — | JSON `{"<plan>": usd}`: paid spend per plan per UTC day. |
| `MAX_REQUEST_AI_COST` | — | Ceiling on a paid provider's worst case for one request (see *The spend circuit breaker*). A paid model with no price is not used under a ceiling. |
| `AI_DEFAULT_PLAN` | `standard` | Every account's plan until plans are assigned per account. |
| `AI_DEFAULT_SENSITIVITY` | `sensitive` | See privacy classes. |

**The spend circuit breaker.** Before routing, DASH sums paid spend from the ledger (provider charge,
else estimate) and works out the tightest allowance left across the configured limits (monthly, daily,
plan, person). A paid provider may serve the request only if its **worst case** fits in that allowance
(and under `MAX_REQUEST_AI_COST`). The worst case is the dearest model the provider may use, over every
provider request the answer may make:

- **Requests.** One, or for a request that offers tools, `TOOL_MAX_ROUNDS` tool rounds and the final
  answer with tool use off (`TOOL_MAX_ROUNDS + 1` requests).
- **Input of each request**, in the ledger's estimated tokens (about three characters per token). The
  first request is everything it sends: system prompt, tool schemas, history, rendered documents and the
  message. Each later round re-sends everything before it, so round *k* is budgeted the first request
  plus *k* rounds of growth, and never more than the provider's context window (`contextTokens` in its
  router profile). One round's growth is its own output sent back (the output cap at up to four
  characters per token) plus its tool results (every call that may run, `MAX_TOOL_CALLS_PER_ROUND` = 8,
  at `TOOL_MAX_RESULT_CHARS` plus a small margin).
- **Output of each request**: the model's output cap, which is `MAX_OUTPUT_TOKENS`, or less where the
  adapter knows the model's real limit and never asks for more (Amazon Nova Micro and Lite: 5,000
  tokens; Nova 2 Lite: 64,000; an OpenAI-compatible provider's declared `maxOutputTokens`). A cap is
  never raised above `MAX_OUTPUT_TOKENS`.

**Budgets are enforced, not only priced.** Once a paid provider is admitted on its worst case, every
request of that answer is held to its round's input budget. If tool results or the model's own output
grew past the budget (for example a model that wrote far more characters per token than assumed, or
asked for more calls than may run), DASH answers right away with tool use off, provided the final
answer's budget still covers the request (the answer then makes fewer requests than admitted). If even
that would not fit, the answer ends there with finish reason `length`, and nothing more is sent.
Without any spend limit or ceiling nothing is reserved, so nothing is enforced.

A paid model with **no price** never fits: under any configured limit it is not used, at run time as
well as at start-up. Excluded paid providers leave free providers to serve the requests they are
eligible for; otherwise the request is refused neutrally. Free, promotional and demonstration usage
never counts against the paid limits.

**In-flight spend reservations** ([ADR 0015](decisions/0015-atomic-spend-reservations.md)). The check
above only picks the route. A paid request is admitted when its **reservation** succeeds: in one
PostgreSQL transaction, holding an advisory lock for each limited scope (system, plan, person; taken in
one fixed order), one statement reads every scope's ACTUAL spend (the ledger) and RESERVED spend (what
requests still in flight may yet spend: each active hold minus its own ledger rows so far) and inserts a
hold of the route's worst case only if, for every limit, `actual + reserved + this hold ≤ limit`. The hold
is the dearest worst case among the paid providers in the route, so a fallback inside the route is
covered. If another request took the room meanwhile, DASH routes once more on the database's fresh
numbers (a free provider may still serve) and otherwise refuses with the usual limit message. When the
request ends, whatever the outcome, the hold is **settled** to the request's paid ledger cost (`settled`,
or `released` when nothing was billed) and stops counting. A hold that is never settled (a crashed
process) stops counting when its lease ends: the request's enforced execution bound (`PROVIDER_TIMEOUT_MS`
for chat, the run's time budget for Automates) plus two minutes, on the database clock. Lapsed rows are
marked `expired` and finished rows older than 30 days deleted by lazy housekeeping after admissions; nothing
depends on it running. If the hold cannot be checked (database unavailable, a scope's lock busy for more
than three seconds) the paid request is refused as busy: spend control fails closed.

System totals in the check are cached for at most five seconds; the reservation never uses the cache.
With only per-person limits configured, different people's admissions never wait for each other; a system
limit serializes admissions (only the short admission statement, never the provider call).

An answer whose served model id has no price (providers often report a dated snapshot of the alias the
operator priced) is charged at the configured model's price, so it can never count as free.

**Safe defaults.** With none of the new variables set, a server behaves as before for OpenAI and
Anthropic, Bedrock stays off, no compatible provider exists, and the free pool is off. Production with
`PROVIDER_MODE=live` and any paid provider enabled **refuses to start** without `MAX_DAILY_AI_SPEND` and
`MAX_MONTHLY_AI_SPEND` and without a `MODEL_PRICES` price for each paid model (OpenAI, Anthropic, each
configured Nova tier when Bedrock is enabled, each paid compatible provider), so spend limits can never
silently count nothing. `PROVIDER_MODE=fake` is unaffected.

**What a limit guarantees.** A request admitted on its own cannot take spend past a limit, as DASH
estimates it: it was let in only because its worst case fitted, and none of its provider requests may
send more than that worst case budgeted. The guarantee is stated in the ledger's own terms: input is
the estimate above, and an answer is charged the provider's reported usage. A provider whose tokenizer
counts more tokens than the three-characters-per-token estimate for the same text (unusual scripts,
dense code or data) can bill more input than was reserved; output never exceeds the cap sent. Before
in-flight reservations, requests running at the same time were each admitted against the same recorded
spend, so together they could pass a limit by the sum of their worst cases (and, across instances, by
what was spent in the last five seconds of cached totals). This is **closed by in-flight reservations**: requests running at the same
time, on any number of instances sharing the database, are admitted only while their holds fit together
with actual spend. An attempt that a timeout or cancellation cut short is estimated as possibly billed; a
provider retry of such an attempt, and a fallback to the next provider after a billed failure, are not
part of the worst case (they still charge the same hold through the ledger; an actual above the hold is
logged and counted as `dash_ai_spend_reservation_overage_total`). Because admission reserves the worst case, a limit stops
new paid requests before it is reached; tool-using answers reserve the most.
Explicit engineering routes (`PROVIDER_DETAILS=exposed`, which production refuses to start with) only
check that no limit is already reached.

### Renamed: `BEDROCK_ENABLED`

`BEDROCK_ENABLED` replaces `BEDROCK_FALLBACK_ENABLED` (the switch turns Bedrock on as a provider, not
only as a fallback). The old name is **deprecated but still read**:

| `BEDROCK_ENABLED` | `BEDROCK_FALLBACK_ENABLED` | Result |
| --- | --- | --- |
| unset | unset | Bedrock off. |
| set | unset | Its value. |
| unset | set | Its value, and a start-up warning to rename it. |
| same value | same value | That value, and a start-up warning to remove the old name. |
| different values | different values | **The server refuses to start** (no silent precedence). |

An empty value counts as unset. The old name will be removed in a later release, after every
environment has been renamed.

## Metrics (internal)

`dash_ai_inference_attempts_total{provider,pricing,outcome}`, `dash_ai_attempt_cost_usd_total{pricing}`,
`dash_ai_provider_pauses_total{provider,reason}`, `dash_ai_spend_blocked_total{scope}` (requests for which a
limit kept paid providers out), `dash_ai_ledger_write_failures_total` (alert on any increase: spend limits
under-count while ledger writes fail), `dash_ai_spend_reservations_total{outcome}` (admitted, denied, error),
`dash_ai_spend_reservation_settlements_total{status}`, `dash_ai_spend_reservations_expired_total` (holds whose
request never settled: alert on a steady rise), `dash_ai_spend_reservation_failures_total{stage}`,
`dash_ai_spend_reservation_overage_total` and `_overage_usd_total` (alert on any increase: an actual cost
above its hold), plus the existing
router, failure, retry, fallback and estimated-cost counters.

## Safe production rollout

Nothing here is deployed by merging. When the operator decides to roll it out:

0. **Deployment blocker until verified: which migration 10 has each database run?** Two competing
   implementations of this milestone both numbered their ledger migration 10. Only this one
   (`10 inference_ledger`) is supported. Whether a staging database ever ran the other one is **not
   known**, so before upgrading any database that has been migrated since 2026-10-09, run this
   **read-only** query against it (do not change the database to investigate):

   ```sql
   SELECT id, name
   FROM schema_migrations
   WHERE id >= 10
   ORDER BY id;
   ```

   - **Safe:** no rows (the database predates both; it will receive 9 if missing, then 10 and 11), or
     `10 | inference_ledger` alone, or `10 | inference_ledger` then `11 | inference_ledger_integrity`.
   - **Unsafe:** `10 | inference_attempt_ledger`, or any other name for 10 or 11, or an id above 11.
     That database ran the other implementation's migration. Do not deploy to it. The new server would
     refuse to start anyway (each applied migration's checksum is verified), so nothing is corrupted
     silently; the remedy (restoring a snapshot taken before that migration, or rebuilding a disposable
     staging database) needs the owner's approval first.
   - If `schema_migrations` does not exist, the database was never migrated: safe.

1. **Back up the database** (snapshot) before upgrading.
2. **Migrations.** These releases add four additive migrations (no existing data is changed or deleted):
   - `9 usage_estimated_cost`: `ALTER TABLE usage_records ADD COLUMN estimated_cost_usd double precision` (nullable).
   - `10 inference_ledger`: `CREATE TABLE inference_attempts (…)` with indexes on `created_at`,
     `(user_id, created_at)` and `inference_id`; `user_id` references `users` with `ON DELETE SET NULL`.
   - `11 inference_ledger_integrity`: adds the nullable `configured_model` column and CHECK constraints
     (known pricing, outcome, token source and currency values; no negative tokens, counts, latency or
     costs) so the database refuses ledger rows that would corrupt spend totals.
   - `12 spend_reservations` (atomic spend reservations, [ADR 0015](decisions/0015-atomic-spend-reservations.md)):
     `CREATE TABLE spend_reservations (…)` with CHECK constraints, a unique `inference_id`, partial indexes
     on active holds; and `inference_spend_daily`, paid ledger cost per UTC day and plan, kept equal to the
     ledger by a trigger on `inference_attempts` and backfilled from it. No existing row is changed. The
     backfill reads the whole ledger and blocks ledger writes until the migration commits; on a large
     ledger run it in a quiet period.
   Production has `DATABASE_AUTO_MIGRATE=false`: run `pnpm --filter @dash-ai/api migrate` (or
   `node apps/api/dist/migrate-cli.js`) against the production database before starting the new
   version. **Rollback:** the previous server version refuses to start on a database that has
   migrations it does not know, so going back after migrating means restoring the snapshot from step 1
   (or an operator reverting migrations 12, 11, 10 and 9 by hand, which discards the holds, the ledger and the cost column).
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
   - Keep `FREE_POOL_ENABLED=false` and `BEDROCK_ENABLED=false` unless that provider is part of the plan.
5. **Switch one provider on in staging** first ([staging-runbook.md](staging-runbook.md)) with an
   explicitly approved, tiny and bounded smoke test; watch the ledger, `/metrics` (alert on
   `dash_ai_ledger_write_failures_total`) and the operator view, then repeat in production with one
   provider and a rollback path to the previous provider mode.
6. **Emergency stops:** `AI_ENABLED=false` stops all AI; `PAID_PROVIDERS_ENABLED=false` stops paid
   inference; a lower spend limit stops paid inference once spend reaches it. Each needs only an
   environment change and a restart, and applies from the first request after it.

## Ledger retention

**Policy: inference ledger rows (`inference_attempts`) are kept for 24 months**, counted from
`created_at`. The rows are accounting and operational metadata (tokens, costs, latency, outcome,
routing), never prompts, documents or answers, and 24 months gives cost and audit history across the
current and previous financial year without keeping them indefinitely. Rows of deleted accounts are
already unlinked from the person (`user_id` set to NULL) and follow the same period.

**Enforcement is not built yet** (next milestone). Until then no row is deleted. The purge will:
delete only rows with `created_at` older than 24 months, in small batches; be run deliberately by an
operator (a CLI, like migrations), never automatically on start-up; report what it would delete with a
dry run first; and be tested on PostgreSQL. Deleting rows that old only lowers spend sums for days and
months that closed long ago, so no current spend limit is affected.

## Known limits

- Quota counters and health are per instance (seeded from the ledger at start-up).
- Plans: every account is on `AI_DEFAULT_PLAN`; assigning plans per account is future work.
- The operator view and router hint still sum the ledger (cached); admission reads per-day totals.
- Retention: the policy is **24 months** (see *Ledger retention*); the purge that enforces it is not
  built yet, so until then rows are kept.
- Admissions under a system-wide limit are serialized on that limit's lock (one short statement each,
  reading per-day totals; measured locally at roughly 60–250 admissions per second). A much higher
  paid request rate would need sharded or batched admission.
- A provider retry after a possibly billed failure, or a fallback after one, can spend past a request's
  hold (reported as an overage; retry/fallback accounting is the next milestone).
- The worst case is in DASH's estimated tokens (about three characters per token). A provider that
  counts more tokens for the same text can bill more input than was reserved.
- Sensitivity is classified from structure (documents, tools) and the operator default, not from
  content; content classification is future work.
