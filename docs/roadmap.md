# Roadmap

## Current state (verification and release-readiness milestone)

Nothing here is deployed. Nothing paid has been provisioned. Demo Mode is unchanged. Gate-by-gate
status, evidence and what each remaining gate needs: [release-readiness.md](release-readiness.md).

### Added in this milestone
- **Provider contract fixes** found by stricter scripted servers ([provider-verification.md](provider-verification.md)):
  Claude tool-use turns are replayed with their thinking blocks; the last tool round keeps the tool set
  with tool choice "none"; prompt-cache tokens counted; opt-in OpenAI encrypted-reasoning replay;
  malformed-response, outage and stall tests through the real SDKs.
- **Tool invocation boundary** re-checks permissions when a tool runs (fail closed), with an adversarial
  suite ([plugins.md](plugins.md)).
- **Sync** end-to-end tests: provider switching inside one conversation, pulls during a stream, partial
  batch failures, concurrent devices; PostgreSQL pulls read one consistent snapshot ([sync.md](sync.md)).
- **Hostile documents** are measured and parsed in an isolated, resource-limited process (a 357 KB file
  could previously cost the server gigabytes).
- **Credentials**: OWASP scrypt cost with upgrade at sign-in; sign out everywhere (API + Kotlin core).
- **Configuration**: `.env.example` kept in sync by a test; strict encryption-key parsing; production
  warnings for deliberate opt-outs; pinned migration checksums.
- **CI**: manual, credential-gated live-smoke workflow; actionlint job; release gates and APK checksums.

### Real and verified in the authoring environment
- **Two-way conversation sync** ([sync.md](sync.md)): push (uploads of offline conversations, renames with
  title-revision conflict detection, deletions) and pull, idempotent and server-authoritative; verified on
  both stores, with Kotlin-core unit tests and live two-device tests through the real API on PostgreSQL.
- **Titles and all message content encrypted at rest**, with backfill, key rotation (`data:encrypt`) and a
  start-up key check ([persistence.md](persistence.md), [data-inventory.md](data-inventory.md)).
- **Threat-model review** with regression tests for every issue found ([threat-model.md](threat-model.md)).
- **CI split** into secret scanning, backend, PostgreSQL integration, Kotlin core (+ live API on
  PostgreSQL), a path-filtered Android app workflow and a manual-only release workflow. The workflows pass
  actionlint; they have **not** been observed running on GitHub in this session.
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
| **Live provider answers** | **Never exercised against OpenAI or Anthropic by us.** Adapters are tested against scripted wire formats only (which now enforce Claude's thinking-replay and tool-set rules). Run `DASH_LIVE_SMOKE=1 pnpm smoke:live` or the manual *Live provider smoke* workflow with real keys (see [provider-verification.md](provider-verification.md)). |
| **Live tool calling** | Same: the round trip (Claude thinking replay, tool choice "none", OpenAI encrypted reasoning when enabled) is unverified against the live services until the smoke test is run. |
| **GitHub Actions** | Every job on this branch fails before it starts (no runner is assigned, no logs), which points at an account-level Actions restriction (billing or spending limit). None of the workflows has been observed running; all pass actionlint locally. |
| External plugins (GitHub, Gmail, Calendar, web search, Dash World services) | **Do not exist.** The only external-style plugin is `mock-github` inside the tests (canned data). No connector framework, OAuth flow or per-user secret store exists. |
| Write tools | Can be declared but are refused by the executor; needs a per-call confirmation flow. |
| Android plugin/tool UI | None. The app ignores `tool.*` events; manage plugins via the API. |
| Android app module build | **Not built.** The Android SDK and Google Maven are unreachable from the authoring environment, so no APK exists and Robolectric/Room/lint have not run on this branch. The sync wiring files (`PrefsSyncStateStore`, `AppServices`, `ChatViewModel`) were type-checked with the real Kotlin compiler against the real core module and stubbed Android types only. `android.yml` compiles, tests, lints and builds the debug APK once Actions runs. No Room-level sync test exists yet. |
| Document/prompt/settings sync, background sync | Not implemented. Sync runs at sign-in, app start and when connectivity returns. |
| Production database | A local PostgreSQL 16 was used for tests. No managed database, backups, point-in-time recovery, TLS configuration or key management exists; you must provide them. |
| Encryption of document names, emails, display names | Not done (plaintext; see [data-inventory.md](data-inventory.md)). Titles, messages and document text are encrypted. |
| Dropping the legacy plaintext columns | Phase 2 migration not shipped; `data:encrypt` must first report zero plaintext rows in each deployment. |
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

## Next recommended milestone: "Staging on real infrastructure"
Everything left unverified needs things this environment does not have:
1. **Unblock GitHub Actions** (account billing/spending limit), then watch `ci.yml` and `android.yml` go
   green. `android.yml` is the first real compile of the app module on this branch and produces the first
   debug APK and its checksum. Add a Room-backed sync test there.
2. **Run the live smoke** (`live-smoke.yml` with a protected `live-smoke` environment, or locally) for both
   providers and fix what the real services reveal; enable `OPENAI_ENCRYPTED_REASONING` only if it passes.
3. **Stand up staging** (needs your decisions and infrastructure): managed PostgreSQL with backups and TLS,
   a secret manager for `DATA_ENCRYPTION_KEY` and provider keys, HTTPS reverse proxy with `TRUST_PROXY`,
   the deliberate `migrate` + `data:encrypt` deploy steps, a shared rate limiter if more than one instance
   runs, and a real phone (Samsung A55) syncing against it.
4. **Small product decisions** the threat model surfaced: a "sign out everywhere" button, and whether
   signing out should remove that account's conversations from the device.

## Later
- Plugins: a connector/secret/consent design, a first read-only real plugin (web search with citations is
  the natural one, and the "Research has no live search" text must change with it), then a per-call
  confirmation flow for write tools, and an Android screen for plugins and tool activity.
- Documents: image understanding via provider vision inputs (with explicit consent), OCR, per-document
  retention settings.
- Encryption of document names, emails and display names; dropping the legacy plaintext columns.
- Quality: emulator-based instrumented tests (API 34/35), screenshot tests, TalkBack accessibility audit on
  the Samsung A55.
- Brand: replace the temporary mark with the official Dash World asset.

## Security follow-ups
- Distributed rate limiting (Redis) and per-account quotas/cost budgets.
- Durable audit log for account deletion and exports (metadata only).
- Certificate pinning decision for the production API domain.
- Dependency update automation and SAST in CI.
- Prompt-injection review before any plugin can read untrusted external content (mail, web pages, issues).
