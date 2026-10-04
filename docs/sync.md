# Conversation sync (two-way)

Signed-in devices keep their conversations in step with the server. **Room stays the local cache** the
UI reads; the sync service pushes this device's pending work, then pulls server changes into Room.
Demo Mode is never synced. Documents, prompts and settings are **not** synced.

## What is real, and what is not

| | Status |
| --- | --- |
| `GET /v1/sync/conversations` (pull) and `POST /v1/sync/push` (push) | ✅ Real, tested on the in-memory and PostgreSQL stores |
| `ConversationSyncService` (pure Kotlin): push + pull with deterministic rules | ✅ Real: 33 unit tests against a fake server that mirrors the API's rules, plus live tests where the real Kotlin client syncs two "devices" through the real API on PostgreSQL |
| `ChatSession` reporting saved live user messages for upload | ✅ Real, unit-tested |
| App wiring (`ChatViewModel` triggers: sign-in, app start, connectivity regained; rename/delete; upload hook; `PrefsSyncStateStore`) | ⚠️ **Not compiled or run in the authoring environment** (no Android SDK). The `android.yml` CI workflow compiles and tests the app module |
| Background/periodic sync, push notifications, live refresh of an open conversation | ❌ Not implemented |
| Document, attachment-detail, prompt or settings sync | ❌ Not implemented (by design for this milestone) |

## Protocol

### Pull — `GET /v1/sync/conversations?cursor&limit`
Changes in per-user `seq` order. Each live change carries the **whole** conversation (all messages) plus
`titleIsCustom` and `titleRev`; a deletion is a **tombstone** (no title, no messages). `seq` is assigned
inside the write transaction under the user's row lock, so a cursor never skips a change. `latest` lets a
device detect restored server data (cursor beyond it → start again from `0`).

### Push — `POST /v1/sync/push` (`{operations:[…]}`, at most 20)
Applied in order, each atomically, each **idempotent**:

| Operation | Effect | Results |
| --- | --- | --- |
| `upload {conversation, messages}` | Unknown id: create it with the messages. The user's live conversation: append only messages with **unknown ids that are newer than the newest stored message**. | `applied` (+ `appended`/`skipped` counts), `deleted` (the user's own tombstone: nothing changes), `rejected` (another account's id: nothing changes or is revealed) |
| `rename {conversationId, title, baseTitleRev}` | Compare-and-set on the title revision | `applied`, `conflict` (stale), `deleted`, `not_found` |
| `delete {conversationId}` | Tombstone | `applied` (also when already deleted), `not_found` |

Server-authority rules:

- **Devices contribute only their user's own words.** Uploaded messages become `user` messages; role,
  provider, model, demo flag, status and attachments are never taken from a device (extra fields are
  stripped). Assistant answers only ever come from the server's own provider calls.
- **Append-only tail.** A message older than the newest stored one is ignored, so history that was
  truncated by an edit or regenerate on another device can never be resurrected. Known message ids are
  never rewritten.
- **Deletion is final.** Uploads and renames to a tombstone report `deleted`.
- Timestamps from the future are clamped to server time + 5 minutes.
- **Renames:** a user rename always beats a generated title; otherwise the base revision must match the
  current `titleRev` (first writer to the server wins). Re-sending an applied rename is a no-op. Renames
  through `PATCH /v1/conversations/:id` bump the revision too.
- Per-user rate limit (`RATE_LIMIT_SYNC_PER_MINUTE`) on push and pull.

Because every operation is naturally idempotent, retries need no server-side operation log: repeating a
request (lost response, duplicate delivery, concurrent duplicates) never duplicates a conversation or a
message and does not even create a new sync change.

## Device rules (`ConversationSyncService`)

The same inputs always give the same Room state, whatever the page sizes or retry pattern.

**Push (runs first on every sync):**
1. Only conversations **marked while signed in to the same account** are uploaded (`ChatSession` marks a
   conversation each time it saves a live user message). Conversations already on the device from another
   account or from Demo Mode are never uploaded. Only user messages are sent, newest 100.
2. Order: deletes, then uploads, then renames. A pending delete cancels any pending upload or rename of the
   same conversation.
3. One operation per request, so one bad operation cannot block the rest.
4. Network failures, 401, 408, 429 and 5xx keep the work pending (401 also stops the sync). Any other 4xx
   drops that operation and counts it, so it cannot wedge sync forever.
5. `deleted` → delete the local copy and forget all pending work for it. `conflict` → drop the rename (the
   server title is pulled). `rejected` → keep the local copy, never retry.

**Pull:**
6. Demo conversations are never touched.
7. A conversation with an unconfirmed local delete is skipped (never resurrected).
8. A tombstone deletes the local conversation and its messages and forgets its pending work.
9. A new server conversation is inserted with all its messages.
10. When both exist: mode, creation time and messages come from the server; the title is the server's unless
    a local rename is still unconfirmed; `updatedAt` never moves backwards.
11. Messages merge by id: server content wins, device-only fields (attachments, routing reason, model choice,
    error text) are kept, and messages only on the device are never deleted by a pull (they are uploaded if
    the conversation is marked).
12. A change with an unparseable timestamp or an unknown role is skipped **whole** and counted; a page whose
    cursor goes backwards, is not a number, or stalls while claiming `hasMore` is rejected without moving the
    cursor.

**General:**
13. Nothing syncs while a response is being generated.
14. Another account on the same device starts from scratch (cursor, revisions and pending work are dropped).
15. The cursor advances only after a whole page has been applied; state is saved after every operation, so an
    app killed mid-sync resumes safely.

## End-to-end guarantees (tested)

`apps/api/test/sync-e2e.test.ts` and the Kotlin live contract tests check:

- **Switching provider never forks a conversation.** OpenAI, Claude, Compare, a retry with the other
  provider and Dash Smart inside one conversation produce one conversation with unique message ids, and a
  second device pulls exactly what the first device shows.
- **Pulls during a stream** return the user message only (never a partial answer); the next pull from
  that cursor delivers the finished answer, once.
- **Partial failures:** when storage fails after one operation of a push batch was committed, the request
  fails; retrying the whole batch applies nothing twice.
- **Concurrent devices** pushing, renaming and pulling at the same time converge to one state.
- **Consistent pages on PostgreSQL:** a pull reads its changes and the matching messages in one
  `REPEATABLE READ` read-only transaction, so a page never mixes two points in time.

## Known trade-offs

- **Clock skew vs. the append-only tail.** A message written offline is appended only if its device timestamp
  is later than the newest server message. A device whose clock runs behind can have offline messages skipped
  by the server (they stay on the device). This favours never resurrecting deleted history.
- A pull never deletes local messages, so an answer replaced on another device can leave a stale local copy
  beside the new one.
- A user message uploaded after its request failed has no answer on the server until the user retries.

## State on the device

`SyncState` (cursor, pending deletes/renames/uploads, rename base revisions, last-seen title revisions, account
id) lives in app-private SharedPreferences, excluded from backup and device transfer. New fields have defaults,
so state written by the previous app version still decodes; corrupt state resets to "pull everything", which is
safe because pulls are idempotent.
