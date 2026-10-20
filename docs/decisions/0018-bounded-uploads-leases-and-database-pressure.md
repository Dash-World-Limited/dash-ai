# ADR 0018 — Bounded document extraction, database-clock leases and database pressure

**Status:** proposed (branch `feature/capacity-reliability-bounds-qg1u4b`, stacked on ADR 0017's
branch; awaiting the Director's approval).

## Context

The capacity milestone measured each finding before changing it (local PostgreSQL 16, Redis 7, the
`apps/api/test/cluster` harness, fake providers only):

| Finding | Reproduction (before) |
| --- | --- |
| Document uploads were unbounded per instance: the multipart body was read, then waited on a module-wide semaphore of 2 with no queue limit | 40 × 9 MB slow PDFs on one instance: all accepted and queued, p50 37.8 s, max 65.1 s, API RSS 180 → 656 MB |
| No ceiling on documents per account | any number could be stored; `/v1/documents` and every chat over documents grew without limit |
| Automates and push leases were written and judged on each instance's own clock | an instance 1 h fast saw a healthy run's 780 s lease as expired and ran it again |
| `/v1/usage` read every usage row of the account to sum it | 100,000 messages: 303 ms, +39 MB heap per request |
| `/v1/me/export` ran two queries per conversation and built the whole document in memory | 5,000 conversations / 100,000 messages: 10,058 queries, 8.9 s, a 174 MB string, +226 MB heap |
| An exhausted pool or a lost database answered **500 "Something went wrong"** after waiting up to 10 s | `test/pg-pressure.test.ts` against the old code: 500, ~10 s |

## Decision

1. **Extraction gate per instance** (`src/documents/gate.ts`). An upload takes a ticket *before* its
   body is read, so bodies in memory are bounded by `DOCUMENT_EXTRACTION_CONCURRENCY` (2) +
   `DOCUMENT_EXTRACTION_QUEUE` (6), each ≤ 10 MB; one account holds at most
   `DOCUMENT_UPLOADS_PER_ACCOUNT` (4). No room → **503 busy** at once (never queued without limit).
   A queued upload gives up after `DOCUMENT_EXTRACTION_QUEUE_WAIT_MS` (15 s) or when its client
   disconnects; a ticket is released exactly once (parser timeout, crash, disconnect, shutdown). The
   isolated extraction child is killed on abort and exits by itself if its parent dies. No external
   worker service: the evidence does not need one.
2. **Documents per account** are capped by `DOCUMENTS_MAX_PER_ACCOUNT` (200, an operational bound,
   not a plan limit), enforced in the store inside one transaction that locks the user row, so
   concurrent uploads on several instances cannot overshoot. Over the cap: 409 with a plain message.
3. **Leases on the database clock.** Automates run leases and push delivery leases are written as
   `statement_timestamp() + lease` and judged against `statement_timestamp()`. Instance clock skew
   no longer decides who owns a run. Execution stays at-least-once (a crash after the provider answer
   but before the result is saved can repeat a run); results and notifications are written once per
   run id.
4. **Usage summary in SQL** (`GROUP BY`), recent rows with `LIMIT`.
5. **Export streamed.** Conversations are read 200 at a time (messages and tool activity in one
   query each per batch) and written to the response as they are read. At most two exports run at
   once per instance; a third is busy. A failure part-way cuts the response, so a partial export can
   never parse as a complete one.
6. **Database pressure is "busy", bounded.** `DATABASE_POOL_ACQUIRE_TIMEOUT_MS` (5 s, was a fixed
   10 s) bounds the wait for a pooled connection or an unreachable server. Pool timeouts, connection
   failures and statement timeouts (`src/store/dbErrors.ts`) answer **503 busy, retryable** and are
   counted in `dash_database_errors_total{kind}`; anything else stays a 500. The pool size is
   unchanged (measured first: see the handoff report). `/metrics` adds
   `dash_database_pool_connections{state}`, `dash_event_loop_delay_seconds{stat}` and
   `dash_process_resident_memory_bytes`.
7. **Fake provider failure shapes** for tests only: slow first byte, stall after partial output,
   broken connection after partial output, one failure then success, one provider down.

## Consequences

- An instance under document pressure refuses uploads quickly instead of growing its memory; clients
  see the same neutral busy message as other overloads and retry.
- 200 documents per account is a bound chosen for memory and response size, not a commercial limit;
  it is configurable.
- No migration: the lease columns already exist; only how they are written and compared changed.
- The conversation list is still unpaginated (measured bound in the handoff report); sync is
  already paginated.
