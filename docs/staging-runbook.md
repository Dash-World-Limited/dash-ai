# Staging deployment runbook (prepared, not executed)

Nothing here has been deployed. As of 2026-10-21 **no staging environment exists**: no staging
database, Redis, API host, load balancer, secret manager or deployment mechanism has been provisioned,
and the repository contains no deployment workflow. This is the procedure for the first staging session,
so that session does not need to redesign anything. No real hostname, account, credential or key exists
in this repository: every `<…>` below is yours to choose.

**Mutation gate.** Every step that changes infrastructure needs the owner's explicit approval first:
creating or rebuilding a staging database, applying migrations, creating or changing staging secrets,
provisioning cloud resources, DNS, and starting a deployment. The only step allowed without that is
the read-only migration-history query in §4 step 5, and only through access the owner already approved.

## 1. What is safe to commit, and what never is

| Kind | Where | Examples |
| --- | --- | --- |
| **Safe to commit** | `deploy/staging/staging.env.example`, `deploy/staging/first-bringup.env.example`, these docs | `NODE_ENV=production`, limits, timeouts, `DATABASE_SSL=require`, `RATE_LIMIT_BACKEND=redis`, `TRUST_PROXY=1`, model ids |
| **Secrets: never committed, never pasted into tickets or chats** | your platform's secret manager | `DATABASE_URL`, `DATA_ENCRYPTION_KEY` (and `DATA_ENCRYPTION_PREVIOUS_KEYS`), `REDIS_URL`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `BEDROCK_API_KEY` or, with `BEDROCK_AUTH=iam`, `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, each compatible provider's `<NAME>_API_KEY` (the variable its `apiKeyEnv` names), `METRICS_TOKEN`, `OPERATOR_TOKEN`, `FCM_SERVICE_ACCOUNT` |
| **Infrastructure prerequisites** | provisioned by you | managed PostgreSQL 14+ with TLS and backups; Redis 7 with TLS and a password; an HTTPS reverse proxy / load balancer; a secret manager; a Node 22 runtime (container or VM) |
| **Manual steps (need you)** | §10 | creating accounts and infrastructure, generating and storing keys, provider billing, DNS/TLS certificates, approving the live smoke run, signing the Android build |

Tests (`apps/api/test/unit.test.ts`) keep both templates in sync with the server's variables, check
every secret slot is empty, check the main template produces no production warnings once secrets are
supplied, and check the first bring-up overlay starts in production with no provider or Firebase
credential and registers demonstration adapters only.

## 2. Topology and infrastructure expectations

The shape the code was hardened for (ADR 0017, ADR 0018):

```
Internet
  → HTTPS reverse proxy / load balancer (TLS ends here; the only thing that can reach the API port)
  → 1..n stateless DASH AI API processes (node apps/api/dist/index.js)
  → PostgreSQL (all durable state, leases on the database clock)
  → Redis (shared rate limits, per-account stream slots, cross-instance Stop and account-deletion cancels)
  → providers: demonstration adapters only for the first bring-up (§4); live providers only after owner approval
```

The concrete hosting platform and proxy chain have **not been chosen**. Record them here before the
first deployment, because `TRUST_PROXY` (§3) depends on them.

