# Threat-model review

Scope: the API (`apps/api`), its PostgreSQL data, and the sync/plugin paths the Android app uses.
Each row lists the threat, what stops it, and the test that proves it. Items marked **fixed** were
real problems found during this review; each has a regression test that fails without the fix.

| Area | Threat | Mitigation | Evidence |
| --- | --- | --- | --- |
| Encrypted data | Database dump or backup reveals conversations | Titles, all message content and document text are AES-256-GCM ciphertext; key only in configuration | `persistence.test.ts` dumps raw rows and searches for canaries |
| Encrypted data | Ciphertext moved between rows/users | AAD binds ciphertext to conversation/message/document (and user for documents) | "binds message and title ciphertext to their row", document test |
| Key rotation | Old data unreadable after rotation | Key ids per row, `DATA_ENCRYPTION_PREVIOUS_KEYS`, `data:encrypt` re-encrypts to the current key | "rotates every encrypted field to a new key" |
| Key rotation | **Fixed:** new key configured under an existing id → silent read failures and mixed keys | Start-up verifies the current key against stored data and refuses with an actionable message (ids only) | `security.test.ts` "refuses to start with a different key …" |
| Key rotation | **Fixed:** maintenance crashing start-up on rows under a key the server lacks | Maintenance only touches keys it holds | "reads data written under a retired key and fails clearly without it" |
| Sessions | Token theft from the database | Only SHA-256 of 256-bit tokens stored | existing auth tests |
| Sessions | Revocation gaps | Sign-out revokes its session; account deletion revokes all sessions everywhere; expiry enforced and purged | `security.test.ts` session tests |
| Plugin permissions | Model or user enables tools beyond consent | Offered set = registered ∧ user-enabled ∧ scope granted ∧ read-only, rebuilt per request; write tools never run | `tools.test.ts`, `toolcalling.test.ts` |
| Tool invocation | Model text treated as a command | Only structured provider tool calls reach the executor; strict schemas, bounds, timeout, cancellation | `toolcalling.test.ts` look-alike tests |
| Tool invocation | **Fixed:** provider-supplied call ids (unbounded, markup) reaching clients and audit | Bounded plain ids for SSE/audit; original id only replayed to that provider | `security.test.ts` "tool-call ids from providers are untrusted" |
| Tool result injection | Tool output instructs the model | Results travel in the provider's tool-result channel; system prompt marks them untrusted; no write tools exist yet | `toolcalling.test.ts`; residual risk below |
| Sync authorization | Reading or changing another user's conversations | Every query scoped by user; foreign ids rejected/not_found without detail | `sync.test.ts`, `sync-push.test.ts` |
| Cross-user access | Truncating another user's history via a chat with their conversation id | Refused with 404, nothing changes | `security.test.ts` |
| Replay / idempotency | Retried or duplicated pushes duplicate or resurrect data | Upload = create-or-append-newer-tail by id; CAS renames; idempotent deletes; tombstones refuse uploads | `sync-push.test.ts` replay, concurrency and resurrection tests; Kotlin lost-response test |
| Replay / idempotency | Forged provenance (client-made "assistant" answers) | Push accepts user messages only; provider/model/demo/status/attachments are server-made | "devices cannot forge assistant answers …" |
| Logs | Prompts, documents, answers, titles in logs | Bodies/headers never logged; canary tests | `api.test.ts`, `security.test.ts` |
| Logs | **Fixed:** driver/parser errors quoting user values | Quoted segments and key/value details scrubbed | "a server error whose message quotes user content …" |
| Provider cancellation | Stop leaves the provider running or mislabels the answer | Abort reasons mapped (cancel vs timeout) even when SDKs end silently | `adapters.test.ts` abort tests (previous milestone) |
| Secret leakage | Keys/URLs in output | `.env` ignored, secret scan + gitleaks in CI; smoke output redacted; **start-up/migrate errors now redact connection strings** (defence in depth; no leak observed from the pg driver) | `security.test.ts` start-up error test |
| Availability | **Fixed:** NUL byte in a display name → 500 on PostgreSQL | Rejected at the contract (400) and in the Android validator | `security.test.ts`, `contracts.test.ts` |
| Availability | NUL byte in a prompt → whole chat failed on PostgreSQL (reproduced on the previous milestone) | Content stored as ciphertext | `security.test.ts` NUL prompt test |
| Availability | **Fixed (Android core):** one bad timestamp blocked sync forever; a stalled page could loop forever | Bad changes skipped whole and counted; non-advancing cursors rejected | `ConversationSyncTest` malformed-response tests |

## Release-readiness pass (verification milestone)

Ten scenarios were walked end to end. **Fixed** rows were concrete problems found in this pass; each
has a regression test that fails without the fix (mutation-checked where noted).

