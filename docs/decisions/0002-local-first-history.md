# ADR 0002 — Local-first conversation history

**Status:** accepted; the "no cross-device sync" consequence is superseded by [ADR 0009](0009-conversation-sync.md)

**Context.** History must survive closing the app, work in Demo Mode and offline, and the MVP API
uses an in-memory store.

**Decision.** Room on the device is the source of truth for what the user sees. Each live chat
request carries the relevant history (already filtered by provider rules); the API re-applies the
provider filter, and also records conversations, messages and usage per account for export,
deletion and future sync. Re-sending a message with the same id (regenerate, retry, edit)
replaces that message and everything after it on both sides.

**Consequences.** (Original) No cross-device sync, and a server restart lost the server-side record
because the MVP store was in memory. Both are now addressed by [ADR 0007](0007-postgresql-persistence.md)
and [ADR 0009](0009-conversation-sync.md); Room remains the local cache the UI reads.
