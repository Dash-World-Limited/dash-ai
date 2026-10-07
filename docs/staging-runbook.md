# Staging deployment runbook (prepared, not executed)

Nothing here has been deployed. This is the procedure for a later staging session, so that session
does not need to redesign anything. No real hostname, account, credential or key exists in this
repository: every `<…>` below is yours to choose.

## 1. What is safe to commit, and what never is

| Kind | Where | Examples |
| --- | --- | --- |
| **Safe to commit** | `deploy/staging/staging.env.example`, these docs | `NODE_ENV=production`, limits, timeouts, `DATABASE_SSL=require`, `RATE_LIMIT_BACKEND=redis`, `TRUST_PROXY=true`, model ids |
| **Secrets: never committed, never pasted into tickets or chats** | your platform's secret manager | `DATABASE_URL`, `DATA_ENCRYPTION_KEY` (and `DATA_ENCRYPTION_PREVIOUS_KEYS`), `REDIS_URL`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `METRICS_TOKEN`, `OPERATOR_TOKEN` |
| **Infrastructure prerequisites** | provisioned by you | managed PostgreSQL 14+ with TLS and backups; Redis 7 with TLS and a password; an HTTPS reverse proxy / load balancer; a secret manager; a Node 22 runtime (container or VM) |
| **Manual steps (need you)** | §8 | creating accounts and infrastructure, generating and storing keys, provider billing, DNS/TLS certificates, approving the live smoke run, signing the Android build |

A test (`apps/api/test/unit.test.ts`) keeps the template in sync with the server's variables, checks
every secret slot is empty, and checks the template produces no production warnings once secrets
are supplied.

## 2. Infrastructure expectations

- **PostgreSQL**: 14 or newer, reachable only from the API instances, TLS with a certificate the
  server can verify (`DATABASE_SSL=require` verifies it; `no-verify` and `disable` log warnings at
  start-up). Point-in-time recovery or at least daily snapshots (§7).
- **Redis**: 7.x, password-protected, `rediss://` (TLS) unless it is on a private network, no
  persistence required (rate-limit buckets are short-lived). Required whenever more than one API
  instance runs (`RATE_LIMIT_BACKEND=redis`). If Redis is unreachable, each instance falls back to
  its own limits for a few seconds at a time and `/ready` reports `degraded`; requests keep working.
- **HTTPS reverse proxy / load balancer**: terminates TLS, forwards `X-Forwarded-For` (hence
  `TRUST_PROXY=true`), must **not** buffer `text/event-stream` responses (chat streams), idle timeout
  above `PROVIDER_TIMEOUT_MS` (120 s), request body limit ≥ 11 MB (10 MB uploads). Only the proxy may
  reach the API port.
- **Runtime**: Node 22, `pnpm install --frozen-lockfile && pnpm build`, start with
  `node apps/api/dist/index.js`. Document parsing starts short-lived child processes of the same Node
  binary; allow at least ~700 MB of memory per instance beyond the server's own needs.
- **Provider secrets**: API keys only in the secret manager, injected as environment variables into
  the API process. They never go to the Android app, CI logs or the database. Use separate keys for
  staging and production, with spending limits set at the provider.

## 3. Health, readiness and metrics

| Endpoint | Meaning | Use |
| --- | --- | --- |
| `GET /health` | the process is up (no dependencies checked) | liveness probe |
| `GET /ready` | 200 `ready` / 200 `degraded` (database up, shared rate-limit backend down) / 503 `not_ready` (database down) | readiness probe and load-balancer health check |
| `GET /metrics` | Prometheus text; exists only when `METRICS_TOKEN` is set; needs `Authorization: Bearer <METRICS_TOKEN>` | scraper; keep it off the public internet if you can |
| `GET /v1/providers` | internal provider configuration; exists for callers with `Authorization: Bearer <OPERATOR_TOKEN>` only (404 for everyone else, including the metrics token) | operators only |

Probes are not rate limited. Metrics never contain prompts, answers, document text, tool payloads,
emails, tokens or keys (a test proves it). Key series: `dash_ai_request_seconds`,
`dash_provider_failures_total`, `dash_provider_retries_total`, `dash_tool_invocations_total`,
`dash_sync_failures_total`, `dash_rate_limit_rejections_total`, `dash_rate_limit_backend_errors_total`,
`dash_document_rejections_total`, `dash_database_up`.

## 4. First deployment, in order

1. **Provision** PostgreSQL, Redis, the proxy and the secret manager (§2).
2. **Generate the encryption key** on a trusted machine and store it directly in the secret manager:
   `openssl rand -base64 32` → `DATA_ENCRYPTION_KEY`, with `DATA_ENCRYPTION_KEY_ID=k1`. Store a second
   copy in an offline/escrow location: **losing it makes every stored conversation and document
   unreadable**. Never reuse the development key.
3. **Generate** `METRICS_TOKEN` (`openssl rand -hex 24`) and store it with the scraper's config, and a
   separate `OPERATOR_TOKEN` (`openssl rand -hex 32`) kept for operators only. Never reuse one for the other.
4. **Configure** the environment: the safe values from `deploy/staging/staging.env.example`, the
   secrets from the secret manager, and the model ids you want (`OPENAI_MODEL`, `ANTHROPIC_MODEL`).