- **PostgreSQL**: 14 or newer (CI and local tests use 16), reachable only from the API instances, TLS
  with a certificate the server can verify (`DATABASE_SSL=require` verifies it; `no-verify` and
  `disable` log warnings at start-up). For Amazon RDS the image adds the RDS eu-west-1 root CAs through
  `NODE_EXTRA_CA_CERTS` (docs/container.md, "Database TLS"); verification stays on. Point-in-time recovery or at least daily snapshots (§8).
  Server settings are used as the provider ships them; nothing in DASH AI needs a changed setting:
  - Pool: `DATABASE_POOL_MAX` (10) connections per instance; plan `instances × 10 + migrations + operators`
    against the server's `max_connections`.
  - Acquisition: a request that cannot get a connection within `DATABASE_POOL_ACQUIRE_TIMEOUT_MS` (5 s)
    is answered 503 busy (retryable) and counted in `dash_database_errors_total{kind="pool_timeout"}`.
  - Statements: the client sets `statement_timeout` = 30 s per connection (not configurable; a
    statement past it is answered 503 and counted as `kind="statement_timeout"`).
  - Clock: Automates run leases, push send leases and spend-reservation expiry are
    written and compared with the **database's** `statement_timestamp()`, never an instance's clock
    (sessions still expire on the API instances' clocks, so keep those NTP-synchronised too).
    The server's clock must be NTP-synchronised (every managed PostgreSQL is). The session `TimeZone`
    does not matter: leases use `timestamptz` arithmetic and spend days are computed
    `AT TIME ZONE 'UTC'` explicitly.
- **Redis**: 7.x, password-protected, `rediss://` (TLS, certificate verified) unless it is on a
  private network, no persistence required. **Required whenever more than one API instance runs**
  (`RATE_LIMIT_BACKEND=redis`): it holds the shared rate limits, the per-account stream slots and the
  cross-instance Stop / account-deletion cancels (ADR 0017). With `RATE_LIMIT_BACKEND=memory` all of
  these are per instance (production logs a warning); a multi-instance staging deployment without
  shared Redis is **not a valid environment** for distributed-correctness testing. Behaviour:
  - Connection: one command connection and one subscriber per instance; connect timeout 2 s; commands
    time out after 250 ms (rate limits) or 1 s (stream state); no offline queue; ioredis reconnects
    automatically.
  - Redis down at start-up: the instance still starts (it logs "Redis is not reachable yet …").
  - Redis down while running, **fails closed**: new chat answers are refused as busy (503 retryable,
    `dash_stream_admissions_total{outcome="unavailable"}`), so the per-account stream limit never
    multiplies by the number of instances. A running answer whose slot cannot be re-taken within the
    limit after an outage stops (`dash_stream_stops_total{source="lease_lost"}`).
  - Redis down while running, **degrades**: rate limits fall back to per-instance limits for a few
    seconds at a time (`dash_rate_limit_backend_errors_total`), so the sign-in per-account limit
    becomes at most `instances × limit`; cross-instance Stop and deletion cancels are not delivered
    until Redis returns (Stop on the instance that runs the answer still works).
  - `/ready` reports `degraded` (200) while either is down; the instance stays in rotation because
    taking it out would not help (every instance is affected alike).
- **Rolling deploys / termination**: send SIGTERM and allow `SHUTDOWN_DRAIN_MS` (20 s) plus ~5 s before
  a hard kill (a termination grace period of 30 s fits). On SIGTERM the instance answers `/ready` 503
  `draining` at once and refuses new work as busy (`dash_busy_rejections_total{reason="draining"}`);
  running answers, automation runs and push sends may finish within the window, the rest are stopped
  and the process exits by itself. The load balancer must take an instance out on `/ready` 503: use a
  health-check interval × unhealthy threshold well under 20 s (for example 5 s × 2) so readiness is
  removed before termination.
- **HTTPS reverse proxy / load balancer**: terminates TLS (HTTP → HTTPS redirect, HSTS), forwards
  `X-Forwarded-For`, must **not** buffer `text/event-stream` responses (the API also sends
  `X-Accel-Buffering: no`; check your proxy honours it or disable buffering for `/v1/chat`), idle /
  read timeout above `PROVIDER_TIMEOUT_MS` (120 s; 180 s is a safe choice), request body limit ≥ 11 MB
  (10 MB uploads). Only the proxy may reach the API port (security group / firewall), otherwise a
  client could connect directly and choose its own `X-Forwarded-For`.
- **Runtime**: the container image built by the repository's `Dockerfile` (docs/container.md:
  Node 22, non-root, read-only root filesystem, `node dist/index.js`; migrations with
  `node dist/migrate-cli.js` from the same image). Without a container: Node 22,
  `pnpm install --frozen-lockfile && pnpm build`, start with `node apps/api/dist/index.js`. Memory per instance at the default settings: document parsing runs in
  child processes of the same Node binary, each stopped above 640 MB resident, at most
  `DOCUMENT_EXTRACTION_CONCURRENCY` (2) at once, plus at most (2 + `DOCUMENT_EXTRACTION_QUEUE` 6) × 10 MB
  of upload bodies in memory, plus the server itself. Start with a **2 GB** memory limit per instance
  and watch `dash_process_resident_memory_bytes`; lowering the concurrency lowers the need.
