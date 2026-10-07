# Roadmap

## Current state (Intelligence Router and DASH Automates foundation)

### Added in this milestone
- **DASH Intelligence Router** ([intelligence-router.md](intelligence-router.md)): one configurable
  policy for every task (chat today, automations, and Documents, Research, Reports, Editing, Tools,
  Graphics, Voice and workflows later) weighing quality, reliability, latency, cost, context limits
  and capabilities, with live health and a circuit breaker. Chat now routes through it.
- **DASH Automates, first version** ([automates.md](automates.md)): schedule → generate → notify →
  review/share on API, Web and Android. Server-side scheduler on the existing PostgreSQL. **No social
  auto-posting.**
- Not yet: push notifications (FCM / Web Push), tools or web access inside automations.

## Earlier: final production hardening before staging

Nothing here is deployed. Nothing paid has been provisioned. Demo Mode is unchanged. Gate-by-gate
status, evidence and what each remaining gate needs: [release-readiness.md](release-readiness.md).
The staging procedure is prepared in [staging-runbook.md](staging-runbook.md) (not executed).

### Added in this milestone
- **Shared rate limiting** through Redis across API instances, with a safe fallback; per-account sign-in limit.
- **Shared-device privacy** on Android: one account's data per device; sign-out removes it, online or offline.
- **Provider resilience**: bounded retries before output, explicit recovery choices, no silent failover (ADR 0011).
- **Tool exactly-once**: repeated call ids never re-run; side-effecting tools at most once per user message.
- **Documents**: encrypted PDFs refused before parsing; two bypasses of the size check closed.
- **Observability**: `/ready`, token-protected `/metrics`, metrics free of user content.
- **Bugs fixed**: a PostgreSQL deadlock on concurrent identical sends; deleted accounts recreated by a
  still-streaming answer on the in-memory store.
- **Staging package**: `deploy/staging/staging.env.example`, runbook, HTTPS-only `-PdashServerUrl` for release builds.

### Earlier: verification and release-readiness milestone

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
- **Credentials**: OWASP scrypt cost with upgrade at sign-in; sign out everywhere (API, Kotlin core and the app's Account screen).
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
| Android plugin/tool UI | Tools & Connections lists the server's registry and switches plugins; chats show tool names and outcomes. No external plugins exist yet, and past tool activity is not shown for reopened chats. |
| Android app module build | **Not built with the Android Gradle plugin.** Google Maven is unreachable from the authoring environment, so no APK exists and Robolectric/Room/lint have not run. The UI code is compiled and its UI tests run on the JVM against Compose Multiplatform 1.7.3 (`apps/android/jvm-ui`), with Android-only APIs stubbed; `android.yml` builds the real module once Actions runs. |
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
| Rate limiting across instances | Redis-backed and tested against a real Redis; no managed Redis exists yet. |
| Official Dash World logo | Working faceted-diamond mark from the approved splash concept; final artwork needs Director approval ([branding.md](branding.md)). |
| Instrumented (on-device) UI tests | Compose UI tests run on the JVM with Robolectric; no emulator job yet. |
| Release signing, Play Store listing, deployment | Not set up (by instruction: no deployment). |

## Next recommended milestone: "Staging on real infrastructure" (procedure: [staging-runbook.md](staging-runbook.md))
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
4. **Small product decisions** the threat model surfaced: whether to add a server-side session list.

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

## After the provider-neutral milestone (not started)

These are direction only; nothing below exists in the apps, and none of it may be shown as available.

- **Public launch:** messaging is "COMING DECEMBER" / "OFFICIALLY LAUNCHING DECEMBER 2026". Platforms:
  Android and Web only.
- **DASH Signature Voice and DASH voice identities** — architecture in [voice.md](voice.md). Not
  implemented.
- **Super Admin console** — the data it needs is already recorded ([provider-neutrality.md](provider-neutrality.md#super-admin-data-that-is-preserved-not-built-yet)).
  Installs, first opens and downloads are not measured yet and must stay distinct from registered and
  active users; no device fingerprinting.
- **Google, Microsoft and Apple sign-in** — roadmap only. No buttons are shown until the backend
  supports them.
- **DASH's own models** — would be one more provider adapter behind DASH AI's routing; no client change.
