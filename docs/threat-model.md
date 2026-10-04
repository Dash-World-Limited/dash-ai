# Threat-model review (production-hardening milestone)

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

## Residual risks (not fixed in this milestone)

- **Prompt injection through tool results** is reduced, not eliminated. Safe today because only harmless
  read-only built-in tools exist; any plugin reading external content (mail, web, issues) needs its own review,
  and write tools need per-call user confirmation.
- **Existence oracle:** client-chosen conversation ids are global, so a different response for "taken by
  someone else" reveals that an id exists. Ids are random UUIDs in the app; the API also accepts shorter ids.
- **Rate limits are per process** (in memory). Multiple instances need a shared limiter.
- **Email and display name** are plaintext personal data (see [data-inventory.md](data-inventory.md)).
- **No session list or remote sign-out UI**, no password change or reset yet.
- **Whoever runs the server holds the key**: field encryption protects dumps and backups, not a compromised host.
