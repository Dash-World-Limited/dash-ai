# ADR 0007 — PostgreSQL persistence behind the Store interface

**Status:** accepted

**Context.** The MVP kept all server state in memory, so accounts, sessions and history vanished on
restart. Production needs durable storage, safe schema evolution and protection for document text.

**Decision.**
- Keep the existing async `Store` interface and add `PostgresStore` (`pg`, no ORM). `MemoryStore`
  stays for isolated tests and demos; both pass one contract suite, and the whole API suite also runs on
  PostgreSQL. Production refuses the in-memory store.
- Hand-written, append-only SQL migrations with recorded checksums and an advisory lock; auto-migrate in
  development, an explicit migrate step (verified at start-up) in production.
- Encrypt extracted document text with AES-256-GCM (key from configuration, bound to user and document
  id, key-id rotation). Encrypt only that field: it is the most sensitive free text the server holds and
  the one that is cheap to encrypt without losing queryability. Message content is not encrypted by
  the application yet.
- Soft-delete conversations as content-free tombstones with a per-user, transaction-ordered change
  counter, which is what makes sync (ADR 0009) correct.
- Client-chosen message ids are unique only within a conversation, so users cannot collide.

**Consequences.** A database and an encryption key are now deployment requirements. Losing the key
makes stored document text unreadable. There is no bulk re-encryption job. Field-level encryption of
messages and managed-database operations (backups, PITR, TLS) are future work.
