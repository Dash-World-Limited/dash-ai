# Release readiness

Status of every release gate as of the verification milestone (branch `claude/epic-fermi-fmpda0`).
Nothing is deployed and nothing paid has been provisioned. "Verified" means it ran and passed in the
authoring environment; "not verified" means it has not run anywhere yet, and why.

## Gates

| Gate | Status | Evidence / what is missing |
| --- | --- | --- |
| Secret scanning (tracked files + gitleaks history and tree) | ✅ verified locally | `node scripts/scan-secrets.mjs`, gitleaks 8.21 (`--redact`): no findings |
| TypeScript lint + typecheck | ✅ verified locally | `pnpm lint`, `pnpm typecheck` |
| Contracts tests | ✅ 37 / 37 | `pnpm test` |
| API tests, in-memory store | ✅ 315 passed, 11 skipped | the 11 are PostgreSQL-only tests, which run in the next row |
| API tests, PostgreSQL 16 | ✅ 346 / 346, 0 skipped | `REQUIRE_DB_TESTS=1 pnpm --filter @dash-ai/api test:pg` |
| Migrations from zero, re-run, encryption maintenance | ✅ verified locally | built `migrate-cli` twice (4 applied, then up to date) and `data-cli` (0 plaintext rows) on a fresh database |
| Production config refusals and warnings | ✅ verified | unit tests; manual start-up with `NODE_ENV=production` shows the warnings; patterned key refused by server and CLI |
| Kotlin core (unit + contract + live API on PostgreSQL) | ✅ 110 / 110, 0 skipped | `DASH_API_BASE_URL=… ../gradlew test` against the built API with `PROVIDER_MODE=fake` on PostgreSQL |
| Android app module compile, Robolectric/Room tests, lint, APK | ❌ **not verified** | Google Maven (`dl.google.com`) is blocked by this environment's network policy, so AGP and the Android SDK cannot be downloaded. Only the sync wiring (`AppServices`, `ChatViewModel`, `PrefsSyncStateStore`) was type-checked, against the real core and stubbed Android types. **No APK was built; there is no APK checksum.** |
| Demo Mode | ✅ unchanged | no Demo Mode code changed; sync and uploads stay gated on a signed-in, non-demo account (core tests) |
| OpenAI adapter, mocked | ✅ verified | real SDK against scripted Responses API streams (see [provider-verification.md](provider-verification.md)) |
| Anthropic adapter, mocked | ✅ verified | real SDK against scripted Messages API streams enforcing thinking-replay and tool-set rules |
| OpenAI live smoke | ❌ **not run** | no API key available. Run the manual *Live provider smoke* workflow or `DASH_LIVE_SMOKE=1 pnpm smoke:live` |
| Anthropic live smoke | ❌ **not run** | same |
| Sync end to end | ✅ verified | API sync suites on both stores + Kotlin two-device and provider-switch tests through the real API |
| Plugin/tool security | ✅ verified | invocation-time permission re-check, 54 adversarial tests, canary leak test across logs/SSE/audit/export/all DB rows |
| Hostile documents | ✅ verified | budgets + isolated extraction; 15 tests including the API staying responsive during hostile uploads |
| Workflow lint | ✅ verified locally | actionlint 1.7.7 on all five workflows |
| GitHub Actions | ❌ **not running** | every job on this branch fails before a runner is assigned (no logs, `runner_id` 0), which points at an account-level Actions restriction such as billing or a spending limit. None of the workflows has been observed running. |

## What you need to provide

1. **GitHub Actions**: resolve the account-level restriction (Settings → Billing / Actions), then re-run CI.
   `android.yml` will give the first real app compile, tests, lint and debug APK (with its SHA-256 in the
   run summary).
2. **Provider credentials for the live smoke**: a protected `live-smoke` environment with secrets
   `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` and variables `OPENAI_MODEL`, `ANTHROPIC_MODEL`; then run
   *Actions → Live provider smoke*. Cost: a few dozen small requests.
3. **For staging** (not started, by instruction): managed PostgreSQL 16 with TLS and backups, a secret
   manager for `DATA_ENCRYPTION_KEY` and provider keys, an HTTPS reverse proxy (`TRUST_PROXY=true`),
   `NODE_ENV=production`, and the deliberate `migrate` → `data:encrypt` deploy steps
   ([persistence.md](persistence.md), [environment.md](environment.md)).
4. **Release signing** (not set up): a signing key in a protected environment; `release.yml` builds an
   unsigned APK only.

## Known limitations that do not block a staging test

See the residual risks in [threat-model.md](threat-model.md) and the table in [roadmap.md](roadmap.md):
single-instance rate limiting, no session list / sign-out-everywhere button in the app, local
conversations kept on the device after sign-out, no automatic provider failover, no write tools, no
external plugins, images and scanned PDFs not read.
