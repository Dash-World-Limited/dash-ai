# Dash AI

**Think. Create. Execute.**

Dash AI is Dash World's premium, multi-model AI assistant for general conversations, business
planning, professional writing, document analysis and research. This repository contains the
web app, the native Android app, the secure backend they talk to, and the contracts shared between them.

> Status: final production hardening before staging (PostgreSQL persistence with encrypted
> conversation content, Redis-shared rate limits, optional plugin/tool layer with at-most-once
> actions, two-way sync, account-scoped device data, provider retries without silent failover,
> isolated document parsing, metrics without user content). Not deployed. The live OpenAI/Anthropic
> APIs have **not** been exercised yet. The Android app module is built by GitHub Actions (`android.yml`); the web app is tested in Chromium by `ci.yml`.
> See [docs/release-readiness.md](docs/release-readiness.md) for every gate and
> [docs/roadmap.md](docs/roadmap.md) for what is real, what is mocked and what comes next.

## What's inside

| Path | What it is |
| --- | --- |
| `apps/web` | Web app — React, TypeScript, Vite. Same features and design as Android, same API. See [docs/web-app.md](docs/web-app.md). |
| `apps/android` | Native Android app — Kotlin, Jetpack Compose, Material 3, Room. Application ID `com.dashworldng.ai`. |
| `apps/android/core` | Pure-Kotlin core used by the app: chat state machine, routing, streaming client, Demo Mode, Markdown parser, prompt library. Builds and tests without Google's Android repositories. |
| `apps/api` | Secure TypeScript backend (Fastify). Holds the provider keys, routes prompts to OpenAI and/or Anthropic Claude, streams answers over SSE, persists to PostgreSQL, hosts the optional plugin/tool layer and conversation sync. |
| `packages/contracts` | Shared API schemas (zod), limits, the internal routing table, upload rules and JSON/SSE fixtures used by contract tests on both sides. |
| `docs` | Product, architecture, security, design, decisions and roadmap. |
| `scripts` | Secret scanning and APK checks used locally and in CI. |

## DASH AI is the product

People talk to **DASH AI**. There is no provider or model selector and no Compare: DASH AI routes each
request to the AI infrastructure it judges best for the mode, fails over internally when a provider fails
before producing anything, and labels every answer "DASH AI". Provider and model are recorded internally
for operations and never shown. See [docs/provider-neutrality.md](docs/provider-neutrality.md) and
[ADR 0012](docs/decisions/0012-dash-ai-is-the-product.md).

## Quick start

Requirements: Node 22+, pnpm 10, JDK 17+.

```bash
pnpm install
pnpm test              # contracts + API tests (fake/scripted providers, no API credits; in-memory store)
pnpm lint && pnpm typecheck
node scripts/scan-secrets.mjs

# Kotlin core (no Android SDK needed)
cd apps/android/core && ../gradlew test
```

### Run the API

By default the API uses an **in-memory store** (data is lost on restart; production refuses it). For
durable storage set `DATABASE_URL` and `DATA_ENCRYPTION_KEY` — see [docs/persistence.md](docs/persistence.md).

```bash
# PostgreSQL tests and a durable local server (any PostgreSQL 14+; never commit credentials)
export TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/dash_test
pnpm test && pnpm --filter @dash-ai/api test:pg
DATABASE_URL=postgres://postgres@127.0.0.1:5432/dash DATA_ENCRYPTION_KEY=$(openssl rand -base64 32) \
  pnpm --filter @dash-ai/api migrate
```

```bash
cp apps/api/.env.example apps/api/.env   # placeholders only; fill in locally, never commit
pnpm build
PROVIDER_MODE=fake node apps/api/dist/index.js     # demonstration adapters, no network
# or, with real keys and model ids in apps/api/.env and PROVIDER_MODE=live:
pnpm --filter @dash-ai/api start
```

### Verify the real providers (opt-in, costs money)

```bash
DASH_LIVE_SMOKE=1 pnpm smoke:live      # needs real keys/models in apps/api/.env; see docs/provider-verification.md
```

Configuration is described in [docs/environment.md](docs/environment.md). Model identifiers are
server configuration (`OPENAI_MODEL`, `ANTHROPIC_MODEL`) and are never hard-coded.

