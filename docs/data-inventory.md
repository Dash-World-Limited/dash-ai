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
| `messages.role`, `status`, `origin` (provider), `model`, `demo`, `compare_group_id`, `created_at` | No — provider/model metadata and structure | Plaintext | Needed for ordering, sync and labelling. Timing and which provider was used are metadata a database reader can see. |
| `messages.attachment_ids` | No (opaque ids) | Plaintext | |
| `conversations.mode`, `title_is_custom`, `title_rev`, `sync_seq`, timestamps, `deleted_at` | No | Plaintext | Sync machinery. |
| `documents.extracted_text_enc` | **Yes** | Encrypted | Since migration 1. Raw file bytes are never stored. |
| `documents.name` | **Possibly** (file names like `divorce-settlement.pdf`) | Plaintext | Residual risk; see recommendations. |
| `documents.status_detail` | No — fixed server messages | Plaintext | |

## Account and operational data

| Field | Private content? | Stored as | Notes |
| --- | --- | --- | --- |
| `users.email` | Personal data | Plaintext (lower-cased, unique) | Needed for sign-in lookups. |
| `users.display_name` | Personal data | Plaintext | Control characters rejected at registration. |
| `users.password_hash` | Secret | scrypt hash | |
| `sessions.token_hash` | Secret | SHA-256 of a 256-bit token | Raw tokens are never stored. |
| `usage_records` | No — provider, model, token counts | Plaintext | |
| `plugin_settings` | No — plugin ids and scope ids | Plaintext | |
| `tool_invocations` | No — plugin/tool labels (sanitised), status, sizes, a bounded call id | Plaintext | **Never** arguments or results. Model-supplied names are reduced to safe labels; provider call ids to `[A-Za-z0-9_.:-]{1,64}`. |

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
