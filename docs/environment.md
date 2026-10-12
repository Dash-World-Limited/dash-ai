# Environment variables (API)

Copy `apps/api/.env.example` to `apps/api/.env` and fill in values locally. Never commit `.env`.
Invalid values stop the server at start-up with a message that names the variable (never its value).

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `test` or `production`. |
| `HOST` / `PORT` | `0.0.0.0` / `8787` | Listen address. |
| `LOG_LEVEL` | `info` | Pino level (`silent` … `trace`). Logs never include prompts, documents or answers. `debug`/`trace` in production log a start-up warning. |
| `PROVIDER_MODE` | `live` | `live` uses real providers whose settings are complete (OpenAI/Anthropic: key and model; Bedrock: Region, at least one Nova model and credentials); `fake` uses the two demonstration adapters (no network, no cost; a start-up warning in production; Bedrock settings are ignored). In production, `live` **refuses to start** unless at least one provider is complete, none is half-configured, and no key looks like an example placeholder (the message names variables, never values). |
| `OPENAI_API_KEY` | — | OpenAI key (server only). |
| `OPENAI_MODEL` | — | OpenAI model id, e.g. a current model from OpenAI's docs. Required with the key. |
| `OPENAI_ENCRYPTED_REASONING` | `false` | Reasoning models only: request and replay encrypted reasoning items between tool rounds (`store` stays false). Enable only after the live smoke passes for your model. |
| `ANTHROPIC_API_KEY` | — | Anthropic key (server only). |
| `ANTHROPIC_MODEL` | — | Claude model id from Anthropic's docs. Required with the key. |
| `BEDROCK_AUTH` | `api_key` | How the server authenticates to Amazon Bedrock. `api_key`: `BEDROCK_API_KEY` is sent as a bearer token. `iam`: the AWS SDK default credential chain (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` of a least-privilege IAM user, a shared profile, or a role), signed with SigV4 — AWS's recommendation for production. On its own it does not switch Bedrock on. |
| `BEDROCK_API_KEY` | — | Bedrock API key (server only, secret). Only with `BEDROCK_AUTH=api_key`; set with `iam` it is refused. |
| `BEDROCK_REGION` | — | AWS Region of Bedrock Runtime, e.g. `eu-west-1`. Required once Bedrock is configured; on its own it does not switch Bedrock on. |
| `BEDROCK_MODEL_MICRO` / `BEDROCK_MODEL_LITE` / `BEDROCK_MODEL_NOVA2_LITE` | — | Model or inference-profile id for each Amazon Nova tier, e.g. `eu.amazon.nova-lite-v1:0`. At least one; each must be an id of its own tier (production refuses a mismatch). DASH picks the tier per request inside the Bedrock adapter ([intelligence-router.md](intelligence-router.md)). |
| `MODEL_PRICES` | — | Optional JSON of USD prices per million tokens for the internal cost estimate: `{"<provider>:<model id or prefix>": {"inputPerMillion": n, "outputPerMillion": n}}`. Overrides the built-in Amazon Nova estimates and compatible providers' declared prices (longest prefix wins); OpenAI/Anthropic costs stay unknown (null) unless listed. Spend limits count only priced usage, so production with live paid providers requires a price for each paid model. Invalid JSON or entries stop start-up without echoing the content. |
| `AI_ENABLED` | `true` | Global AI switch. `false` refuses every AI request, demonstrations included, with DASH AI's neutral "unavailable" message. See [provider-platform.md](provider-platform.md) for this and the following cost-control settings. |
| `FREE_POOL_ENABLED` | `false` | Free and promotional providers (compatible providers with `pricing` `free`/`promotional`) may serve requests they are eligible for. |
| `PAID_PROVIDERS_ENABLED` | `true` | Paid providers may serve requests. `false` stops all paid inference. |
| `BEDROCK_FALLBACK_ENABLED` | `false` | Amazon Bedrock may serve requests. Without it a configured Bedrock receives nothing. |
| `MAX_DAILY_AI_SPEND` / `MAX_MONTHLY_AI_SPEND` | — | System-wide paid spend limits in USD per UTC day / month (provider-reported cost, else the estimate). When reached, paid providers are excluded until the window resets. **Production with `PROVIDER_MODE=live` and a paid provider enabled refuses to start without both.** |
| `MAX_USER_DAILY_AI_SPEND` | — | Paid spend per account per UTC day (USD). |
| `AI_PLAN_DAILY_SPEND` | — | JSON `{"<plan>": usd}`: paid spend per plan per UTC day. |
| `MAX_REQUEST_AI_COST` | — | Ceiling (USD) on a paid provider's worst-case cost for one request; an unpriced paid model is not used under a ceiling. |
| `AI_DEFAULT_PLAN` | `standard` | The plan every account is on (lowercase). |
| `AI_DEFAULT_SENSITIVITY` | `sensitive` | `sensitive`: every request only goes to providers approved for sensitive content. `standard`: ordinary requests may also go to `non_sensitive_only` providers; requests with documents or tools stay sensitive. |
| `COMPATIBLE_PROVIDERS` | — | JSON array of approved OpenAI-compatible providers. Each entry names the variable holding its key (`apiKeyEnv`, ending in `_API_KEY`); that variable is a **secret** set separately. Unapproved by default. Format in [provider-platform.md](provider-platform.md). |
| `<NAME>_API_KEY` | — | **Secret.** The key of a compatible provider, under the name its `apiKeyEnv` gives. Not in `.env.example`. |
| `PROVIDER_QUOTAS` | — | JSON quota windows per provider id (requests or tokens per minute/day/month, promotional balance, unknown, unlimited) and a soft threshold. |
| `PROVIDER_TIMEOUT_MS` | `120000` | Maximum time for one provider answer. |
| `PROVIDER_IDLE_TIMEOUT_MS` | `45000` | Maximum gap between streamed chunks. |
| `PROVIDER_MAX_RETRIES` | `2` | Extra attempts after a retryable provider failure (429, 5xx, timeout, malformed stream) that happened **before any output**. 0 disables retries. See [ADR 0011](decisions/0011-provider-failures-retry-not-failover.md). |
| `PROVIDER_RETRY_BASE_MS` | `500` | First retry delay; doubles per attempt with ±20 % jitter, ×4 after rate limiting, capped at 8 s and never past `PROVIDER_TIMEOUT_MS`. |
| `MAX_OUTPUT_TOKENS` | `16000` | Output token limit per answer. Includes thinking/reasoning tokens on models that think, so leave room for both. |
| `FAKE_STREAM_DELAY_MS` | `25` | Delay between chunks of fake answers. |
| `DOCUMENT_EXTRACTION_TIMEOUT_MS` | `20000` | Time limit for parsing one PDF or DOCX. Parsing runs in a separate process with no secrets in its environment, a memory cap and decompression budgets (see [security.md](security.md)); a file that exceeds any limit is stored as `unsupported` with an explanation. |
| `RATE_LIMIT_CHAT_PER_MINUTE` | `20` | Chat requests per user per minute. |
| `RATE_LIMIT_AUTH_PER_MINUTE` | `10` | Sign-in/registration attempts per IP per minute. |
| `RATE_LIMIT_UPLOAD_PER_MINUTE` | `10` | Uploads per user per minute. |
| `RATE_LIMIT_API_PER_MINUTE` | `240` | All requests per IP per minute. |
| `RATE_LIMIT_SYNC_PER_MINUTE` | `60` | Sync pulls and pushes per user per minute. |
| `RATE_LIMIT_LOGIN_PER_ACCOUNT` | `20` | Sign-in attempts per account (email) per 15 minutes, from any number of IPs. |
| `RATE_LIMIT_BACKEND` | `memory` | `memory`: limits per API process (one instance, development). `redis`: shared by every instance through `REDIS_URL` (required with more than one instance; production warns when it is `memory`). If Redis fails, each instance uses its own limits for a few seconds at a time, then retries Redis. |
| `REDIS_URL` | — | **Secret.** `redis://` or `rediss://` (TLS; production warns about `redis://`). Required with `RATE_LIMIT_BACKEND=redis`. Keys stored in Redis are SHA-256 hashes (no IPs, ids or emails). |
| `MAX_CONCURRENT_STREAMS_PER_USER` | `3` | Simultaneous chat streams per user. |
| `SESSION_TTL_DAYS` | `30` | Session token lifetime. |
| `TRUST_PROXY` | `false` | Set `true` only behind a trusted reverse proxy. Behind a load balancer with this `false`, every client shares the balancer's IP and therefore one per-IP rate-limit bucket. |
| `DATABASE_URL` | — | PostgreSQL connection string. Empty = in-memory store (development/tests only; **production refuses to start without it**). Keep it out of git; it usually contains a password. |
| `DATABASE_SSL` | `require` in production, else `disable` | `disable`, `require` (verify certificate) or `no-verify`. `disable` or `no-verify` in production log a start-up warning. |
| `DATABASE_POOL_MAX` | `10` | Connection pool size. |
| `DATABASE_AUTO_MIGRATE` | `true` outside production, `false` in production | Apply pending migrations at start-up. When off, start-up fails if the schema is not current; run `pnpm --filter @dash-ai/api migrate`. |
| `DATA_ENCRYPTION_KEY` | — | **Required with `DATABASE_URL`.** Base64 (or base64url) of 32 random bytes (`openssl rand -base64 32`). Encrypts conversation titles, message content and document text at rest. Start-up refuses malformed or obviously patterned keys, and a key that does not match data stored under its key id. Back it up separately: losing it makes stored conversations and document text unreadable. |
| `DATA_ENCRYPTION_KEY_ID` | `k1` | Label stored with each ciphertext; change it when you rotate the key. |
| `DATA_ENCRYPTION_PREVIOUS_KEYS` | — | Retired keys still needed to read old data: `id:base64,id2:base64`. |
| `ALLOW_MEMORY_STORE` | `false` | Lets production run on the in-memory store (throw-away demos only). |
| `TOOLS_ENABLED` | `true` | Server-wide kill switch for tool calling. Plugins are still off per user until the user enables them. |
| `TOOL_TIMEOUT_MS` | `10000` | Default per-tool-call timeout (a tool may set a shorter one; 120 s ceiling). |
| `TOOL_MAX_ROUNDS` | `4` | Maximum model → tool → model rounds per answer; the last round keeps the same tools but switches tool use off (tool choice "none"). |
| `TOOL_MAX_RESULT_CHARS` | `20000` | Tool output beyond this is truncated before it reaches the model. |
| `PUSH_TRANSPORT` | `none` | Automates push notifications: `none`, `fcm` or `fake` (recorded, never sent; production warns). See [push-notifications.md](push-notifications.md). |
| `FCM_SERVICE_ACCOUNT` | — | **Secret.** Firebase service-account JSON (raw or base64). Required with `PUSH_TRANSPORT=fcm`. |
| `PUSH_TICK_MS` | `5000` | How often each instance sends due pushes. |
| `PUSH_MAX_ATTEMPTS` | `5` | Attempts per push before it is marked failed. |
| `PUSH_RETRY_BASE_MS` | `30000` | First push retry delay; doubles with ±20 % jitter, capped at an hour. |
| `PUSH_TTL_SECONDS` | `86400` | Pushes older than this are not sent. |
| `METRICS_TOKEN` | — | **Secret.** At least 24 characters. Enables `GET /metrics` (Prometheus text) for requests bearing this token; unset, the endpoint does not exist. |
| `OPERATOR_TOKEN` | — | **Secret.** At least 32 characters and a different value from `METRICS_TOKEN` (the server refuses to start if they match). Opens the operator view `GET /v1/providers` while provider details are hidden; unset, there is no operator access. |

`.env.example` lists exactly these variables except the compatible providers' own key variables (a
test keeps the two in sync and checks that every credential slot in it is empty).