5. **Migrate** (deliberate step; the server refuses to start on an unmigrated schema):
   `node apps/api/dist/migrate-cli.js` with the staging `DATABASE_URL`. It is safe to run twice
   (the second run reports "up to date") and takes an advisory lock, so concurrent runs are safe.
6. **Encryption maintenance** (only needed if data from an older version exists):
   `node apps/api/dist/data-cli.js` until it reports `0 plaintext ... 0 rows under retired keys`.
7. **Start** one instance; check the start-up log has no warnings you did not expect, then
   `curl https://<staging-api-host>/ready` → `{"status":"ready",...}`. Add further instances.
8. **Smoke** (§6).

## 5. Encryption key rotation

1. Generate a new key; set it as `DATA_ENCRYPTION_KEY` with a **new** `DATA_ENCRYPTION_KEY_ID` (e.g. `k2`);
   move the old one to `DATA_ENCRYPTION_PREVIOUS_KEYS=k1:<old base64>`. Deploy.
2. Run `node apps/api/dist/data-cli.js`; repeat until it reports 0 rows under retired keys.
3. Remove the old key from `DATA_ENCRYPTION_PREVIOUS_KEYS` (keep the escrow copy until backups older
   than the rotation have expired: restoring such a backup needs it).

Start-up refuses a key that does not match data stored under the same key id, and refuses malformed
or patterned keys, naming key ids only. A leaked provider key: revoke it at the provider, put the new
one in the secret manager, restart the instances. A leaked `DATA_ENCRYPTION_KEY`: rotate as above
immediately, then treat database backups made before the rotation as exposed.

## 6. Smoke-test checklist (staging)

- [ ] `/health` 200, `/ready` 200 `ready` on every instance; the start-up log line `rate limiting` shows `"backend":"redis"`, and no start-up warnings appear.
- [ ] Live provider smoke from a trusted machine or the manual **Live provider smoke** workflow, with
      the staging keys: `DASH_LIVE_SMOKE=1 PROVIDER_MODE=live pnpm smoke:live` — both providers, tools
      included. Record the output (it contains no secrets).
- [ ] Register two test accounts; chat in each mode and confirm no provider name appears anywhere (answers say "DASH AI"); ask "which AI are you?" and check the answer names DASH AI only; stop a response;
      upload a TXT, DOCX and PDF; a password-protected PDF is refused with the "encrypted" message.
- [ ] Sync between two devices (or the Kotlin live contract tests with
      `DASH_API_BASE_URL=https://<staging-api-host>`; they create throwaway accounts).
- [ ] Sign out on a phone: its conversations disappear; sign in with the second account: none of the
      first account's data appears; sign back in: it re-syncs. "Sign out everywhere" (API) revokes
      the other device.
- [ ] Rate limits: 25 rapid sign-ins for one account from two instances → 429 after the configured
      count, with `Retry-After`.
- [ ] Stop Redis briefly: requests keep working, `/ready` says `degraded`, then recovers.
- [ ] `/metrics` with the token shows the series above; without it, 401.
- [ ] Database TLS: `DATABASE_SSL=require` with no start-up warning.

## 7. Backup, restore and rollback

**Backups**: enable PostgreSQL point-in-time recovery (or daily snapshots at minimum) and test a
restore into a scratch database before relying on it. The encryption key is **not** in the backup:
a restore needs the key (or keys) that were current when the backup was taken. Redis needs no backup.

**Restore drill**: restore into a new database → set `DATABASE_URL` to it on a single instance with
the matching keys → `migrate-cli` (should say up to date) → `data-cli` → `/ready` → spot-check that
conversations decrypt.

**Rollback**:
- *Configuration change*: revert the variable and restart.
- *Application release without a new migration*: redeploy the previous build.
- *Release that added a migration*: an older server refuses to start against a schema with a
  migration it does not know (by design: it cannot know what the newer schema means). Roll forward
  with a fix, or restore the pre-deployment backup (losing writes made since). Take a snapshot
  immediately before every migrating deployment for this reason. Migrations are append-only and
  additive so far (migration 5 adds one table).

## 8. Android staging build

The app has no built-in server address in release builds. For a staging build, pass the HTTPS address
at build time (it is validated: `https://`, ending in `/`; never committed):

```bash
cd apps/android
./gradlew :app:assembleRelease -PdashServerUrl=https://<staging-api-host>/
```

or run the manual **Release build** workflow with `server_url`. Without it, testers enter the address in
*Settings → Server*. Release builds refuse cleartext HTTP. The APK is unsigned until a signing key is
set up in a protected environment (manual step), and the APK check fails if a provider key or
endpoint is ever bundled.

## 9. Steps that need you

1. Choose a hosting platform and create PostgreSQL, Redis, the proxy/TLS certificate and the secret
   manager (§2); give the API instances network access to the database and Redis only.
2. Create staging provider API keys with spending limits; choose model ids.
3. Generate and store `DATA_ENCRYPTION_KEY` (with an escrow copy), `METRICS_TOKEN` and a separate `OPERATOR_TOKEN`.
4. Resolve the GitHub Actions account restriction so CI and the Android build run, then create the
   protected `live-smoke` environment with the staging keys and approve a run.
5. Set up Android release signing in a protected environment.
6. Run §4–§6 and record the results.
