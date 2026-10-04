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
| `conversations` | id, owner, title, mode, timestamps, `deleted_at`, `sync_seq` | Deletion is a tombstone (title scrubbed, messages removed) so other devices learn about it. Ids are never reused. |
| `messages` | per-conversation id, role, content, provider, model, status, compare group, attachment ids | Primary key is `(conversation_id, id)`: client-chosen message ids cannot collide across users. |
| `documents` | metadata + **encrypted** extracted text | Raw uploaded bytes are never stored. |
| `usage_records` | provider, model, token counts per answer | |
| `plugin_settings` | a user's plugin choices | No row = never configured = disabled. |
| `tool_invocations` | tool-call audit rows | Metadata only: never arguments or results. |
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

## Encryption of document text at rest

`documents.extracted_text_enc` holds AES-256-GCM ciphertext. The key (`DATA_ENCRYPTION_KEY`,
base64 of 32 random bytes) comes only from server configuration; it is never stored in the
database. Each value has a random 96-bit nonce and is bound (as GCM additional authenticated data)
to its user and document id, so ciphertext copied to another row or user fails authentication.
Listing documents reads only plaintext metadata (`extracted_chars`), never the text.

**Key rotation:** set the new key as `DATA_ENCRYPTION_KEY` with a new `DATA_ENCRYPTION_KEY_ID` and
keep the old one in `DATA_ENCRYPTION_PREVIOUS_KEYS=old_id:base64`. New writes use the new key; old
rows stay readable. There is no bulk re-encryption job yet.

**Back up the key** (in a secret manager, separately from database backups): without it stored
document text is unrecoverable.

**What is *not* encrypted by the application:** conversation titles and message content, emails
and usage rows are stored as normal columns. Protect them with the database host's disk/volume
encryption and TLS; field-level encryption of messages is a roadmap item, not something this
milestone claims.

## Running the database tests locally

Any PostgreSQL 14+ works. Tests create a uniquely named schema per test and drop it afterwards, so
a shared dev database is safe, but use a throw-away one anyway:

```bash
export TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/dash_test   # no password in the repo
pnpm test                                    # includes the PostgreSQL store contract + persistence tests
pnpm --filter @dash-ai/api test:pg           # the whole API suite against PostgreSQL
REQUIRE_DB_TESTS=1 pnpm test                 # fail instead of skipping when no database is configured (CI)
```
