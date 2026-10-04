# Roadmap

## Current state (production-foundation milestone)

Nothing here is deployed. Nothing paid has been provisioned. Demo Mode is unchanged.

### Real and verified in the authoring environment
- **PostgreSQL persistence** ([persistence.md](persistence.md)): users, sessions, conversations,
  messages, documents, usage, plugin settings and tool audit rows; checksummed migrations with a CLI;
  document text encrypted at rest (AES-256-GCM, key rotation). Verified against a local PostgreSQL 16:
  one contract suite runs on both stores, the whole API suite runs on PostgreSQL, and a restart test
  proves accounts, sessions, conversations and encrypted documents survive a new server process.
- **Plugin/tool system** ([plugins.md](plugins.md)): normalized contract, registry, permission model,
  enable/disable per user, strict validation, timeouts, cancellation, audit metadata, bounded loops,
  adapters for both providers; the built-in `dash-demo` plugin. Tested end to end through the real
  OpenAI and Anthropic SDKs for OpenAI, Claude, Dash Smart and Compare against scripted provider
  wire formats.
- **Conversation sync** ([sync.md](sync.md)): server endpoint and the Kotlin merge engine, tested
  offline and live (the real Kotlin client against the real API on PostgreSQL).
- **Provider hardening and smoke harness** ([provider-verification.md](provider-verification.md)).
- Everything from the MVP foundation: auth, chat streaming, Dash Smart, Compare, cancellation,
  timeouts, uploads and text extraction, export/deletion, privacy-safe logging, the Android app.

### Mocked, simulated, unverified or unfinished (be explicit)
| Capability | Status |
| --- | --- |
| **Live provider answers** | **Never exercised against OpenAI or Anthropic by us.** Adapters are tested against scripted wire formats only. Run `DASH_LIVE_SMOKE=1 pnpm smoke:live` with real keys (see [provider-verification.md](provider-verification.md)). |
| **Live tool calling** | Same: the round trip (including OpenAI reasoning-model replay and Anthropic `tool_result` handling) is unverified against the live services until the smoke test is run. |
| External plugins (GitHub, Gmail, Calendar, web search, Dash World services) | **Do not exist.** The only external-style plugin is `mock-github` inside the tests (canned data). No connector framework, OAuth flow or per-user secret store exists. |
| Write tools | Can be declared but are refused by the executor; needs a per-call confirmation flow. |
| Android plugin/tool UI | None. The app ignores `tool.*` events; manage plugins via the API. |
| Android sync wiring | `PrefsSyncStateStore`, `AppServices` and `ChatViewModel` changes were written without an Android SDK and **have not been compiled or run**; the pure-Kotlin engine is tested. CI builds and tests the app module. No Room-level sync test exists yet. |
| Push of local-only conversations, document/prompt/settings sync, background sync | Not implemented. Sync is pull-only, at sign-in/app start. |
| Production database | A local PostgreSQL 16 was used for tests. No managed database, backups, point-in-time recovery, TLS configuration or key management exists; you must provide them. |
| Message-content encryption | Not done; only document text is encrypted by the app. |
| Demo Mode answers | Simulated on the device and labelled as demonstrations. |
| API fake mode (`PROVIDER_MODE=fake`) | Demonstration adapters, labelled as such, for tests and demos. |
| Web research | Not available — no search provider is connected. Research mode uses model knowledge only and says so (the Research instructions must change when a search plugin exists). |
| Image analysis, scanned-PDF OCR | Not available; images are validated but not read. |
| Demo documents | Validated on device by name/type/size only. |
| Email verification, password reset, social sign-in | Not implemented. |
| Rate limiting across instances | In-memory, single instance only. |
| Official Dash World logo | Missing — temporary typographic mark (see [design.md](design.md)). |
| Instrumented (on-device) UI tests | Compose UI tests run on the JVM with Robolectric; no emulator job yet. |
| Release signing, Play Store listing, deployment | Not set up (by instruction: no deployment). |

## Next recommended milestone: "Verify live, then ship a first real deployment"
1. **Run the live smoke test** with real keys; fix whatever the real providers reveal (OpenAI
   reasoning-item replay, model ids, token limits, tool round trip). Record the result in this file.
2. **Confirm CI is green for the Android module**, including the sync wiring and a Room-backed sync test;
   add the chat-screen "last synced / offline" affordance.
3. **Deployment foundation** (needs your decisions and infrastructure): managed PostgreSQL with
   backups and TLS, secret manager for `DATA_ENCRYPTION_KEY` and provider keys, HTTPS reverse proxy
   (`TRUST_PROXY=true`), container image, health checks, structured log shipping (metadata only),
   a deliberate `migrate` deploy step.
4. **Accounts**: email verification, password reset, session management UI.
5. **Push sync** for local-only conversations, then documents.

## Later
- Plugins: a connector/secret/consent design, a first read-only real plugin (web search with citations is
  the natural one, and the "Research has no live search" text must change with it), then a per-call
  confirmation flow for write tools, and an Android screen for plugins and tool activity.
- Documents: image understanding via provider vision inputs (with explicit consent), OCR, per-document
  retention settings.
- Field-level encryption of message content; bulk re-encryption job for key rotation.
- Quality: emulator-based instrumented tests (API 34/35), screenshot tests, TalkBack accessibility audit on
  the Samsung A55.
- Brand: replace the temporary mark with the official Dash World asset.

## Security follow-ups
- Distributed rate limiting (Redis) and per-account quotas/cost budgets.
- Durable audit log for account deletion and exports (metadata only).
- Certificate pinning decision for the production API domain.
- Dependency update automation and SAST in CI.
- Prompt-injection review before any plugin can read untrusted external content (mail, web pages, issues).
