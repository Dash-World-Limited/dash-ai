# ADR 0017 — Multi-instance chat streams and graceful drain

**Status:** proposed (branch `feature/capacity-reliability-multi-instance-qg1u4b`; awaiting the Director's approval).

## Context

The API was designed to run as several identical instances behind a load balancer (sessions, data,
spend and Automates live in PostgreSQL; rate limits in Redis). Four pieces of chat-stream state were
still per process, and a local multi-instance harness (`apps/api/test/cluster`) reproduced each one:

| Finding | Reproduction (before) |
| --- | --- |
| The per-account stream limit was check-then-register with an `await` in between | 8 simultaneous requests for one account on **one** instance, limit 3: **7 admitted** |
| The limit was per process | the same account across 2 instances: 7 of 7 admitted (limit 3) |
| `POST /v1/chat/streams/:id/cancel` only knew its own process | a cancel on instance B for a stream on A: `cancelled:false`, the answer ran on for 11 s |
| Account deletion only stopped streams on its own instance | deletion on B: the stream on A kept writing; its final write failed on a foreign key and was logged as an internal error |
| Account deletion could deadlock with an answer being saved (PostgreSQL) | 40 deletions during active answers: 1–2 answered **500**, the account still present |
| SIGTERM had no drain deadline | `app.close()` waited for every stream to end by itself: 34 s with a stalled provider (bounded only by `PROVIDER_TIMEOUT_MS` and retries) |

## Decision

1. **Stream slots in Redis** (`src/chat/streamControl.ts`), using the Redis the shared rate limits
   already need (no new infrastructure). One sorted set per account (`<prefix>streams:u:<sha256>`),
   members are random stream ids scored by expiry. Admission is one Lua script: drop expired members,
   refuse if full, else add. Expiry uses Redis's `TIME`, never an instance's clock. The owning instance
   refreshes its streams every `STREAM_SLOT_TTL_MS / 4`; a crashed instance's slots expire after
   `STREAM_SLOT_TTL_MS` (20 s). A refresh after a Redis restart writes live slots back. Release is
   `ZREM` (idempotent). Without Redis (one instance) the same check-and-take is synchronous in memory.
2. **Admission before anything else.** The slot is taken before the request is prepared, so a refused
   request makes no spend reservation and no provider request; a failure while preparing releases it.
3. **Cross-instance cancel.** A cancel the receiving instance cannot serve locally runs a script that
   checks the stream id is in *that account's* set (another account's id is indistinguishable from an
   unknown one), sets a short-lived marker and publishes on `<prefix>streams:cancel`. The owner stops
   the stream on the message (milliseconds), or at its next heartbeat from the marker if the message
   was missed. Repeating a cancel is harmless.
4. **Account deletion** stops the account's streams on its own instance, then sets an account marker,
   frees its slots and publishes; every instance stops that account's streams and refuses new ones.
   The deletion then locks the account's conversations in id order before deleting the user row (the
   order every chat write uses), and retries a deadlock or serialization failure up to three times.
   A stream whose write fails on the deleted account ends quietly (no internal-error log or event).
5. **Fail closed.** If Redis cannot answer (down, slow past the 1 s command timeout, reconnecting),
   new streams are refused with a neutral, retryable 503 ("DASH AI is busy right now") and counted;
   a cancel that must reach another instance answers the same 503 (the client also closes its
   connection, which stops the answer on its own instance). The general rate limits keep their
   documented per-instance fallback; the stream limit never silently becomes per-instance.
6. **Graceful drain** (`buildApp().drain`, `index.ts`): on SIGTERM the instance answers `/ready` 503,
   refuses new answers and uploads (503, `Connection: close`), Automates and push stop claiming, and
   work in progress gets `SHUTDOWN_DRAIN_MS` to finish. Then `preClose` stops what is left (answers end
   `cancelled` and are saved as stopped, runs end interrupted, spend holds settle), connections are
   closed after their last response, and a hard timer exits the process if anything still hangs.

## What is in Redis

Hashed account keys, random stream ids, expiry scores and `"1"` markers. No prompt, answer, email,
token or user id (a test dumps every key and value to check).

## Consequences

- A Redis outage now refuses new chat answers on every instance until Redis answers. That is the
  chosen trade: the alternative is a per-account limit that multiplies by the number of instances.
  `/ready` reports `degraded` (not 503): every instance is equally affected, so taking one out of
  rotation would not help.
- One extra Redis round trip per answer at admission, one at release, and one batched heartbeat per
  instance every 5 s. No new migration.
- Redis Cluster is not supported (the heartbeat script touches keys of several accounts); one Redis
  primary, as the rate limits already assume.
