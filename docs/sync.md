# Conversation sync (server → Android)

After sign-in (and whenever the app starts signed in) the Android app pulls the account's
conversations from the server into Room. **Room stays the local cache** the UI reads; the sync
service only merges server state into it. Demo Mode is untouched.

## What is real, and what is not

| | Status |
| --- | --- |
| `GET /v1/sync/conversations` (cursor, tombstones, full conversations) | ✅ Real, tested on memory and PostgreSQL stores |
| `ConversationSyncService` (pure Kotlin) with deterministic merge rules | ✅ Real, 22 unit tests + a live test against the real API |
| App wiring (`PrefsSyncStateStore`, `ChatViewModel` triggers, rename/delete outbox) | ⚠️ Written but **not compiled or run in the authoring environment** (no Android SDK); CI builds and tests the module |
| Pushing local-only conversations to the server | ❌ Not implemented. A conversation that exists only on a device stays only there |
| Syncing documents, attachment details, prompts, favourites or settings | ❌ Not implemented (documents remain per-device references) |
| Background/periodic sync, push notifications | ❌ Not implemented. Sync runs at sign-in/app start and when a response is not streaming |
| Live refresh of an *open* conversation | ❌ Merged data appears the next time it is opened (a conversation deleted elsewhere closes the open chat) |

## Server protocol

`GET /v1/sync/conversations?cursor=<opaque>&limit=<1..50, default 20>` →

```json
{ "changes": [ { "seq": 3, "deleted": false,
                 "conversation": { "id", "title", "mode", "createdAt", "updatedAt", "titleIsCustom" },
                 "messages": [ …the COMPLETE message list… ] },
               { "seq": 4, "deleted": true, "conversation": { …, "title": "" }, "messages": [] } ],
  "cursor": "4", "latest": "4", "hasMore": false }
```

- `seq` is a **per-user, strictly increasing change number**, bumped by every conversation, message or
  deletion change. It is assigned inside the write transaction under the user's row lock, so numbers
  become visible in order and a cursor can never skip a change (no gaps from concurrent writers).
- A live conversation arrives **whole** (all messages, not a delta); a deletion arrives as a
  **tombstone** (no title, no messages). Applying the same change twice changes nothing.
- A conversation changed twice between syncs arrives once, at its newest `seq`.
- `latest` is the user's newest `seq`. A client whose cursor is *beyond* it knows the server data was
  restored from a backup and starts over from `0`.
- Large conversations make large pages: the page size bounds the number of conversations, not bytes, and
  the server does not yet cap a stored conversation's total size.

## Deterministic merge rules (device side)

The same inputs always produce the same Room state, regardless of how the server splits pages.

1. **Demo conversations are never touched.**
2. **Unconfirmed local deletion wins.** If the user deleted a conversation on the device and the server
   has not yet confirmed it, the server's copy is skipped (never resurrected). Pending deletions are
   re-sent *first* on every sync; a `404` from the server counts as done.
3. **A server tombstone deletes the local conversation and its messages**, even if the device has newer
   local content. There is no undelete. A tombstone for an unknown id is a no-op.
4. **A server conversation with no local copy is inserted** with all its messages.
5. **When both exist:** `mode`, creation time and the message set come from the server. The **title is the
   server's** unless a local rename is still unconfirmed, in which case the local title wins and is
   re-sent. `updatedAt` is the *later* of the two so list order never moves backwards.
6. **Messages merge by id.** A message on both sides takes the server's content, status, provider and
   model, but keeps device-only fields: attachments, routing reason, model choice, error text, reply link
   (inferred for new messages from the compare group or the preceding user message). A message that exists
   **only on the device is kept** — a pull never deletes local messages.
7. **No pull while a response is streaming.** The sync is deferred (and retried at the next trigger) so a
   live stream is never overwritten.
8. **Another account starts from scratch:** a different user id resets the cursor and drops the previous
   account's pending operations.

The cursor advances only after a **whole page** has been applied, so an interrupted sync resumes safely.
Offline or failing syncs are silent: the app keeps working from Room.

**Known trade-off (rule 6):** because a pull never deletes local messages, an answer that the server
replaced (regenerate on another device) can leave a stale local message beside the new one until the
conversation is opened and edited. Merging by id keeps the rule simple and never loses text; a
"server list is authoritative" variant is a possible later refinement.

## Where state lives

- `SyncState` (cursor, pending deletions, pending renames, account id) is stored in app-private
  SharedPreferences (`dash_sync_state`), excluded from backup and device transfer. Losing it is safe: the
  next sync pulls everything (idempotent).
- Rename and delete in the chat UI go through the service (`onLocalRename` / `onLocalDelete`): applied
  locally at once, sent to the server immediately, remembered and retried if that fails.