| Scenario | What stops it now | Evidence |
| --- | --- | --- |
| Stolen session token | 256-bit opaque tokens, only SHA-256 stored, expiry; **new:** `POST /v1/auth/logout-all` signs the account out on every device (Kotlin core `AuthService.signOutEverywhere()`); account deletion revokes all sessions | `security.test.ts` "sign out everywhere", Kotlin `LiveApiContractTest` |
| Malicious document | **Fixed:** extraction ran in the API process without bounds: a 357 KB DOCX cost 48 s and 6 GB, a 357 KB PDF 25 s and 1.1 GB (one upload could OOM-kill the server). Now: decompression budgets measured with native zlib under hard caps (real, not declared, sizes; refused filters), then parsing in a separate process with an empty environment, heap cap, RSS watchdog, time limit, raised OOM score and a concurrency limit; output validated | `documents-hostile.test.ts` (zip bombs, lying headers, PDF Flate bombs, filter tricks, timeouts, server responsive during hostile uploads) |
| Malicious plugin/tool response | Results bounded and returned only through the provider's tool-result channel; unserialisable, throwing and late results contained; thrown values never logged or shown | `tool-adversarial.test.ts` "hostile tool behaviour" |
| Prompt attempting unauthorized tool execution | Only structured calls reach the executor; offered ∩ **currently permitted** (new: re-checked at invocation, fail closed); strict schemas; write tools never run; forged names never resolve | `tool-adversarial.test.ts` (mutation-checked: removing the re-check fails 3 tests) |
| Cross-user access | Every query scoped by user; a sweep of every user-scoped route with another user's ids (conversations, documents, attachments in chat, activity, sync, export, usage) | `security.test.ts` "every user-scoped route refuses another user's ids" |
| Sync replay | Idempotent operations by op id, CAS renames, tombstones refuse resurrection, server-made provenance; provider switching mid-conversation never forks it | `sync-push.test.ts`, `sync-e2e.test.ts`, Kotlin provider-switch test |
| Database compromise | Content encrypted at rest (AES-256-GCM, row-bound AAD); session hashes only; **fixed:** password hashes moved to OWASP's scrypt cost (N=2^15, r=8, p=3; was N=2^14, p=1), verification honours each hash's own (bounded) cost and old hashes are upgraded at sign-in | `unit.test.ts`, `security.test.ts` "upgrades a password hash" |
| Provider outage | Retryable errors per target, idle and total timeouts through the real SDKs, Compare keeps the healthy answer, partial text kept on resets | `provider-contract.test.ts` malformed/outage tests |
| Leaked provider key | Keys only in server env, never logged or returned (401/403 map to a fixed message), redacted from smoke output; rotation = replace the env value and restart | `adapters.test.ts`, smoke redaction tests |
| Compromised Android device | Token encrypted with an Android Keystore key, backups and device transfer excluded, HTTPS-only release config; server-side sign-out everywhere now exists | manifest/config review; see residuals |

Also fixed in this pass (provider contract, not a threat): the last tool round dropped `tools`, which
invalidates Claude thinking replayed from earlier rounds; it now keeps the tools with tool choice "none"
(see [provider-verification.md](provider-verification.md)).

## Residual risks (not fixed in this milestone)

- **Prompt injection through tool results** is reduced, not eliminated. Safe today because only harmless
  read-only built-in tools exist; any plugin reading external content (mail, web, issues) needs its own review,
  and write tools need per-call user confirmation.
- **Existence oracle:** client-chosen conversation ids are global, so a different response for "taken by
  someone else" reveals that an id exists. Ids are random UUIDs in the app; the API also accepts shorter ids.
- **Rate limits are per process** (in memory). Multiple instances need a shared limiter.
- **Email and display name** are plaintext personal data (see [data-inventory.md](data-inventory.md)).
- **No session list**, no "sign out everywhere" button in the app yet (the API and Kotlin core support it),
  no password change or reset yet.
- **Whoever runs the server holds the key**: field encryption protects dumps and backups, not a compromised host.
  An attacker with database *write* access can mint sessions or replace password hashes, and can roll a
  row back to an older ciphertext of the same row (AAD binds rows, not versions).
- **Encrypted PDFs** cannot be measured by the decompression budget; they rely on the extraction process's
  time and memory limits alone. A stream mislabelled as an image gets the larger image allowance (same
  limits apply). The memory watchdog reads `/proc` and is Linux-only.
- **No circuit breaker or automatic failover**: during a provider outage each request waits for its own
  timeout, and Dash Smart does not retry on the other provider once a stream has failed (the app offers
  "retry with the other provider").
- **On-device data**: conversations in Room are protected by the app sandbox and Android file-based
  encryption, not by app-level encryption; a rooted or compromised device can read them. Signing out keeps
  local conversations on the device (Demo Mode shows them); a shared device should use account deletion or
  clear data. Consider wiping or partitioning local data per account on sign-out.
- **Leaked provider key runbook** is manual: revoke the key at the provider, set the new value, restart;
  there is no in-app key management.
