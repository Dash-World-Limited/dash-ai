# Dash AI

**Think. Create. Execute.**

Dash AI is Dash World's premium, multi-model AI assistant for general conversations, business
planning, professional writing, document analysis and research. This repository contains the
native Android app, the secure backend it talks to, and the contracts shared between them.

> Status: MVP foundation on branch `claude/mvp-foundation`. Not deployed. See
> [docs/roadmap.md](docs/roadmap.md) for what is live, what is simulated and what comes next.

## What's inside

| Path | What it is |
| --- | --- |
| `apps/android` | Native Android app — Kotlin, Jetpack Compose, Material 3, Room. Application ID `com.dashworldng.ai`. |
| `apps/android/core` | Pure-Kotlin core used by the app: chat state machine, routing, streaming client, Demo Mode, Markdown parser, prompt library. Builds and tests without Google's Android repositories. |
| `apps/api` | Secure TypeScript backend (Fastify). Holds the provider keys, routes prompts to OpenAI and/or Anthropic Claude, streams answers over SSE. |
| `packages/contracts` | Shared API schemas (zod), limits, the Dash Smart routing table, upload rules and JSON/SSE fixtures used by contract tests on both sides. |
| `docs` | Product, architecture, security, design, decisions and roadmap. |
| `scripts` | Secret scanning and APK checks used locally and in CI. |

## Model choices

| Choice | What happens |
| --- | --- |
| **Dash Smart** | The backend picks the most suitable *configured* provider for the mode (see `packages/contracts/src/routing.ts`) and says why. |
| **OpenAI** | Prompts go to OpenAI only. |
| **Claude** | Prompts go to Anthropic's Claude only. |
| **Compare** | The same prompt goes to both providers and both answers appear side by side. The app warns that this uses both providers and may cost more. |

Every assistant answer is labelled with the provider and model that produced it. One provider's
answers are never sent to the other provider as context.

## Quick start

Requirements: Node 22+, pnpm 10, JDK 17+.

```bash
pnpm install
pnpm test              # contracts + API tests (fake providers, no API credits)
pnpm lint && pnpm typecheck
node scripts/scan-secrets.mjs

# Kotlin core (no Android SDK needed)
cd apps/android/core && ../gradlew test
```

### Run the API

```bash
cp apps/api/.env.example apps/api/.env   # placeholders only; fill in locally, never commit
pnpm build
PROVIDER_MODE=fake node apps/api/dist/index.js     # demonstration adapters, no network
# or, with real keys and model ids in apps/api/.env and PROVIDER_MODE=live:
pnpm --filter @dash-ai/api start
```

Configuration is described in [docs/environment.md](docs/environment.md). Model identifiers are
server configuration (`OPENAI_MODEL`, `ANTHROPIC_MODEL`) and are never hard-coded.

### Build the Android app

The complete Android build needs Google's Maven repository and an Android SDK, so it runs in
GitHub Actions (`.github/workflows/ci.yml`), which uploads the debug APK as the
**`dash-ai-debug-apk`** artifact. Locally, with Android Studio or an SDK installed:

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
| API unit, adapter (official SDKs with recorded streams) and HTTP integration tests | `apps/api/test` | ✅ |
| Kotlin core unit + contract fixture tests | `apps/android/core/src/test` | ✅ |
| Live contract test: Kotlin client ↔ running API (fake providers) | `LiveApiContractTest` | ✅ |
| Compose UI tests (Robolectric) + Room tests | `apps/android/app/src/test` | ✅ |
| Android lint, TypeScript lint/typecheck | — | ✅ |
| Secret scanning (tracked files + gitleaks) and APK provider-key check | `scripts/` | ✅ |

## Documentation

- [Product](docs/product.md) — vision, users, modes, boundaries
- [Architecture](docs/architecture.md) — components, data flow, streaming protocol
- [Security & privacy](docs/security.md)
- [Design](docs/design.md) — Dash World identity, the temporary mark
- [Environment variables](docs/environment.md)
- [Decisions](docs/decisions/) — architecture decision records
- [Roadmap](docs/roadmap.md) — including every mocked or unfinished capability

## Brand asset notice

The official Dash World logo is **not** in this repository. The app uses a clean, temporary
typographic Dash AI mark (a gold "D" letterform and the "DASH AI" wordmark). It must be replaced
with the official asset before release — see [docs/design.md](docs/design.md).
