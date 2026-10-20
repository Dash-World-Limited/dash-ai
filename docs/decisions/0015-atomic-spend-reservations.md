# ADR 0015 — Atomic in-flight spend reservations

**Status:** proposed (branch `feature/atomic-spend-reservations-c4p68e`; awaiting the Director's approval).
Builds on [ADR 0014](0014-provider-and-cost-control-foundation.md) and the worst-case admission it introduced.

**Context.** Spend admission (`SpendGuard.check`, then the router's worst-case fit) read the ledger and
compared each request's worst case with what was left, but nothing recorded that an admitted request was
still running. Requests admitted at the same moment, on one instance or several, were each measured against
the same recorded spend, so together they could pass a limit by the sum of their worst cases (plus up to five
seconds of cached totals across instances). This ADR closes that gap without replacing the ledger, the worst
case, the router or the limits.

## Invariant

For every configured aggregate limit *L* (system monthly, system daily, plan daily, person daily), with scope
*S* and window *W*, a paid request is admitted only if, in **one database snapshot taken while holding S's
lock**:

    actual(S, W) + Σ outstanding(r) + reserve ≤ L        for r active, unexpired, in S

- `actual(S, W)`: paid ledger cost in the window (provider charge, else estimate) — unchanged from ADR 0014.
- `outstanding(r) = max(0, reserved(r) − recorded(r))`, where `recorded(r)` is the paid ledger cost already
  written for r's `inference_id`. An attempt written while its request is still running therefore moves from
  *reserved* to *actual*; it is never counted twice.
- `reserve`: the request's worst case (existing `AiPlatform.costFields` logic), for the dearest paid provider
  left in its route, so a fallback inside the route is covered too.

AVAILABLE = L − ACTUAL − Σ OUTSTANDING. As long as each request's actual cost stays within its reservation,
actual spend in every window stays ≤ L, however many requests run at once and on however many instances.

## Transaction boundary

`Store.reserveSpend` (PostgreSQL) is one `READ COMMITTED` transaction:

1. `SET LOCAL lock_timeout`.
2. `pg_advisory_xact_lock` for each scope that has a configured limit, always in the order
   **system → plan → person** (a fixed order: no deadlock between admissions).
3. **One statement**: computes actual and outstanding for every scope (a single snapshot, so a ledger row or a
   settlement committing meanwhile is seen on both sides or neither) and inserts the reservation only if every
   scope fits.
4. `COMMIT` releases the locks.

Why advisory locks: the serialization point is exactly the aggregate being protected, it is held for one short
statement, there is no retry storm (unlike `SERIALIZABLE`, where every concurrent admission on a busy scope
conflicts), and no counter rows have to be kept in step with the append-only ledger. Locks are per scope: with
only person limits configured, different people never wait for each other; a system-wide limit necessarily
serializes admissions against that one total, but only for the admission statement, never for the provider
call. Ledger writes and settlements take no lock: they can only move cost from outstanding to actual, or
remove an outstanding hold, so they never make an admitted state unsafe. A deadlock or serialization failure
(defensive; not expected with fixed lock order) is retried up to three times; a lock timeout is not retried.

The in-memory store (tests and single-process demos only) performs the same check and insert with no `await`
in between, so it is atomic within its one process. Cross-process and cross-instance guarantees exist only on
PostgreSQL, which production already requires (`DATABASE_URL`; `ALLOW_MEMORY_STORE` is a single-instance demo).

## Reservation lifecycle (`spend_reservations`, migration 12)

| Status | Meaning | Counted? |
| --- | --- | --- |
| `active` | Created at admission, request in flight, `expires_at` in the future. | Yes (its outstanding part). |
| `settled` | Request finished; its paid ledger cost (> 0) is recorded in `actual_usd`; the rest is released. | No. |
| `released` | Request finished with no paid cost (never started, refused before billing, free or demo served). | No. |
| `expired` | The lease passed before the request settled (crash, lost process). A late settlement still records `actual_usd`. | No. |

One reservation per logical request (`inference_id` is unique): every billable attempt of that answer
(retries, tool rounds, fallbacks) is charged against it through the ledger. Rows hold operational metadata only:
ids, plan, task, internal provider/model, amounts and times; never prompts, answers, tools or credentials.
Deleting an account sets `user_id` to NULL (as the ledger does): an active reservation keeps counting against
system and plan limits until it settles or expires.

## Stale recovery

- `expires_at = now + lease`, on the **database clock** (one clock for every instance). The lease is the
  request's enforced execution bound plus a two-minute grace: chat answers are bounded by
  `PROVIDER_TIMEOUT_MS` (the answer's own abort), Automates runs by the run's own time budget, which
  `generateText` now enforces itself. After that bound no new provider request can start (every request's
  signal derives from it), so expiry can only reclaim a request that is gone, and the grace covers writing the
  last ledger row. No heartbeat is needed.
- Counting ignores expired rows by time alone (`expires_at > statement_timestamp()`), so correctness never
  depends on a sweeper running.
- Housekeeping is lazy and idempotent: at most once a minute per instance, after an admission, a bounded
  `FOR UPDATE SKIP LOCKED` update marks lapsed rows `expired`, and finished rows older than 30 days are
  deleted. No new scheduler.

## Reconciliation

When the request ends (any outcome), after its last ledger row is written, `settleSpendReservation` reads the
paid ledger cost for the `inference_id` and records it: `> 0` → `settled`, `0` → `released`; past its lease →
`expired` with the late actual. Settlement is idempotent (a second call changes nothing). Actual greater than
reserved should not happen under the enforced budgets; when it does (today only through a provider retry or a
fallback after a possibly billed failure, which ADR 0014 left outside the worst case), it is logged at error
level and counted (`dash_ai_spend_reservation_overage_total`); the ledger stays the record of what was spent.
If settlement fails it is retried; if it still fails, the hold stays until its lease expires (fails closed).

## Cache

`SpendGuard.check` still caches system totals for up to five seconds and now includes outstanding holds; it is
only the router's first estimate and the operator view. Admission correctness comes from `reserveSpend`. When a
reservation is refused, DASH re-routes once more with the database's fresh availability (free providers may
still serve) before refusing.

## Failure semantics (fail closed)

| Event | Behaviour |
| --- | --- |
| Database unavailable, lock timeout, repeated deadlock | No reservation, no paid call: refused as "busy" (retryable). |
| Reservation made, provider never starts | Released at the end of the request; if the process died, expires. |
| Reconciliation fails | Retried; then the hold stays until expiry (over-protects, never under-counts). |
| Process crash mid-answer | Attempts already written stay in the ledger; the hold expires after its lease. |
| Timeout or cancel | Attempts recorded as possibly billed (ADR 0014), then settled. |
| Provider refused before billing | Ledger cost 0 → `released`. |
| Provider failed after possibly billing | Estimated ledger cost → `settled`. |
| Account deleted mid-request | `user_id` → NULL; still counts for system and plan; settles normally. |

## Not in this milestone

Retry and fallback attempts are charged against the same reservation through the ledger, but the reservation
amount is still one provider path's worst case. The next milestone (retry/fallback accounting) can raise the
amount for extra attempts with an `extend` under the same scope locks, without schema change. Explicit
engineering routes (`PROVIDER_DETAILS=exposed`, refused in production) are not reserved.
