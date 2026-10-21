# ADR 0018 — Bounded document extraction, database-clock leases and database pressure

**Status:** proposed (branch `feature/capacity-reliability-bounds-qg1u4b`, on top of ADR 0017, which
is merged; awaiting the Director's approval).

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
| The first streamed export (review) still read whole sections: every conversation row, all messages of 200 conversations at once, the whole usage history | `test/load/export-growth.ts`: one conversation of 10,000 messages +44 MB heap, 200,000 usage rows +207 MB; both died under a 96 MB heap cap (one 20,000-message conversation; 200,000 usage rows) |
| An upload abandoned while its file was being parsed (client gone, or shutdown) was still saved, as an "unsupported" document counted under the ceiling | `extraction-backpressure.test.ts`, both stores: the upload being parsed left a document; the queued one did not |
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
   An upload **abandoned** before it is saved (client disconnect, or shutdown's drain window ending)
   saves nothing and uses no place under the ceiling: the aborted extraction rejects with its own
   internal error (`ExtractionAborted`) instead of an "unreadable" verdict, and the route checks the
   abort again just before saving. A client still listening (shutdown) sees the neutral busy answer;
   `dash_document_extraction_rejections_total{reason="aborted"}` counts them. A malformed file, a
   parser timeout or the memory limit is a verdict on the file and still saves an "unsupported"
   document, as before. Once the insert has started, a disconnect no longer undoes it.
2. **Documents per account** are capped by `DOCUMENTS_MAX_PER_ACCOUNT` (200, an operational bound,
   not a plan limit), enforced in the store inside one transaction that locks the user row, so
   concurrent uploads on several instances cannot overshoot. Over the cap: 409 with a plain message.
3. **Leases on the database clock.** Automates run leases and push delivery leases are written as
   `statement_timestamp() + lease` and judged against `statement_timestamp()`. Instance clock skew
   no longer decides who owns a run. Execution stays at-least-once (a crash after the provider answer
   but before the result is saved can repeat a run); results and notifications are written once per
   run id.
4. **Usage summary in SQL** (`GROUP BY`), recent rows with `LIMIT`.
5. **Export streamed from bounded reads.** Every read is a keyset page that is written out before
   the next is read, and the response is pulled only as fast as the client reads it:
   - conversations, 100 at a time, most recently updated first (`conversations_user_updated_idx`);
   - their messages, 200 at a time across the page, each conversation read in order through
     `messages_conversation_position_idx` and written as soon as its messages are, so a long
     conversation is never held whole;
   - their tool calls, one read of at most 200 for the page, else per conversation 200 at a time;
   - usage rows, 200 at a time (`usage_user_idx`).
   Documents (≤ `DOCUMENTS_MAX_PER_ACCOUNT`), automations (≤ `AUTOMATIONS_MAX_PER_USER`, each with
   ≤ `maxRunsKept` runs), plugin settings and the latest 1,000 tool calls are already capped and are
   read whole. So one export holds at most about 200 messages (≤ 32,000 characters each) or 200 rows
   at a time, whatever the account's size. The JSON shape (`DataExportResponse`) is unchanged; within
   a page of 100, conversations are written in message order, those without messages last. It is a
   read, not a snapshot: a conversation changed while its export runs may be left out of that export
   or miss its newest messages, never repeated. At most two exports run at once per instance; a
   third is busy. A failure part-way, or the account being deleted before the export ends, cuts the
   response short, so a partial export never parses as a complete one.
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
- Growth-sensitive paths after this change:
  - **FIXED:** export (bounded pages, completes under a 96 MB heap cap for 200,000 usage rows or a
    20,000-message conversation, which failed before); `/v1/usage` (SQL aggregate).
  - **SAFE V1 BOUND:** documents per account (ceiling); automations and kept runs; the export's
    tool-activity tail (latest 1,000).
  - **PAGINATION REQUIRED BEFORE RELEASE:** `GET /v1/conversations` still returns every conversation
    (measured in the handoff report; sync is already paginated).
  - **DEFERRED:** usage and ledger history have no retention or purge yet; reads of them are paged
    or aggregated, but the tables grow.
  - **STAGING-ONLY VERIFICATION:** export timing and memory on staging-sized data and hardware.
- The export makes more, smaller queries than one read per section (about 400 for 10,000
  conversations, 1,000 for 200,000 usage rows), traded for a memory bound.