## Production checklist

Production (`NODE_ENV=production`) **refuses to start** without `DATABASE_URL` (unless
`ALLOW_MEMORY_STORE=true`), without a valid `DATA_ENCRYPTION_KEY`, with a key that does not match
stored data, with a schema that is not migrated, or with `PROVIDER_MODE=live` (the default) and no
usable provider credentials: no complete provider, a key without its model (or the reverse), a key
that looks copied from an example, or Bedrock settings that are incomplete, use the wrong tier id, an
invalid Region, or both an API key and `BEDROCK_AUTH=iam`; and, with a paid provider enabled, without
`MAX_DAILY_AI_SPEND`, `MAX_MONTHLY_AI_SPEND` and a `MODEL_PRICES` price for every paid model. Its defaults are the safe ones (`DATABASE_SSL=require`,
`DATABASE_AUTO_MIGRATE=false`). It **warns** at start-up about deliberate opt-outs: `DATABASE_SSL=disable`
or `no-verify`, `LOG_LEVEL=debug`/`trace`, `PROVIDER_MODE=fake`, only one live provider
(nothing to fail over to), `RATE_LIMIT_BACKEND=memory` (limits are per instance) and an unencrypted
`redis://` `REDIS_URL`. A staging template with production-safe values is
`deploy/staging/staging.env.example`; the procedure is [staging-runbook.md](staging-runbook.md). Set `NODE_ENV=production` in every
deployment: without it the development defaults apply (no database TLS by default, migrations at
start-up, in-memory store allowed).

