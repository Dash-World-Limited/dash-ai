# What Dash AI stores, and how it is protected

Audit of everything the API persists (PostgreSQL, see [persistence.md](persistence.md)), what can
contain a user's private words, and how each field is protected. "Encrypted" means AES-256-GCM
ciphertext from `DataCipher`, keyed from `DATA_ENCRYPTION_KEY` (never stored in the database), with
the ciphertext bound to its row so it cannot be moved to another row or user.

## Conversation data

| Field | Private content? | Stored as | Notes |
| --- | --- | --- | --- |
| `conversations.title_enc` | **Yes** — generated from the user's first message, or typed by the user | Encrypted | Since migration 4. Tombstones keep no title at all. |
| `messages.content_enc` (user) | **Yes** | Encrypted | Since migration 4. |
| `messages.content_enc` (assistant) | **Yes** — answers restate the user's information | Encrypted | Since migration 4. |
| `conversations.title`, `messages.content` | Legacy plaintext columns | `NULL` for every row written by this version | Rows from before migration 4 are encrypted by the backfill (`data:encrypt`, automatic at start-up outside production). A later migration drops the columns once `encryptionStatus()` reports zero. |
| `messages.role`, `status`, `origin` (provider), `model`, `demo`, `compare_group_id`, `created_at` | No — provider/model metadata and structure | Plaintext | Needed for ordering, sync and internal operations (provider and model are never sent to the apps; ADR 0012). Timing and which provider was used are metadata a database reader can see. |
| `messages.attachment_ids` | No (opaque ids) | Plaintext | |
| `conversations.mode`, `title_is_custom`, `title_rev`, `sync_seq`, timestamps, `deleted_at` | No | Plaintext | Sync machinery. |
| `documents.extracted_text_enc` | **Yes** | Encrypted | Since migration 1. Raw file bytes are never stored. |
| `documents.name` | **Possibly** (file names like `divorce-settlement.pdf`) | Plaintext | Residual risk; see recommendations. |
| `documents.status_detail` | No — fixed server messages | Plaintext | |
| `automations.name_enc`, `prompt_enc` | **Yes** | Encrypted | Since migration 7, bound to the row (AAD). |
| `automation_runs.content_enc` | **Yes** — generated results, possibly edited by the person | Encrypted | Since migration 7, bound to automation and run. |
| `automations.schedule`, `time_zone`, `mode`, `status`, `next_run_at` | No — but the zone hints at location and the schedule at routine | Plaintext | Needed by the scheduler. |
| `push_devices.token_enc` | **Yes** — a device push token | Encrypted | Since migration 8, bound to the row. Never logged, returned or exported; removed with the session. |
| `push_devices.token_hash`, `platform`, `app_version`, timestamps; `push_deliveries`; `users.push_automates` | No | Plaintext | Delivery machinery; error codes are normalized, never provider text. |
| `automation_runs.status`, `trigger`, `error_code`, `provider`, `model`, timestamps; `notifications` | No | Plaintext | Provider and model are internal; never sent to the apps. |

## Account and operational data

| Field | Private content? | Stored as | Notes |
| --- | --- | --- | --- |
| `users.email` | Personal data | Plaintext (lower-cased, unique) | Needed for sign-in lookups. |
| `users.display_name` | Personal data | Plaintext | Control characters rejected at registration. |
| `users.password_hash` | Secret | scrypt hash | |
| `sessions.token_hash` | Secret | SHA-256 of a 256-bit token | Raw tokens are never stored. |
| `usage_records` | No — provider, served model, token counts, estimated USD cost (`estimated_cost_usd`: internal cost ledger, null when the price is unknown, 0 for demonstrations; never in consumer responses) | Plaintext | |
| `inference_attempts` | No — one row per AI provider attempt: internal provider id, served and configured model, pricing class, plan, task, mode, timestamps, latency, outcome and normalized error code, retry/round/fallback position, provider-reported and estimated token counts, estimated and provider-reported USD cost, routing metadata (route key, candidate order, rejection reasons, sensitivity) | Plaintext | **Never** prompts, documents, answers, tool arguments or provider error text. Append-only accounting (migration 10). Deleting an account sets `user_id` to `NULL` and keeps the row, so spend totals stay correct without identifying the person. Internal only: never in consumer responses or exports. See [provider-platform.md](provider-platform.md). |
| `plugin_settings` | No — plugin ids and scope ids | Plaintext | |
| `tool_invocations` | No — plugin/tool labels (sanitised), status, sizes, a bounded call id | Plaintext | **Never** arguments or results. Model-supplied names are reduced to safe labels; provider call ids to `[A-Za-z0-9_.:-]{1,64}`. |
| `tool_executions` | No — a SHA-256 key, user id, status, timestamps | Plaintext | At-most-once ledger for side-effecting tools. The key hashes user, conversation, user message, tool and arguments; nothing can be read back from it. Deleted with the account. |
| Redis (rate limiting, optional) | No — SHA-256 of the limit key, a token count and a timestamp | n/a | Expires after one window (≤ 15 min). No IPs, user ids or emails in the clear. |
| Metrics (in memory, `/metrics`) | No — counts and durations labelled with provider ids, codes and statuses | n/a | Free-text label values are replaced by `other`. |
| Android `dash_local_owner` preferences | No — the signed-in account id and a "wipe pending" flag | App-private | Decides whose data the device holds; excluded from backup. |

## Outside the database

| Place | What can appear | Protection |
| --- | --- | --- |
| Server logs | Request method/path (query stripped), status, timings, ids, codes, counts | Bodies and headers are never logged; error messages pass through secret redaction **and** quoted-value scrubbing (driver errors can quote values); integration tests send canaries through prompts, documents, answers, titles, sync pushes and renames and assert none reach the logs. |
| Error responses | Fixed messages written for users | Validation errors name fields, never echo values. |
| SSE tool events | plugin, tool, status, duration, bounded call id | Never arguments or results. |
| Telemetry | — | None exists. |
| Android device | Everything the user sees (Room), sync state (ids, titles of pending renames) | App-private storage, excluded from backup and device transfer; session token encrypted with an Android Keystore key. |

## Residual risks and recommendations

1. **Document names** are plaintext. They are shown in lists, so encrypting them means decrypting on list
   (cheap). Recommended next: `documents.name_enc` with the same two-phase pattern as migration 4.
2. **Emails and display names** are plaintext. Encrypting emails needs a keyed blind index (HMAC of the
   normalised email, separate key) for unique sign-in lookups; recommended only with a clear requirement,
   since it complicates support and password reset.
3. **Metadata** (who used which provider when, conversation sizes, timestamps) stays visible to anyone
   with database access. That is inherent to server-side sync.
4. Field encryption protects against database dumps, backups and read-only database access. It does **not**
   protect against someone who controls the running server or its configuration (they hold the key).
