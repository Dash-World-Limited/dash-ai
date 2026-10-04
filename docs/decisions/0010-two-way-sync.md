# ADR 0010 — Two-way sync with a server-authoritative, append-only push

**Status:** accepted (extends [ADR 0009](0009-conversation-sync.md))

**Context.** Pull-only sync left conversations written offline, and failed requests, only on the device.
Pushing them back must not let a device duplicate data, resurrect deleted history, forge provider answers
or leak another account's conversations.

**Decision.**
- One push endpoint with three idempotent operations (upload, rename, delete) instead of an operation log:
  each operation is safe to repeat by construction, so retries need no server-side state.
- Uploads carry user messages only and may only append a newer tail to an existing conversation; tombstones
  refuse them; another account's ids are rejected without detail.
- Renames are compare-and-set on a per-conversation title revision (a user rename always beats a generated
  title); the first writer to reach the server wins.
- Devices upload only conversations they marked while signed in to the same account (a `ChatSession` hook),
  never everything that happens to be in Room.
- The device pushes before it pulls, one operation per request, keeps work on transient failures and drops
  operations the server rejects as invalid.

**Consequences.** Offline messages from a device whose clock runs behind the server can be skipped (they stay
local). Concurrent offline renames resolve to the first one that reaches the server. No document/settings sync.
