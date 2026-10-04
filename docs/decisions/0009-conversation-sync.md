# ADR 0009 — Pull-based conversation sync with deterministic merging

**Status:** accepted

**Context.** With durable server storage, a user signing in on a new device (or after reinstalling)
should see their conversations, without Room ceasing to be the offline cache.

**Decision.**
- A cursor-based pull endpoint over a per-user, transaction-ordered change sequence. Each change is the
  whole conversation (or a tombstone), so applying a page is idempotent and independent of paging.
- The device merges with fixed rules (see [sync.md](../sync.md)): unconfirmed local deletes win, tombstones
  delete, the server owns structure and messages, a pending local rename wins until confirmed, messages
  merge by id keeping device-only fields, local-only messages are never deleted, no pull during a stream.
- Local deletes/renames that cannot reach the server are remembered (an outbox in `SyncState`) and re-sent
  first on the next sync, so a pull can never resurrect something the user deleted.
- The engine is pure Kotlin and tested offline and against the live API; Android only supplies storage
  and triggers.

**Consequences.** Sync is pull-only: local-only conversations are not uploaded, and documents and settings
do not sync. A stale local message can survive a server-side regenerate (documented trade-off). Cursor
state is device-local and safe to lose.