- **Logs**: JSON (pino) on stdout; collect them with the platform's log service. Logs never contain
  prompts, answers, document text, tool payloads, emails, tokens, keys or client IPs (request logs
  carry method, URL and request id); secrets are redacted by name. Keep `LOG_LEVEL=info`.
- **Provider secrets**: API keys only in the secret manager, injected as environment variables into
  the API process. They never go to the Android app, CI logs or the database. Not needed at all for
  the first bring-up (§4). When live providers are approved: separate keys for staging and production,
  never a production key copied into staging, spending limits set at the provider.

## 3. Client IP and `TRUST_PROXY`

Per-IP rate limits (sign-in, uploads, the general API limit) use the client IP that Fastify derives
from `X-Forwarded-For` according to `TRUST_PROXY`. A production server refuses `TRUST_PROXY=true` and
any `/0` range. Choose the value from the **real** chain, counting only proxies you control that
append to `X-Forwarded-For`:

| Real chain | `TRUST_PROXY` |
| --- | --- |
| client → load balancer → API | `1` (the template value) |
| client → CDN/WAF (e.g. Cloudflare) → load balancer → API | `2`, and the load balancer must accept traffic only from the CDN's published ranges |
| proxies with stable private addresses | their addresses/subnets, e.g. `10.0.1.0/24` (narrowest that covers them) |

Too low a count makes every client share the proxy's IP (one person's sign-ins throttle everyone);
too high lets a client choose its IP with a forged header. The value is unproven until the staging
test below runs: **STAGING-EXECUTION REQUIRED**.

Staging test (from two machines with different public IPs, A and B; staging `RATE_LIMIT_AUTH_PER_MINUTE`
is 10):
1. From A: 11 sign-in attempts with a wrong password within a minute, each with a different forged
   `X-Forwarded-For: 203.0.113.<n>` header → the 11th answers 429 with `Retry-After` (forgery did not
   create new budgets).