`PROVIDER_DETAILS` (`hidden`, the default and the production value, or `exposed`): with `hidden`, nothing
a consumer receives names an AI provider or model, and every request is routed by DASH AI
([provider-neutrality.md](provider-neutrality.md)). `exposed` is the engineering view for tests and the
live smoke run; production logs a warning if it is set.

`GET /v1/assistant` tells the apps whether DASH AI can answer (`available`, `demo`, research note).
`GET /v1/providers` (configured providers, `live`/`fake`/`unconfigured`, model ids) is operator-only: it
needs `Authorization: Bearer $OPERATOR_TOKEN` and answers 404 otherwise, including to signed-in users
and to the metrics token. The metrics token only opens `/metrics`; the operator token does not open it.

## Opt-in live smoke test

Not part of the server's configuration, only of `pnpm smoke:live` (see
[provider-verification.md](provider-verification.md)): `DASH_LIVE_SMOKE=1` plus `PROVIDER_MODE=live` and
real provider keys/models in `apps/api/.env`. Without `DASH_LIVE_SMOKE=1` it does nothing.

## Test-only variables

`TEST_DATABASE_URL` (run the PostgreSQL tests against this database, in unique throw-away schemas),
`DASH_TEST_STORE=postgres` (run the whole API suite on PostgreSQL; `pnpm --filter @dash-ai/api test:pg`),
`REQUIRE_DB_TESTS=1` (fail instead of skipping when no test database is configured; set in CI).

## Android build configuration

| Setting | Where | Notes |
| --- | --- | --- |
| Default server URL | `apps/android/app/build.gradle.kts` (`DEFAULT_SERVER_URL`) | Debug: `http://10.0.2.2:8787/` (emulator → host). Release: empty; users must set an HTTPS server. |
| Server URL at runtime | Settings → Server | For a physical phone use your computer's LAN IP (debug builds allow `http://`). |