### Build the Android app

The complete Android build needs Google's Maven repository and an Android SDK, so it runs in
GitHub Actions (`.github/workflows/android.yml`, which runs when Android files change and uploads the
debug APK as the **`dash-ai-debug-apk`** artifact; release APKs only via the manual `release.yml`). Locally, with Android Studio or an SDK installed:

```bash
cd apps/android
./gradlew :app:assembleDebug        # APK: app/build/outputs/apk/debug/app-debug.apk
./gradlew :app:testDebugUnitTest    # Robolectric Compose UI tests + Room tests
```

The app starts in **Demo Mode**: everything works without a server or API credits, and all
answers are clearly labelled simulations. To use a live server, open *Settings → Server*
(emulator: `http://10.0.2.2:8787`; a phone such as the Samsung A55 on the same Wi-Fi:
`http://<your computer's LAN IP>:8787`, debug builds only) and sign in or create an account.

## Tests and CI

| Suite | Where | Runs in CI |
| --- | --- | --- |
| Contract schema + fixture tests | `packages/contracts/test` | ✅ |
| API unit, adapter (official SDKs with scripted streams), tool-calling and HTTP integration tests (in-memory store) | `apps/api/test` | ✅ |
| Store contract, migration, encryption and restart tests on a real PostgreSQL; whole API suite on PostgreSQL | `apps/api/test` (`test:pg`) | ✅ (Postgres service container) |
| Adversarial tool-invocation and hostile-document tests | `apps/api/test` | ✅ |
| Live provider smoke test | `pnpm smoke:live`, `live-smoke.yml` | Manual only (real keys from a protected environment, real cost); providers without credentials are skipped and reported as not verified |
| Workflow lint (actionlint) | `ci.yml` | ✅ |
| Android app module: compile, Robolectric/Room tests, lint, debug APK check | `android.yml` | ✅ when Android or contract files change, or on demand |
| Unsigned release APK | `release.yml` | Manual only |
| Kotlin core unit + contract fixture tests | `apps/android/core/src/test` | ✅ |
| Live contract test: Kotlin client ↔ running API (fake providers), including sync | `LiveApiContractTest` | ✅ |
| TypeScript lint/typecheck | — | ✅ |
| Secret scanning (tracked files + gitleaks) and APK provider-key check | `scripts/` | ✅ |

"Runs in CI" describes the workflow configuration. On this branch GitHub Actions jobs currently fail
before a runner starts (an account-level restriction), so the local results in
[docs/release-readiness.md](docs/release-readiness.md) are the latest evidence.

## Documentation

- [Product](docs/product.md) — vision, users, modes, boundaries
- [Architecture](docs/architecture.md) — components, data flow, streaming protocol
- [Security & privacy](docs/security.md)
- [Design](docs/design.md) — Dash World identity, the temporary mark
- [Persistence (PostgreSQL)](docs/persistence.md) — schema, migrations, encryption, key rotation
- [Plugins and tool calling](docs/plugins.md) — optional plugins, permissions, executor, provider formats
- [Conversation sync](docs/sync.md) — two-way protocol and the deterministic rules
- [Data inventory](docs/data-inventory.md) — every stored field, what is private, what is encrypted
- [Threat model](docs/threat-model.md) — security reviews, the ten-scenario release pass, residual risks
- [Provider verification](docs/provider-verification.md) — what is tested offline vs the live smoke test
- [Environment variables](docs/environment.md)
- [Decisions](docs/decisions/) — architecture decision records
- [Roadmap](docs/roadmap.md) — including every mocked or unfinished capability
- [Release readiness](docs/release-readiness.md) — every gate, its evidence, and what it still needs
- [Staging runbook](docs/staging-runbook.md) — prepared (not executed) staging deployment, secrets, rollback, smoke checklist

## Brand asset notice

The mark is the faceted diamond from the approved splash concept, kept as a working mark until the
Director approves final artwork; every variant comes from one source per platform — see
[docs/branding.md](docs/branding.md). Public launch messaging: **"COMING DECEMBER"** /
**"OFFICIALLY LAUNCHING DECEMBER 2026"**. Platforms: Android and Web.
