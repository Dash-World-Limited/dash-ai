# Product completion and pre-staging readiness audit

Baseline: `claude/mvp-foundation` at `7610a8d` (PR #14 merged). Branch: `feature/product-completion-pre-staging-ow5xbw`.
Date: 2026-10-20.

This audit answers one question: is DASH AI one coherent product across the API, Web and Android, and
what must be fixed now or proven later before real users arrive? It does **not** certify production,
scale, live-provider or final security readiness. Those need capacity, spike, soak and multi-instance
failure tests, real staging infrastructure, backup/restore exercises, controlled live-provider tests
and the final historical security audit.

Method: every route in `apps/api/src/routes`, the chat orchestrator, Automates scheduler, push
service, document isolation and stores were read; the Web app (`apps/web/src`) and the Android app
(`apps/android/core`, `apps/android/app`) were each read end to end against the API and contracts.
Every finding below cites code. Each P0/P1 fix has a regression test that fails without the fix.

Status key: COMPLETE · PARTIAL · BROKEN · API ONLY · WEB ONLY · ANDROID ONLY · DEMO/FAKE ONLY ·
NOT IMPLEMENTED · INTENTIONALLY DEFERRED. "Fixed" means fixed on this branch.

## 1. Product inventory

| Area | Capability | API | Web | Android | Status | Severity | Action | Verification |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Auth | Register, login, invalid credentials | `routes/auth.ts:24,40` | `Start.tsx` | `Auth.kt`, `AuthScreen.kt` | COMPLETE | – | – | API suite; web E2E; Kotlin live contract tests |
| Auth | Logout, logout-all | `auth.ts:66,72` | `app.tsx` signOut, Account | `LocalAccountGuard.signOut`, AccountScreen | COMPLETE | – | – | web E2E "sign out everywhere"; `AccountIsolationTest` |
| Auth | Expired/revoked session mid-use | `requireAuth.ts:18-24` | signs out with explanation | banner had no way back to sign-in; only Sign out, which discards unsynced changes | Web COMPLETE, Android was BROKEN → fixed | P1 | Android chat banner offers **Sign in**; signing in again as the same account keeps the device's chats (`LocalAccountGuard.onSignedIn`) | `ChatScreen.kt` (jvm-ui/Robolectric compile); device check listed in §10 |
| Auth | Two tabs, different accounts | – | a tab kept showing account A while sending B's shared token (or none) | n/a | was BROKEN → fixed | P1 | tab reloads when another tab changes the shared session | `state/app.test.ts`; E2E "another tab signing out" |
| Auth | Wrong password while signed in | – | 401 on login signed the current session out | n/a | was BROKEN → fixed | P2 (fixed, trivial) | login/register 401 never ends the session | `state/app.test.ts` |
| Account | Delete account | `account.ts:14` (cascade) | showed "session ended" | COMPLETE | Web fixed | P2 (fixed) | Web says the account was deleted and calls nothing more | `state/app.test.ts` |
| Account | Server export | `GET /v1/me/export` | not offered | local device export only | API ONLY | P2 | add export to Web and Android | – |
| Account | Email verification, password reset, social sign-in | none | none | none | INTENTIONALLY DEFERRED (roadmap) | P3 | – | `docs/roadmap.md` |
| Chat | Stream, stop, retry, regenerate, edit/resend, rename, delete, history | `routes/chat.ts`, `orchestrator.ts`, `conversations.ts` | `chat/engine.ts` | `ChatSession.kt` | COMPLETE | – | – | API suite; web E2E; `ChatSessionTest` |
| Chat | Empty provider result | was saved and shown as a *complete* empty reply (automations already refused it, `generate.ts:271`) | blank bubble | blank bubble | was BROKEN → fixed | P1 (fake success) | a no-text answer is a retryable `provider_error`; DASH AI's route may hand it to the next provider | `product-completion.test.ts` (3 tests); `provider-contract.test.ts` updated |
| Chat | Stop before the stream starts | client leaving during `prepareChat` was not noticed: the whole paid answer ran | – | – | was BROKEN → fixed | P1 (paid work nobody receives) | abort when the connection is already gone after the stream opens | `product-completion.test.ts` "Stop before the answer starts" |
| Chat | Long answer in history | contract caps each history turn at 32,000 chars; answers can be longer (`MAX_OUTPUT_TOKENS` 16,000) | sent verbatim → every later send in the chat got a raw 400 | truncates (`ContextBuilder.kt:44`) | Web was BROKEN → fixed | P1 | Web cuts each turn to the limit, like Android | `engine.test.ts` |
| Chat | Regenerate/retry a reopened question that had documents | messages kept `attachment_ids` but `ConversationMessage` did not return them | resent with no documents (silently) | same for chats pulled from the server | was BROKEN → fixed (API + Web); Android DTO receives it | P1 | `ConversationMessage.attachmentIds` (additive) | contracts test; `product-completion.test.ts`; `engine.test.ts`; `ContractFixturesTest` |
| Chat | Regenerate an earlier answer | truncates every later message (`orchestrator.ts` `truncateMessagesFrom`) | no warning | no warning | was BROKEN → fixed | P1 (silent data loss) | both apps ask first when later messages exist | `engine.test.ts`; E2E "regenerating an earlier answer asks first"; Android `ChatScreen.kt` |
| Chat | Provider identity hidden | `publicSurface.ts`, `PROVIDER_DETAILS=hidden` default; production refuses `exposed` | COMPLETE | COMPLETE | COMPLETE | – | – | `provider-neutrality.test.ts`; web E2E "DASH AI only" |
| Chat | Raw validation text | `errors.ts:parseOrThrow` lists zod paths | shown verbatim in banners | shown verbatim | PARTIAL | P2 | map `bad_request` to neutral wording in clients | – |
| Chat | Edit longer than 32,000 chars | 400 | no limit on the edit box; screen drifts | limited | Web PARTIAL | P2 | apply the limit to the edit dialog | – |
| Chat | Default mode for new chats | – | applied only at page load | applied | Web PARTIAL | P2 | apply in New chat / Home | – |
| Limits | User/plan/system limit, busy, too large, paid retry/fallback prevented | `orchestrator.ts:283-295`, `publicSurface.ts`, ADR 0015/0016 | message shown | message shown | COMPLETE | – | – | cost-control and spend suites; no reservation id, route, price or database detail reaches a client |
| Documents | Upload, validation, signature check, isolated extraction, encrypted at rest | `documents.ts`, `isolate.ts`, `inspect.ts` | COMPLETE | COMPLETE | COMPLETE | – | – | `documents-hostile.test.ts`, web E2E, robustness E2E |
| Documents | Delete | `documents.ts:68` | COMPLETE | reported "Document removed" when the server delete failed or in Demo Mode; text stayed on the server, invisible to the user | Android was BROKEN → fixed | **P0** (fake success, privacy) | server first, device only after success; Demo Mode cannot remove server documents | `DocumentRemovalTest` (5 tests) |
| Documents | Server document list | `GET /v1/documents` | used | never called: documents from another device or a reinstall are invisible | Android PARTIAL | P2 | refresh from the server | – |
| Documents | Images, scanned PDFs, OCR | accepted, not analysed, says so | – | – | INTENTIONALLY DEFERRED (ADR 0006) | P3 | – | `docs/product.md` |
| Documents | Picker reporting no size | – | – | rejected as "empty" (`FileRules.kt:34`) | PARTIAL | P2 | treat unknown size as unknown | device check |
| Tools | Enable/disable, scopes, permission re-check, timeout, cancellation, bounded output/rounds, audit | `plugins.ts`, `tools/*`, `orchestrator.ts` runToolCalls | COMPLETE | COMPLETE | COMPLETE | – | – | `tools.test.ts`, `tool-adversarial.test.ts`, `tool-exactly-once.test.ts` |
| Tools | Tool audit list | `GET /v1/tools/activity` | not shown | not shown | API ONLY | P3 | – | in-chat activity is shown on both |
| Tools | External plugins, write tools | none (only `dash-demo`) | – | – | INTENTIONALLY DEFERRED | P3 | – | `docs/plugins.md` |
| Research | Live web research | no search provider; Research mode states it (`instructions.ts:20`) | mode only | mode only | INTENTIONALLY DEFERRED (ADR 0006) | P3 | – | Research is normal chat with research instructions, plus document-assisted chat; no tool-assisted or dedicated research workflow exists |
| Automates | Create, edit, pause/resume, run now, schedule, time zone, history, results, regenerate, delete, notifications | `routes/automations.ts`, `automations/service.ts` | COMPLETE | COMPLETE | COMPLETE | – | – | `automations.test.ts`; web E2E Automates; `AutomatesTest` |
| Automates | Spend refusal | `generate.ts:131-133` → `limit_reached` → "A DASH AI usage limit stopped this run." | shown | shown | COMPLETE | – | – | automations suite |
| Automates | Failed run detail | API returns it | failed runs cannot be opened (only Run now) | opens | Web PARTIAL | P2 | – | – |
| Automates | Device zone like `GMT+01:00` | rejected by `TimeZoneName` | – | raw validation text | Android PARTIAL | P2 | map offset zones | device check |
| Automates | Tools/documents inside automations | none | – | – | INTENTIONALLY DEFERRED (Director) | P3 | – | – |
| Notifications | In-app notices | `/v1/notifications` | polled every 60 s | COMPLETE | COMPLETE | – | – | – |
| Notifications | Android push (FCM): registration per session, preferences, retries with backoff, invalid-token removal, send-time checks, logout and deletion cleanup (FK cascade) | `push/*`, `routes/push.ts` | n/a | `Push.kt`, `DashMessagingService.kt` | COMPLETE in code; **live FCM not configured** | – | – | `push.test.ts`, `PushTest`, `PushUiTest`; live delivery unverified |
| Notifications | Web Push | none | none | n/a | INTENTIONALLY DEFERRED | P3 | – | memory/decision |
| Settings | Theme, default mode, privacy text, usage totals | `/v1/usage` (one DASH AI total when hidden) | COMPLETE | COMPLETE | COMPLETE | – | – | no provider, model or price in normal UI |
| Settings | Server address | – | n/a (same origin) | could be changed while signed in: the session token went to the new address | Android was BROKEN → fixed | P1 (credential exposure) | sign out first | `ServerAddressTest` |
| Sync | Two-way conversation sync | `routes/sync.ts` | n/a (server is the source) | `ConversationSync.kt` | COMPLETE | – | – | `sync*.test.ts`, `ConversationSyncTest`, cross-client E2E |
| Sync | Edits on another device leave stale branches; "delete local data" keeps the cursor | – | – | `ConversationSync.kt:92`; `SettingsScreen.kt` deleteLocalData | PARTIAL | P2 | – | – |
| Voice, Super Admin, router learning, social posting | – | – | – | INTENTIONALLY DEFERRED (Director) | – | – | – |

### Web/API parity
Every Web call has a route; no client calls an obsolete endpoint. API capabilities without a Web
client: `/v1/me/export`, `/v1/tools/activity`, push and sync endpoints (Android-only by design).

### Android/API parity
Every Retrofit path matches a route. All nine SSE events decode; unknown finish reasons and tool
statuses fall back safely; DTO nullability matches the contracts. Not used on Android:
`GET /v1/documents` (P2 above), `/v1/me/export` (local export instead), `/v1/tools/activity`,
push device list/delete-by-id. The `automates/new` vs `automates/{id}` collision is resolved
(`new-automation` route).

## 2. Fake / stub / placeholder findings

No `TODO`, `FIXME`, `HACK` or "not implemented" markers exist in production code. Findings:

| Finding | Classification |
| --- | --- |
| `PROVIDER_MODE=fake` adapters, `[[fake:*]]` triggers | valid test fixture; labelled "Demonstration answer", production warns |
| Demo Mode answers and documents (Web `backends.ts`, Android `DemoResponses.kt`) | intentional demo behaviour, labelled DEMO and never sent as history |
| "placeholder" text inside demo answers | intentional demo behaviour |
| `mock-github` plugin | test fixture only |
| Android document delete reporting success after a failed server delete | **dangerous fake success → fixed** |
| Empty provider answer saved as complete | **fake success → fixed** |
| Android Tools/Automates "Sign in" sets Demo Mode without the account guard (`DashAiApp.kt:268,316`) | unfinished path, P2 (the old account's data stays visible in Demo Mode) |

## 2a. Orphaned / duplicated product paths

| Finding | Impact | Classification |
| --- | --- | --- |
| Every Android route (`DashAiApp.kt` `Routes`) and every Web screen is reachable from navigation; no button without an action was found | – | none |
| API routes with no client: `GET /v1/me/export` (both apps), `GET /v1/tools/activity` (both apps), push device list/delete-by-id (Android unregisters by token) | capability exists but no person can use it | P2 (export), P3 (others) |
| Android Tools and Automates "Sign in" (`DashAiApp.kt:271,319`) set Demo Mode and drop the account without `LocalAccountGuard.signOut`; the chat banner now uses the plain sign-in route instead | the previous account's local data stays visible in Demo Mode until the next sign-in, which wipes it if a different account signs in (`LocalAccountGuard`) | P2 |
| History truncation existed only on Android (`ContextBuilder.kt`); Web sent turns verbatim | duplicated rule that drifted | fixed (Web now applies the same limit) |
| Demo Mode answers exist twice (Web `backends.ts`, Android `DemoResponses.kt`) | intentional: each client works offline | none |
| No local/demo behaviour reachable from production: the fake providers need `PROVIDER_MODE=fake` and production warns; Demo Mode is labelled and never sends history to the server | – | none |

## 2b. Expanded checklist items verified without a code change

| Item | Evidence |
| --- | --- |
| Repeated failed login | per-account and per-IP sign-in limits, shared across instances through Redis (`routes/auth.ts:44`, `rate-limit.test.ts` "whole API instances share sign-in limits per account and per IP"); per-IP part depends on the `TRUST_PROXY` fix above |
| Renamed/mismatched file type, empty, corrupt | file signature check (`documents/inspect.ts:10`); hostile-document suite ("garbage that passes the signature check is refused cleanly") |
| Encrypted / password-protected PDF | refused before parsing, with a reason (`documents/budget.ts:132`; "a real RC4-encrypted PDF … is refused before parsing") |
| Partial response | a disconnect mid-stream keeps the partial text once, stored as failed, not retried (`provider-resilience.test.ts:179`) |
| Refusal | surfaced as `finishReason: "refusal"` (`adapters.test.ts:257`; `product-completion.test.ts`) |
| Database timeouts | pool `connectionTimeoutMillis` 10 s, `statement_timeout` 30 s (`postgresStore.ts:274-276`) |
| Push token refresh | `DashMessagingService.onNewToken` re-registers for the current session |
| Push delivery state, retries, duplicates | delivery rows claimed with `SKIP LOCKED`, up to 5 attempts with backoff, a retried send replaces an undelivered one (`push/fcm.ts:120`), invalid tokens removed (`push.test.ts`) |
| Firefox | CI runs the whole E2E suite in Firefox as well (`ci.yml` `DASH_E2E_FIREFOX=1`); locally only Chromium is installed |

## 3. Security findings (while touching flows; not the final audit)

| Finding | Severity | Status |
| --- | --- | --- |
| `TRUST_PROXY=true` believed every `X-Forwarded-For` entry: clients could choose their IP and bypass per-IP sign-up, sign-in and API limits behind a load balancer; the staging template set `true` | P1 | fixed: proxy count or addresses; staging uses `1`; production warns about `true` (`rate-limit.test.ts`) |
| Android sent its session token to any server address typed while signed in | P1 | fixed (`ServerAddressTest`) |
| Web tab acting as another account after a sign-in in another tab | P1 | fixed |
| Object ownership: conversations, messages (PK is `(conversation_id, id)`), documents, automations, runs, notifications, push devices, plugin settings are all scoped by user | – | verified by reading; covered by existing suites |
| Push token ownership: registered only for the calling session; removed with the session (FK cascade) | – | verified |
| Dependency advisories (`pnpm audit`, also flagged by GitHub): `source-map-js` < 1.2.2 (high, event-loop DoS) reaches only the Web *test* toolchain (`jsdom`), never the shipped bundle; `sprintf-js` ≤ 1.1.3 (moderate, no patched release) comes through `mammoth > argparse`, which only mammoth's command-line entry uses, and document parsing runs in the isolated, time- and memory-limited extractor | P3 | recorded; upgrade `jsdom` when a release carries `source-map-js` ≥ 1.2.2 |
| Account deletion race: all owned rows cascade; late writes fail on FK (`finishRun`, `createAutomation`, `saveMessage`) | – | verified; streams on *other* instances keep running until they end (see §5) |

## 4. Resource-bound findings

| Work | Bound | Note |
| --- | --- | --- |
| Request body | 256 KB default; chat 2 MB; sync push 16 MB | bounded |
| Upload | 10 MB, 1 file | bounded |
| Extraction | isolated process, 20 s, 640 MB RSS, 384 MB heap, 2 at once per instance | the **wait queue is unbounded** (§5) |
| Concurrent streams | 3 per user | **per instance** (§5) |
| Provider timeouts/retries | `PROVIDER_TIMEOUT_MS` 120 s, idle timeout, ≤ retries, backoff ≤ 8 s | bounded |
| Tool rounds/calls/output | `TOOL_MAX_ROUNDS`, 8 calls per round, bounded result chars | bounded |
| History | 60 messages, 200,000 chars | bounded |
| Sync page | `SYNC_PAGE_LIMIT` | bounded |
| Automates | 25 per user, 2 runs per instance, 30 runs kept, 100,000 result chars | count check is not atomic (two concurrent creates can exceed by one; P3) |
| Push | 5 attempts, backoff ≤ 1 h, 20 per pass, 15 s per send | bounded |
| Conversation list, documents, usage summary, export | **unbounded**, grow with the account | §5 |

## 5. Future scale / operability findings

| Finding | Current impact | Later impact | Classification | Recommended future test/fix |
| --- | --- | --- | --- | --- |
| Client IP from `X-Forwarded-For` with `TRUST_PROXY=true` | per-IP limits bypassable behind a load balancer | abuse at scale | IMMEDIATE CORRECTNESS BLOCKER → **fixed** | keep `TRUST_PROXY=<hops>`; verify against the real load balancer in staging |
| Concurrent-stream limit (`StreamRegistry`) is per process | correct with one instance | N instances allow N×3 streams per user | NEEDS CAPACITY MILESTONE FIX | count streams in Redis or the database |
| Stream cancel (`POST /v1/chat/streams/:id/cancel`) and account-deletion stream cancel are per process | clients also close the connection, which stops the answer on its own instance | a cancel landing on another instance returns `cancelled:false`; a deleted account's stream elsewhere runs to the end (writes then fail on FK) | NEEDS CAPACITY MILESTONE FIX | sticky routing or a shared cancel channel; multi-instance test |
| Automates scheduler: CAS on `next_run_at`, unique queued/running index, `FOR UPDATE SKIP LOCKED`, leases | no duplicate runs across instances | lease expiry uses each instance's clock, not the database's: clock skew can mark a still-running run interrupted (no duplicate notice; `finishRun` checks status) and waste its spend | NEEDS LATER LOAD TEST | use database `now()` for leases; multi-instance skew test |
| Push delivery: claims with `SKIP LOCKED`, leases, send-time checks | no duplicate sends across instances | at-least-once if an instance dies after sending, before recording | SAFE NOW / NEEDS LATER LOAD TEST | crash-between-send-and-record test |
| Document extraction semaphore (2) is per process with an unbounded wait queue holding up to 10 MB per waiter | per-user upload rate limit bounds it | many users uploading at once queue memory and wait without limit | NEEDS CAPACITY MILESTONE FIX | bound the queue, refuse as busy, or move extraction to workers |
| Rate limits fall back to per-instance memory when Redis is unreachable | intentional degraded mode, counted and logged | limits become N× during a Redis outage | SAFE NOW (documented) | Redis outage drill |
| Graceful shutdown cancels every active chat stream immediately (answers saved as stopped) | rolling deploys stop answers in progress | visible to users on every deploy | NEEDS CAPACITY MILESTONE FIX | drain period before `app.close()` |
| `GET /v1/conversations`, `GET /v1/documents`, `/v1/usage` (reads every usage row), `/v1/me/export` (N+1 per conversation) | fine for small accounts | grows linearly per account; export is N+1 | NEEDS LATER LOAD TEST | pagination; aggregate usage in SQL; stream the export |
| Notifications view: up to 2 lookups per notice | bounded by the page size | N+1 under load | NEEDS LATER LOAD TEST | join in one query |
| Document count per user | rate limited only | storage growth | NEEDS CAPACITY MILESTONE FIX | per-account quota |
| Spend controls (carried over from PR #13/#14) | – | system limit serializes admission (~60–250/s); operator view sums the ledger; backfill briefly blocks ledger writes; tokenizer estimate mismatch; staging migration history unknown; no ledger purge tooling | NEEDS CAPACITY MILESTONE FIX | as recorded in ADR 0015/0016 |
| Transactions around network calls | none found: provider calls, pushes and extraction happen outside transactions | – | SAFE NOW | – |
| CPU-heavy work on the event loop | PDF/DOCX parsing is in a child process; scrypt is async | – | SAFE NOW | – |
| Local filesystem | none for correctness (no uploads kept on disk) | – | SAFE NOW | – |

Single-instance assumptions found: per-user stream limit, stream cancel, account-deletion stream
cancel, extraction concurrency. None of them can corrupt data; each weakens a limit or a stop.

Unbounded workloads found: extraction wait queue; conversation, document, usage and export reads
per account; documents per account.

## 6. Android checkpoint

**ANDROID TEST CHECKPOINT WORTHWHILE.** The product flows are complete on Android, the P0/P1
defects found are fixed, and the rest is device behaviour only a phone can show. Manual flows for a
development/staging APK on the Samsung A55 (debug build, test server, fake or controlled providers):

1. Register, sign out, sign in again; sign in as a second account on the same phone and confirm the
   first account's chats, documents and notifications are gone.
2. Chat: send, stream, Stop mid-answer, Regenerate the latest answer (no prompt) and an earlier one
   (confirmation), edit and resend, rename, delete, reopen after restarting the app.
3. Turn on airplane mode mid-answer; switch Wi-Fi to mobile data mid-answer; background the app
   during an answer and return; kill the app mid-answer and reopen.
4. Expire the session (sign out everywhere from the web) and use **Sign in** from the chat banner:
   chats and unsynced changes must remain.
5. Documents: upload PDF, DOCX, TXT and an image from Files, Drive and Downloads; an encrypted PDF; a
   15 MB file; delete one online (removed) and one offline (stays, with a reason).
6. Settings → server address while signed in (refused) and signed out (allowed).
7. Automates: create with the phone's time zone, run now, receive the result notification (needs
   FCM configured by the Director), tap it from a cold start, tap it while signed out and while
   signed in as another account.
8. Android 13+ notification permission prompt, deny then allow; Doze overnight with a scheduled
   automation.

## 7. Deferred (P2/P3), not fixed here

Web: neutral wording for `bad_request`; edit length limit; default mode for new chats; race that can
flash the previous account's list after a switch; Automates times labelled in the browser's zone;
failed runs cannot be opened; prompts and email left in local storage after an expired session;
export and tool audit list not offered.

Android: server document list; zombie conversation when deleting the one streaming; "delete local
data" keeps the sync cursor; stale branches after edits on another device; unknown file size;
Tools/Automates "Sign in" bypasses the account guard; offline sign-out result not shown; push
unregister after the session is revoked (harmless: FK cascade); notifications of a previous account
stay in the tray; offset time-zone ids; partial answers persisted only at the end; reopened
attachments from other devices are listed by id only; a document deleted from its detail screen
returns to the list before a failure reason can show.

API: automation count check not atomic; neutral `bad_request` messages.
