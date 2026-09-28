# ADR 0004 — Server-sent events for streaming and explicit cancellation

**Status:** accepted

**Decision.** `POST /v1/chat/stream` returns `text/event-stream` with typed events (see
architecture.md). Anything that can fail before generation (validation, auth, routing,
unreadable documents) returns an ordinary JSON error. Cancellation happens two ways: closing the
connection aborts the provider requests, and `POST /v1/chat/streams/:id/cancel` cancels explicitly
(useful behind proxies). Per-answer failures are `message.error` events so one Compare answer can
fail while the other succeeds.
