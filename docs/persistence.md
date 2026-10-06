# Persistence (PostgreSQL)

The API stores everything durable in PostgreSQL through the `Store` interface
(`apps/api/src/store/store.ts`). Two implementations exist and are held to the same contract tests:

| Implementation | Use | Durable |
| --- | --- | --- |
| `PostgresStore` | Production and any real deployment. Selected when `DATABASE_URL` is set. | ✅ |
| `MemoryStore` | Isolated tests and throw-away local demos. Selected when `DATABASE_URL` is empty. | ❌ (lost on restart) |

Production (`NODE_ENV=production`) **refuses to start** without `DATABASE_URL`
(`ALLOW_MEMORY_STORE=true` overrides this for a throw-away demo and logs a warning), and refuses
`DATABASE_URL` without a valid `DATA_ENCRYPTION_KEY`.

## What is stored

| Table | Contents | Notes |
| --- | --- | --- |
| `users` | id, lower-cased email (unique), display name, scrypt password hash, `sync_counter` | |
| `sessions` | SHA-256 hash of the session token, user, expiry | Raw tokens are never stored. Expired rows are purged hourly and rejected on use. |
| `conversations` | id, owner, **encrypted title**, mode, timestamps, `deleted_at`, `sync_seq`, `title_rev` | Deletion is a tombstone (no title, messages removed) so other devices learn about it. Ids are never reused. |
| `messages` | per-conversation id, role, **encrypted content**, provider, model, status, compare group, attachment ids | Primary key is `(conversation_id, id)`: client-chosen message ids cannot collide across users. |
| `documents` | metadata + **encrypted** extracted text | Raw uploaded bytes are never stored. |
| `usage_records` | provider, model, token counts per answer | |
| `plugin_settings` | a user's plugin choices | No row = never configured = disabled. |
| `tool_invocations` | tool-call audit rows | Metadata only: never arguments or results. Shown again with the conversation; deleted with it. |
| `schema_migrations` | applied migrations with checksums | |

Everything owned by a user cascades from `users`, so `DELETE /v1/me` removes it all.

## Migrations

Migrations are an ordered, append-only list in `src/store/migrations.ts`. Each runs in its own
transaction under a Postgres advisory lock (several instances may start at once), and its SHA-256
checksum is recorded. A later run fails loudly if an applied migration was edited or if the
database contains a migration this server version does not know (an older server against a newer
schema). **Never edit a shipped migration: add a new one.**

```bash
pnpm --filter @dash-ai/api migrate          # applies pending migrations (tsx)
node apps/api/dist/migrate-cli.js           # same, from the built output
```

`DATABASE_AUTO_MIGRATE` defaults to `true` outside production and `false` in production. With it
off the server checks at start-up that every migration is applied and refuses to run otherwise, so
a deployment runs the migrate step deliberately.

## Encryption at rest

Encrypted fields: **conversation titles, all message content (user and assistant), extracted document
text.** Field-by-field audit: [data-inventory.md](data-inventory.md).

### Document text

`documents.extracted_text_enc` holds AES-256-GCM ciphertext. The key (`DATA_ENCRYPTION_KEY`,
base64 of 32 random bytes) comes only from server configuration; it is never stored in the
database. Each value has a random 96-bit nonce and is bound (as GCM additional authenticated data)
to its user and document id, so ciphertext copied to another row or user fails authentication.
Listing documents reads only plaintext metadata (`extracted_chars`), never the text.

**Back up every key** (in a secret manager, separately from database backups): without it stored
document text is unrecoverable.

### Titles and message content (migration 4)

Same cipher and keyring. AAD binds a title to its conversation id and content to its conversation and
message id. The migration is two-phase so it never needs the key inside SQL:

1. **Migration 4** adds `title_enc/title_key_id` and `content_enc/content_key_id` and makes the plaintext
   columns nullable. Every write from this version stores ciphertext only (plaintext `NULL`).
2. **Backfill**: rows written before migration 4 are encrypted in batches (row locks, `SKIP LOCKED`, safe while
   serving). Automatic at start-up outside production; in production run
   `pnpm --filter @dash-ai/api data:encrypt` (`node dist/data-cli.js`). Reads handle both forms meanwhile.
3. **Later migration** (not shipped yet): drop the plaintext columns once `data:encrypt` reports zero
   plaintext rows everywhere.

The server never searches titles or messages, so encryption costs no query capability.

### Key rotation

1. Generate a new key; set it as `DATA_ENCRYPTION_KEY` with a **new** `DATA_ENCRYPTION_KEY_ID`; move the old
   key to `DATA_ENCRYPTION_PREVIOUS_KEYS=old_id:base64`.
2. Run `data:encrypt`: it re-encrypts every title, message and document still under a retired key and prints
   counts (never content).
3. When it reports zero rows under retired keys, remove the old key.

Start-up refuses to run when `DATA_ENCRYPTION_KEY` does not match data already stored under the same key id
(the classic "new key, old id" mistake), with a message naming key ids only. Rows under a key the server
does not hold are left untouched by maintenance and fail clearly when read. Start-up also warns while
plaintext or retired-key rows remain.

**What is *not* encrypted by the application:** document file names, emails, display names, usage rows and
structural metadata (see [data-inventory.md](data-inventory.md)).

## Running the database tests locally

Any PostgreSQL 14+ works. Tests create a uniquely named schema per test and drop it afterwards, so
a shared dev database is safe, but use a throw-away one anyway:

```bash
export TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/dash_test   # no password in the repo
pnpm test                                    # includes the PostgreSQL store contract + persistence tests
pnpm --filter @dash-ai/api test:pg           # the whole API suite against PostgreSQL
REQUIRE_DB_TESTS=1 pnpm test                 # fail instead of skipping when no database is configured (CI)
```
