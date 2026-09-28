# ADR 0001 — Monorepo with shared contracts

**Status:** accepted

**Context.** The Android app and the API must agree on request bodies, SSE events, limits, the
Dash Smart routing table and upload rules. Drift would break the app silently.

**Decision.** One repository with `apps/android`, `apps/api` and `packages/contracts`. Contracts are
zod schemas plus JSON/SSE fixtures. The API validates with the schemas; the Android client has
hand-written kotlinx.serialization DTOs that are tested strictly against the same fixtures, and a
live contract test runs the real Kotlin client against the real API in fake-provider mode in CI.

**Consequences.** A contract change requires updating the fixtures, which fails tests on whichever
side was not updated.
