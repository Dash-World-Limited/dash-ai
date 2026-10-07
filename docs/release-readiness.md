# Release readiness

Status of every release gate after the native UI/UX milestone and the web app (branch `claude/epic-fermi-fmpda0`, PR #1).
Nothing is deployed and nothing paid has been provisioned. "Verified" means it ran and passed in the
authoring environment; "not verified" means it has not run anywhere yet, and why.

## Gates

| Gate | Status | Evidence / what is missing |
| --- | --- | --- |
| Secret scanning (tracked files + gitleaks history and tree) | ✅ verified locally | `node scripts/scan-secrets.mjs`, gitleaks 8.21 (`--redact`): no findings |
| TypeScript lint + typecheck + build | ✅ verified locally | `pnpm lint`, `pnpm typecheck`, `pnpm build` |
| Contracts tests | ✅ 37 / 37 | `pnpm test` |
| API tests, in-memory store | ✅ 378 passed, 11 skipped | the 11 are PostgreSQL-only tests, which run in the next row |
| API tests, PostgreSQL 16 + Redis 7 | ✅ 410 / 410, 0 skipped | `REQUIRE_DB_TESTS=1 REQUIRE_REDIS_TESTS=1 pnpm --filter @dash-ai/api test:pg` (store contract runs on both stores here). Backend code is unchanged in the UI milestone; one run against an already-running shared Redis had 2 failures that did not reproduce in 3 further runs |
| Shared rate limiting | ✅ verified against a real Redis | two API instances share limits; 60 concurrent requests on 3 instances get exactly the capacity; outage and recovery |
| Migrations from zero, re-run, encryption maintenance | ✅ verified locally | built `migrate-cli` twice (5 applied, then up to date) and `data-cli` (0 plaintext rows) on a fresh database |
| Production start-up | ✅ verified | built server with `NODE_ENV=production`, PostgreSQL and Redis: `/ready` ready, `/metrics` 401 without the token, only the expected warnings for deliberately insecure local settings |
| Kotlin core (unit + contract + UI state logic + live API on PostgreSQL) | ✅ 148 / 148, 0 skipped (11 live contract tests, incl. Tools & Connections) | `DASH_API_BASE_URL=… ../gradlew test` against the built API with `PROVIDER_MODE=fake` |
| Shared-device sign-out (core) | ✅ verified | 13 core tests + live two-account test; mutation-checked |
| Android app UI on the JVM (`apps/android/jvm-ui`) | ✅ compiled; 20 / 20 UI tests; screens rendered | The real UI source compiled against Compose Multiplatform 1.7.3 with Android-only APIs stubbed; the app's Compose UI tests run on the desktop test runtime; mutation-checked (a hard-coded name, an end-to-end-encryption claim, not remembering the provider, and a hidden recovery card were each caught) |
| Android app module compile (AGP), Robolectric/Room tests, lint, APK | ✅ **verified in GitHub Actions** | `android.yml` job "Android app" on PR #1: `./gradlew :app:compileDebugKotlin :app:compileDebugUnitTestKotlin`, `:app:testDebugUnitTest` (22/22 Robolectric + Room), `:app:lintDebug`, `:app:assembleDebug`, APK key/endpoint check; artifact `dash-ai-debug-apk` (debug build, not signed for release). Not buildable in the authoring environment (Google Maven blocked) |
| Web app: lint, typecheck, unit tests, build | ✅ 15 / 15 | `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` (Vite production build with a strict CSP) |
| Web app end to end in Chromium | ✅ 14 / 14 locally (7 flows × phone and desktop sizes) | Playwright against the built API (`PROVIDER_MODE=fake`, PostgreSQL) and `vite preview`; CI job `web-e2e` uploads screenshots. Safari and Firefox not tested |
| Demo Mode | ✅ usable | Demo conversations and documents still work after a sign-out (core tests); app UI tests are Demo Mode and unaffected (not run here) |
| OpenAI / Anthropic adapters, mocked | ✅ verified | real SDKs against scripted wire formats, plus retries/outages (`provider-resilience.test.ts`) |
| OpenAI live smoke | ❌ **not run** | no API key available |
| Anthropic live smoke | ❌ **not run** | no API key available |
| Sync end to end | ✅ verified | both stores + Kotlin two-device, provider-switch and two-account tests through the real API |
| Plugin/tool security and exactly-once | ✅ verified | permission re-check, adversarial suite, at-most-once ledger incl. two servers racing on one database |
| Hostile and encrypted documents | ✅ verified | budgets, isolated extraction, encrypted-PDF preflight with a real RC4 fixture (19 tests) |
| Observability without sensitive data | ✅ verified | canary test over every instrumented path |
| Mutation checks | ✅ | every security-critical protection added in this milestone was reverted once; a test failed each time |
| Workflow lint | ✅ verified locally | actionlint 1.7.7 on all workflows (incl. the new `jvm-ui` job) |
| GitHub Actions | ❌ **not running** | every job on this branch still fails within seconds without a runner (no logs, `runner_id` 0), consistent with an account-level Actions restriction (billing or spending limit) |

## Android UI: what is verified, and how far

| Level | Status |
| --- | --- |
| Implemented | ✅ All screens in [android-navigation.md](android-navigation.md), on the design system in [ui-design-system.md](ui-design-system.md) |
| Compiled | ✅ against Compose Multiplatform 1.7.3 on the JVM (same Compose 1.7 / Material 3 APIs); ❌ not with the Android Gradle plugin / Android SDK |
| Behaviour tested | ✅ 20 Compose UI tests on the JVM test runtime (stubbed navigation, lifecycle and platform); ✅ UI state logic in 16 core tests; ❌ Robolectric not run |
| Visually checked | ✅ 19 screens rendered by the desktop Skia renderer and inspected (light and dark; see [screenshots](screenshots/android/README.md)); two defects found and fixed (markdown tables, brand mark size). Fonts and system bars differ from Android |
| Built for Android | ✅ the real module compiles, passes Robolectric/Room tests and lint, and produces a debug APK in GitHub Actions |
| Device-verified | ❌ Not run on any emulator or phone: insets/keyboard on real devices, TalkBack, font scaling at 200 %, Samsung One UI, file picker, share sheet, system back and predictive back are unverified |

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
no server-side session list, encrypted PDFs refused (users upload an
unprotected copy), no automatic provider failover (by design, ADR 0011), no write tools or external
plugins, images and scanned PDFs not read. No application-level blocker remains for a staging test.