2. Immediately from B: one sign-in → not 429 (A's budget is not B's: the real client IP is resolved,
   not the proxy's).
3. Repeat step 1 through two instances (if more than one runs) → still 429 at the 11th (shared in Redis).
4. A correct sign-in after the window → 200; the account limit (`RATE_LIMIT_LOGIN_PER_ACCOUNT`) still applies.
5. `/health` and `/ready` from the load balancer → 200 (probes are not rate limited).
6. A direct connection to the API port from the internet → refused (firewall), so step 1 cannot be bypassed.

## 4. First deployment, in order

Preconditions: owner approval for the provisioning and deployment steps; CI green on the **exact
commit** being deployed (record its full SHA; deploy that SHA, never a branch name).

1. **Provision** PostgreSQL, Redis, the proxy and the secret manager (§2). Record the topology and the
   chosen `TRUST_PROXY` (§3).
2. **Generate the encryption key** on a trusted machine and store it directly in the secret manager:
   `openssl rand -base64 32` → `DATA_ENCRYPTION_KEY`, with `DATA_ENCRYPTION_KEY_ID=k1`. Store a second
   copy in an offline/escrow location: **losing it makes every stored conversation and document
   unreadable**. Never reuse the development key. The server never generates a key: without one it
   refuses to start, and with a key that does not match data already stored under the same key id it
   refuses to start (naming the key id only), so a restart can never silently make data unreadable.
3. **Generate** `METRICS_TOKEN` (`openssl rand -hex 24`) and store it with the scraper's config, and a
   separate `OPERATOR_TOKEN` (`openssl rand -hex 32`) kept for operators only. Never reuse one for the other.
4. **Configure** the environment: the values from `deploy/staging/staging.env.example`, then the
   **first bring-up overlay** `deploy/staging/first-bringup.env.example` on top (demonstration
   adapters only, paid, free-pool and Bedrock providers off, no push), then the secrets from the secret
   manager: `DATABASE_URL`, `DATA_ENCRYPTION_KEY`, `REDIS_URL`, `METRICS_TOKEN`, `OPERATOR_TOKEN`. No
   provider key and no `FCM_SERVICE_ACCOUNT` are needed or wanted. Expect exactly two start-up warnings,
   both beginning `PROVIDER_MODE=fake` (demonstration answers only). Live providers come later (§7).
5. **Migration history check (read-only, mandatory before any migration).** Against the staging
   database, run only:

   ```sql
   SELECT id, name
   FROM schema_migrations
   WHERE id >= 10
   ORDER BY id;
   ```

   Classify the result as A, B, C or D using
   [provider-platform.md](provider-platform.md#safe-production-rollout) (step 0) and the migration list
   in `apps/api/src/store/migrations.ts`. **C or D: stop** (no migration, no deployment, no repair;
   write a recovery plan for the owner). A brand-new database is B. Do not delete, rename or insert
   `schema_migrations` rows, edit migration files, or rebuild an existing database.
6. **Snapshot, then migrate** (A or B only, with owner approval). Take a database snapshot, then run
   `node apps/api/dist/migrate-cli.js` with the staging `DATABASE_URL` (the server never migrates in
   production: `DATABASE_AUTO_MIGRATE=false`, and it refuses to start on an unmigrated schema). Each
   migration runs in its own transaction under an advisory lock, so concurrent runs are safe and a
   second run reports "up to date". **If a migration fails**: that migration is rolled back, earlier
   ones stay committed, the command exits non-zero naming the migration, and the server will not start
   (it reports the missing migration). Do not edit the migration or mark it applied: keep the old
   build serving, record the error, and decide with the owner between fixing forward and restoring
   the snapshot.
7. **Encryption maintenance** (only needed if data from an older version exists):
   `node apps/api/dist/data-cli.js` until it reports `0 plaintext ... 0 rows under retired keys`.
8. **Start** one instance; check the start-up log shows `"backend":"redis"` for rate limiting and no
   warning except the two expected `PROVIDER_MODE=fake` ones, then `curl https://<staging-api-host>/ready` →
   `{"status":"ready",...}`. Only then let the load balancer send it traffic. Add further instances
   one at a time, each `ready` before it receives traffic.
9. **Smoke** (§6), with demonstration answers only.

## 5. Health, readiness, metrics and what operators can tell apart

| Endpoint | Meaning | Use |
| --- | --- | --- |
| `GET /health` | the process is up (no dependencies checked) | liveness probe |
| `GET /ready` | 200 `ready`; 200 `degraded` (database up, Redis down: `checks.rateLimits`/`checks.streams` = `down`); 503 `not_ready` (database down); 503 `draining` (shutting down) | readiness probe and load-balancer health check |
| `GET /metrics` | Prometheus text; exists only when `METRICS_TOKEN` is set; needs `Authorization: Bearer <METRICS_TOKEN>` | scraper; keep it off the public internet if you can |
| `GET /v1/providers`, `GET /v1/router` | internal provider configuration and spend; exist for callers with `Authorization: Bearer <OPERATOR_TOKEN>` only (404 for everyone else, including the metrics token) | operators only |

Probes are not rate limited. Metrics never contain prompts, answers, document text, tool payloads,
emails, tokens or keys (a test proves it).

| Situation | How an operator sees it |
| --- | --- |
| Healthy | `/ready` `ready`; `dash_database_up 1`; `dash_rate_limit_backend_up 1` |
| Redis degraded / unavailable | `/ready` `degraded`; `dash_rate_limit_backend_up 0`; `dash_rate_limit_backend_errors_total`, `dash_stream_control_errors_total` rising; `dash_stream_admissions_total{outcome="unavailable"}`; `dash_busy_rejections_total{reason="stream_control"}` |
| PostgreSQL pool timeout | `dash_database_errors_total{kind="pool_timeout"}`; `dash_database_pool_connections{state="waiting"}` > 0; `dash_busy_rejections_total{reason="database"}` |
| Database unavailable | `/ready` 503 `not_ready`; `dash_database_up 0`; `dash_database_errors_total{kind="connection"}` |
| Stream concurrency refusal | `dash_stream_admissions_total{outcome="full"}`; clients get `too_many_streams` |
| Extraction saturation | `dash_document_extraction_rejections_total{reason="saturated"\|"account"\|"wait_timeout"}`; `dash_document_extraction_active` / `_waiting` |
| Provider timeout / failure (fake or live) | `dash_provider_failures_total{code=…}`, `dash_provider_retries_total`, `dash_provider_fallbacks_total`; `dash_router_unavailable_total` when nothing could answer |
| Graceful drain | `/ready` 503 `draining`; `dash_draining 1`; logs `shutting down: draining` then `drain finished` with the outcome; `dash_shutdown_drains_total{outcome="drained"\|"deadline"}` |
| Automates lease recovery | `dash_automation_lease_recoveries_total`; `dash_automation_runs_total{status=…}` |
| Push failure | `dash_push_deliveries_total{outcome="retry"\|"failed"\|"invalid_token"\|"no_transport"}` |
| Migration failure | `migrate-cli` exits non-zero naming the migration; the server refuses to start with "missing N migration(s)", "ran a different migration history" or "was modified after it was applied" in its log (no metric: the process is not running) |
| Saturated instance | `dash_event_loop_delay_seconds`, `dash_process_resident_memory_bytes`, `dash_active_streams` |

## 6. Staging smoke plan (no paid provider)

Run with the first bring-up overlay (demonstration adapters). Demonstration triggers are written into
the chat message: `[[fake:error]]` (retryable failure), `[[fake:flaky]]` (fails once, then answers),
`[[fake:partial]]` (breaks after some output, no retry), `[[fake:down-openai]]` (one adapter down →
fallback), `[[fake:slow]]`. Record each result with the deployed SHA.

**System**
- [ ] `/health` 200 and `/ready` 200 `ready` on every instance; start-up log: `"backend":"redis"`, only the two expected `PROVIDER_MODE=fake` warnings, no stack traces.
- [ ] `/metrics` with the token shows the series in §5; without it 401; `/v1/providers` without the operator token 404.
- [ ] Database TLS: `DATABASE_SSL=require` with no start-up warning.
- [ ] SIGTERM one instance while idle: `/ready` 503 `draining` at once, exits within a few seconds, load balancer stops routing to it.

**Auth**
- [ ] Register; sign in; wrong password → 401 with a neutral message; 11 wrong attempts → 429 with `Retry-After`.
- [ ] Restart every API instance: an existing session still works (sessions are stored in PostgreSQL).
- [ ] Sign out → that token answers 401; "Sign out everywhere" → every other device's token answers 401.

**Chat**
- [ ] A message streams token by token through the proxy (not delivered all at once: proves no buffering) and is labelled as a demonstration; no provider name, logo or model appears anywhere; "which AI are you?" names DASH AI only.
- [ ] Stop during an answer; regenerate; edit a message and resend.
- [ ] `[[fake:flaky]]` answers after one retry; `[[fake:down-openai]]` answers through fallback; `[[fake:error]]` ends with DASH AI's neutral error (no provider-specific text); `[[fake:partial]]` ends as failed after partial output, with no retry.
- [ ] `inference_attempts` rows for these answers have pricing `demo` and cost 0 (operator query; no prompt or answer text in any column).

**Multi-instance** (at least two instances behind the load balancer, shared Redis)
- [ ] Three answers for one account on instance A, a fourth on B → refused (`too_many_streams`).
- [ ] Stop pressed on an answer whose cancel lands on the other instance → the answer stops.
- [ ] Delete an account while one of its answers streams on another instance → the stream stops; the account's data is gone.
- [ ] Stop Redis briefly: ordinary requests keep working, a new chat answer is refused with "DASH AI is busy right now", `/ready` says `degraded`, then everything recovers on its own.
- [ ] Rolling restart during an answer: the answer finishes (or, past the drain window, ends as stopped) and the instance exits by itself.

**Documents**
- [ ] TXT, image, PDF and DOCX upload and are used in an answer; a malformed PDF and a password-protected PDF are stored as unsupported with the right message; an 11 MB file is refused (413) by the API, not by the proxy with an HTML page.
- [ ] Start more uploads at once than concurrency + queue allows → the extra ones answer 503 busy quickly.
- [ ] Disconnect during an upload → nothing is saved and the document count is unchanged.
- [ ] Document ceiling: with `DOCUMENTS_MAX_PER_ACCOUNT` temporarily low (e.g. 3) on a test deployment, the next upload answers 409; restore it afterwards.

**Automates**
- [ ] Create an automation due in a minute; it runs once and its result appears (push transport is `none`; the in-app notice still appears).
- [ ] With two instances running the scheduler: no duplicate run for one due time.
- [ ] Kill (SIGKILL) the instance during a run: the run is marked interrupted after its lease expires (`dash_automation_lease_recoveries_total` +1) and the next schedule still runs.

**Data**
- [ ] `/v1/usage` answers quickly; `/v1/me/export` streams a complete document for an account with data.
- [ ] Account deletion removes conversations, documents, sessions and automations; ledger rows keep no link to the person.
- [ ] Restart every instance: existing conversations and documents still decrypt.

**Security**
- [ ] The `TRUST_PROXY` test in §3.
- [ ] No provider identity in responses, errors or exports; `PROVIDER_DETAILS=hidden` in effect (`exposed` is refused in production).
- [ ] Search collected logs for the test accounts' emails, message text, `DATABASE_URL`, key and token values → none.
- [ ] Web origin: the Web app and the API are served from one HTTPS origin ([web-app.md](web-app.md#deploying-prepared-not-done)); the API sends no CORS headers, so a page on an unrelated origin cannot read API responses.
- [ ] Rate limits answer 429 with `Retry-After`, shared across instances.

**Android / Kotlin** (once the API passes the above)
- [ ] Kotlin live contract tests with `DASH_API_BASE_URL=https://<staging-api-host>` (they create throwaway accounts).
- [ ] Sign out on a phone: its conversations disappear; sign in with the second account: none of the first account's data appears; sign back in: it re-syncs.

## 7. Later: live providers (owner approval required)

Not part of the first bring-up. When approved: remove the overlay values, put staging-only provider
keys in the secret manager, set `MAX_DAILY_AI_SPEND`, `MAX_MONTHLY_AI_SPEND` and a `MODEL_PRICES`
price for every paid model (production-mode start-up refuses without them), leave `FREE_POOL_ENABLED`,
`BEDROCK_ENABLED` and `COMPATIBLE_PROVIDERS` at their template values unless that provider is what you
are testing ([provider-platform.md](provider-platform.md)), then run the live smoke from a trusted
machine or the manual **Live provider smoke** workflow: `DASH_LIVE_SMOKE=1 PROVIDER_MODE=live pnpm smoke:live`.
Cost checks: `inference_attempts` has one row per provider attempt with provider-reported tokens and a
cost; `GET /v1/router` with the operator token shows today's spend against the limits; a temporarily
tiny `MAX_USER_DAILY_AI_SPEND` makes the next request answer "You've reached today's DASH AI usage
limit" (restore it afterwards). Push: `PUSH_TRANSPORT=fcm` with `FCM_SERVICE_ACCOUNT` only after its
own approval ([push-notifications.md](push-notifications.md)).

## 8. Encryption key rotation

1. Generate a new key; set it as `DATA_ENCRYPTION_KEY` with a **new** `DATA_ENCRYPTION_KEY_ID` (e.g. `k2`);
   move the old one to `DATA_ENCRYPTION_PREVIOUS_KEYS=k1:<old base64>`. Deploy.
2. Run `node apps/api/dist/data-cli.js`; repeat until it reports 0 rows under retired keys.
3. Remove the old key from `DATA_ENCRYPTION_PREVIOUS_KEYS` (keep the escrow copy until backups older
   than the rotation have expired: restoring such a backup needs it).

Start-up refuses a key that does not match data stored under the same key id, and refuses malformed
or patterned keys, naming key ids only. A leaked provider key: revoke it at the provider, put the new
one in the secret manager, restart the instances. A leaked `DATA_ENCRYPTION_KEY`: rotate as above
immediately, then treat database backups made before the rotation as exposed.

## 9. Backup, restore and rollback

**Backups**: enable PostgreSQL point-in-time recovery (or daily snapshots at minimum) and test a
restore into a scratch database before relying on it. The encryption key is **not** in the backup:
a restore needs the key (or keys) that were current when the backup was taken. Redis needs no backup.

**Restore drill**: restore into a new database → set `DATABASE_URL` to it on a single instance with
the matching keys → `migrate-cli` (should say up to date) → `data-cli` → `/ready` → spot-check that
conversations decrypt.

**Rollback** (secrets stay untouched in every case: a rollback changes the build, never the
encryption key, tokens or `DATABASE_URL`):
- *New instances fail `/ready` or log errors*: do not send them traffic; stop them; the previous
  build keeps serving. Record the log lines (they name variables, never values).
- *Configuration change*: revert the variable and restart.
- *Application release without a new migration*: redeploy the previous build (its recorded SHA).
- *Release that added a migration*: an older server refuses to start against a schema with a
  migration it does not know (by design: it cannot know what the newer schema means). Never roll a
  migration back by hand without the owner. Roll forward with a fix, or restore the snapshot taken
  before the migration (losing writes made since). Take a snapshot immediately before every migrating
  deployment for this reason. Migrations are append-only and additive so far (1–13; for example 9 adds
  a nullable column to `usage_records`, 10 adds `inference_attempts`, 11 adds a column and CHECK
  constraints to it, 12 adds `spend_reservations` and `inference_spend_daily` with a trigger and a
  backfill, 13 adds `spend_reservation_attempts`).

## 10. Android staging build

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

## 11. Steps that need you

1. Choose a hosting platform and create PostgreSQL, Redis, the proxy/TLS certificate and the secret
   manager (§2); give the API instances network access to the database and Redis only. Record the
   proxy chain and `TRUST_PROXY` (§3).
2. Generate and store `DATA_ENCRYPTION_KEY` (with an escrow copy), `METRICS_TOKEN` and a separate `OPERATOR_TOKEN`.
3. Approve the read-only migration-history query (§4 step 5), then the snapshot and migration step.
4. Approve the first bring-up and run §4 and §6; record the results with the deployed SHA.
5. Later, separately: staging provider keys with spending limits and the live smoke (§7); FCM; Android
   release signing in a protected environment.
