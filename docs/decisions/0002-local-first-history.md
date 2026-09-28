# ADR 0002 — Local-first conversation history

**Status:** accepted

**Context.** History must survive closing the app, work in Demo Mode and offline, and the MVP API
uses an in-memory store.

**Decision.** Room on the device is the source of truth for what the user sees. Each live chat
request carries the relevant history (already filtered by provider rules); the API re-applies the
provider filter, and also records conversations, messages and usage per account for export,
deletion and future sync. Re-sending a message with the same id (regenerate, retry, edit)
replaces that message and everything after it on both sides.

**Consequences.** No cross-device sync yet (roadmap). Server restarts lose the server-side record
but not the user's history on the device.
