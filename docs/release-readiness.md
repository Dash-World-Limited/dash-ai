# Release readiness

Status of every release gate after the final pre-staging hardening (branch `claude/epic-fermi-fmpda0`).
Nothing is deployed and nothing paid has been provisioned. "Verified" means it ran and passed in the
authoring environment; "not verified" means it has not run anywhere yet, and why.

## Gates

| Gate | Status | Evidence / what is missing |
| --- | --- | --- |
| Secret scanning (tracked files + gitleaks history and tree) | ✅ verified locally | `node scripts/scan-secrets.mjs`, gitleaks 8.21 (`--redact`): no findings |
| TypeScript lint + typecheck + build | ✅ verified locally | `pnpm lint`, `pnpm typecheck`, `pnpm build` |
| Contracts tests | ✅ 37 / 37 | `pnpm test` |
| API tests, in-memory store | ✅ 378 passed, 11 skipped | the 11 are PostgreSQL-only tests, which run in the next row |
| API tests, PostgreSQL 16 + Redis 7 | ✅ 410 / 410, 0 skipped | `REQUIRE_DB_TESTS=1 REQUIRE_REDIS_TESTS=1 pnpm --filter @dash-ai/api test:pg` (store contract runs on both stores here) |
| Shared rate limiting | ✅ verified against a real Redis | two API instances share limits; 60 concurrent requests on 3 instances get exactly the capacity; outage and recovery |
| Migrations from zero, re-run, encryption maintenance | ✅ verified locally | built `migrate-cli` twice (5 applied, then up to date) and `data-cli` (0 plaintext rows) on a fresh database |
| Production start-up | ✅ verified | built server with `NODE_ENV=production`, PostgreSQL and Redis: `/ready` ready, `/metrics` 401 without the token, only the expected warnings for deliberately insecure local settings |
| Kotlin core (unit + contract + live API on PostgreSQL) | ✅ 124 / 124, 0 skipped (10 live contract tests) | `DASH_API_BASE_URL=… ../gradlew test` against the built API with `PROVIDER_MODE=fake` |
| Shared-device sign-out (core) | ✅ verified | 13 core tests + live two-account test; mutation-checked |
| Android app module compile, Robolectric/Room tests, lint, APK | ❌ **not verified** | Google Maven (`dl.google.com`) is blocked by this environment's network policy. Only `AppServices`, `ChatViewModel`, `PrefsSyncStateStore` and `PrefsLocalOwnerStore` were type-checked, against the real core and stubbed Android types; the `AuthScreen`/`AccountScreen` edits are not compiled. The `-PdashServerUrl` build-script logic was checked in a plain Gradle project. **No APK was built; there is no APK checksum.** |
| Demo Mode | ✅ usable | Demo conversations and documents still work after a sign-out (core tests); app UI tests are Demo Mode and unaffected (not run here) |
| OpenAI / Anthropic adapters, mocked | ✅ verified | real SDKs against scripted wire formats, plus retries/outages (`provider-resilience.test.ts`) |
| OpenAI live smoke | ❌ **not run** | no API key available |
| Anthropic live smoke | ❌ **not run** | no API key available |
| Sync end to end | ✅ verified | both stores + Kotlin two-device, provider-switch and two-account tests through the real API |
| Plugin/tool security and exactly-once | ✅ verified | permission re-check, adversarial suite, at-most-once ledger incl. two servers racing on one database |
| Hostile and encrypted documents | ✅ verified | budgets, isolated extraction, encrypted-PDF preflight with a real RC4 fixture (19 tests) |
| Observability without sensitive data | ✅ verified | canary test over every instrumented path |
| Mutation checks | ✅ | every security-critical protection added in this milestone was reverted once; a test failed each time |
| Workflow lint | ✅ verified locally | actionlint 1.7.7 on all five workflows |
| GitHub Actions | ❌ **not running** | every job on this branch still fails within seconds without a runner (no logs, `runner_id` 0), consistent with an account-level Actions restriction (billing or spending limit) |

## What you need to provide

1. **GitHub Actions**: resolve the account-level restriction (Settings → Billing / Actions), then re-run CI.
   `android.yml` will give the first real app compile, tests, lint and debug APK (with its SHA-256 in the
   run summary).
2. **Provider credentials for the live smoke**: a protected `live-smoke` environment with secrets
   `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` and variables `OPENAI_MODEL`, `ANTHROPIC_MODEL`; then run
   *Actions → Live provider smoke*. Cost: a few dozen small requests.
3. **For staging** (prepared, not started): follow [staging-runbook.md](staging-runbook.md) — managed
   PostgreSQL with TLS and backups, Redis with TLS, a secret manager, an HTTPS reverse proxy, and the
   deliberate migrate → data:encrypt steps; template in `deploy/staging/staging.env.example`.
4. **Release signing** (not set up): a signing key in a protected environment; `release.yml` builds an
   unsigned APK only.

## Known limitations that do not block a staging test

See the residual risks in [threat-model.md](threat-model.md) and the table in [roadmap.md](roadmap.md):
no session list / sign-out-everywhere button in the app, encrypted PDFs refused (users upload an
unprotected copy), no automatic provider failover (by design, ADR 0011), no write tools or external
plugins, images and scanned PDFs not read. No application-level blocker remains for a staging test.
