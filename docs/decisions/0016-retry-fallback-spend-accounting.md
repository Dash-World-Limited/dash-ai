# ADR 0016 — Retry and fallback spend accounting

**Status:** proposed (branch `feature/retry-fallback-cost-accounting-0lvcb4`; awaiting the Director's approval).
Extends [ADR 0015](0015-atomic-spend-reservations.md). Nothing in it is replaced: `spend_reservations`, the
inference ledger, advisory-lock admission, `inference_spend_daily`, the worst-case estimate, the router and the
reservation lifecycle stay as they are.

## The gap

One logical request (a chat answer, an Automates run) holds one reservation: the worst case of **one provider
path** (every tool round and the final answer, on the dearest paid provider in its route). But a request may make
more provider requests than that path: a retry of the same provider, a fallback to the next provider, or both.
A failed attempt may still be billed (a timeout, a broken stream, a 5xx after the provider worked on it), so
attempt A, then retry B, then fallback C could together spend more than the hold, and the aggregate limits
could be passed by the difference.

## Invariant

Before **every** paid provider attempt starts, for every configured aggregate limit *L*:

    actual(S, W) + Σ outstanding(r) + next attempt's worst case ≤ L

which holds if the request's own hold covers everything its earlier attempts may have cost plus the next attempt:

    covered(r) = Σ cost(earlier attempts of r) + worstCase(next attempt) ≤ reserved(r)

When that is not true the hold is **extended** atomically under the same scope locks, or the attempt is not sent.

## What the original reservation covers

The admitted path: on any one paid provider of the route, the first attempt of round 0, then (with tools) the
first attempt of each later round up to the final answer, each at its round's input budget and the full output
cap. A request that only makes those attempts never extends: each attempt's worst case is priced on the request
actually being sent, which the orchestrator already holds to its round's budget, so the sum stays within the
admitted amount (tests prove a full tool loop makes no extension).

## What an extra attempt is

Any attempt beyond that path: a retry (`retry > 0`), a fallback provider's attempts (`fallbackIndex > 0`), or a
later round whose room was used by an earlier retry. Nothing labels these up front; the coverage check above
finds them, because they are exactly the attempts that would push `covered` past `reserved`.

## Per-attempt worst case

`AiPlatform.attemptWorstCaseUsd(provider, inputTokens)`: the request being sent (its estimated input tokens, the
same three-characters-per-token estimate the ledger uses, measured on the exact system prompt, turns, tool
results and tool schemas of that attempt) at the provider's dearest model, plus that model's output cap
(`MAX_OUTPUT_TOKENS` or the adapter's lower cap). A fallback is priced with the fallback provider's own prices
and caps, a retry with the retried provider and the exact request re-sent. An unpriced paid model cannot be
bounded: the attempt is not sent (fails closed). Free and demonstration providers cost nothing and never extend.

## What earlier attempts count (billing uncertainty)

Each request keeps an in-process `SpendCoverage`: one entry per attempt it started.

| Attempt outcome | Counted as |
| --- | --- |
| In flight | its worst case |
| Succeeded, ledger row written | the ledger row's cost (provider-reported usage when given) |
| Refused by the provider with a 4xx before any output (400, 401, 403, 404, 413, 422, 429) | the ledger row's cost (0: nothing was processed) |
| Anything else that began: 5xx, connection error, timeout (408 included), stream broken after partial output, empty answer, cancelled | **max(ledger cost, worst case)**: billing is uncertain, so the attempt keeps its full worst case until the request settles |
| Ledger write failed | its worst case |

The reservation never shrinks while the request runs: a failed attempt's room is not given back to the request
or to anyone else until settlement, which (unchanged) records the ledger's paid cost as the hold's actual and
releases the rest.

## Extension (`Store.extendSpendReservation`)

Called only when the in-process check finds the next attempt not covered, so a request that follows its admitted
path never touches the database between admission and settlement.

PostgreSQL, one `READ COMMITTED` transaction:

1. `SET LOCAL lock_timeout`.
2. `SELECT … FOR UPDATE` the reservation row (serializes every extension of one request). With it, in the same
   statement: whether this attempt is already registered, the request's paid ledger cost so far (`recorded`,
   through `inference_attempts_inference_idx`), and `inflight` = the worst case of attempts registered for this
   hold that have no ledger row yet.
3. Inactive, expired or missing hold → refused (`inactive`); the attempt is not sent.
4. Attempt already registered → `duplicate`, no effect (idempotent: a retried call after a lost reply, or two code
   paths racing for the same attempt, extend once).
5. `target = max(prior, recorded + inflight) + attemptUsd`, where `prior` is the caller's own count of its earlier
   attempts (above, the more conservative of the two wins). `increase = target − reserved`.
6. `increase ≤ 0` → register the attempt; no scope lock needed (the hold does not grow).
7. Otherwise take the advisory lock of every scope with a limit, in the same fixed order as admission
   (system → plan → person), then **one statement** reads actual and outstanding for every scope from one
   snapshot and, only if `actual + reserved + increase ≤ L` for all, adds `increase` to the hold and registers
   the attempt. Else refused with the first limit that does not fit and fresh usage.

Lock order: an extension takes its own reservation row, then scope locks. Admission takes scope locks and only
inserts new rows; settlement takes only the row; housekeeping skips locked rows. No path takes a scope lock and
then a reservation row, so there is no cycle. Deadlock or serialization failures are retried (three times, as
admission); a lock timeout is not. Any error refuses the attempt (fails closed).

Attempt identity is `(reservation, fallbackIndex, round, retry)`, the same coordinates every ledger row carries,
which is also how `inflight` matches registered attempts to the ledger. It is stored in
`spend_reservation_attempts` (**migration 13**, additive; migrations 1–12 unchanged): ids, internal
provider/model, the attempt's worst case and the increase it caused. No content. Rows go with their reservation
(`ON DELETE CASCADE`, purged with it after 30 days). The table is needed because two attempts of one request in
flight together (never on one instance today, but possible if two instances ever ran one request) must be
held together, and a duplicate call for one attempt must not add twice; the reservation row alone can do only
one of those.

The in-memory store applies the same rules with no `await` between check and update (atomic within its process).

## Retry flow

Before a paid retry is sent: cover it (extend if needed). Refused → no retry; the failure that wanted the retry
stands, and the request moves to the fallback decision exactly as if retries were used up (so a free provider
later in the route may still answer). Bounded: retries per provider, providers per route; nothing re-routes in a
loop.

## Fallback flow

Before a fallback provider's first attempt: cover it at that provider's prices. Refused → that provider is
skipped and the next one in the route is considered (a free provider needs no cover). Nothing left → the
earlier provider failure is returned (neutral wording; spend and provider details stay in logs and metrics).
A fallback cheaper than the room left needs no extension.

## Tool rounds

Normal rounds are part of the admitted path and never extend on their own. A later round that is no longer
covered (an earlier retry used its room) is extended like any extra attempt; if that is refused, the answer
ends where it is, exactly like the existing "stopped at its spend reservation" path (`finishReason: length`),
because text and tool results already reached the person.

## Failure semantics

| Event | Behaviour |
| --- | --- |
| Extension refused by a limit | Attempt not sent; retry dropped / fallback skipped / answer ended (above). |
| Database unavailable, lock timeout, repeated deadlock during extension | Same as refused (fails closed). |
| Hold inactive or expired | Same as refused. |
| Cancel after a provider started | Attempt counted at its worst case; request settles from the ledger. |
| Partial output then failure | Chat: final (unchanged, no retry or fallback). Automates: fallback covered first. |

Client responses stay neutral; metrics and logs tell provider failure, extension refused and extension
unavailable apart.

## Metrics

`dash_ai_spend_extension_attempts_total{kind}`, `dash_ai_spend_extensions_total{kind,outcome}` (extended,
covered, duplicate, denied, inactive, error), `dash_ai_spend_extension_usd_total{kind}`,
`dash_ai_spend_prevented_attempts_total{kind,reason}`. `kind` is retry, fallback or round. No request ids,
provider error text, prompts or answers in labels or logs. The overage metric of ADR 0015 is unchanged.

## What can still exceed a hold

Within the estimate model, no attempt starts uncovered. The ledger can still exceed a hold when a provider
reports more input tokens than the three-characters-per-token estimate (tokenizer mismatch), or a provider
bills something it did not report. Both are counted by the existing overage metric.

## Not in this milestone

Per-request ceiling (`MAX_REQUEST_AI_COST`) across retries and fallbacks; tokenizer-accurate estimates; the
other ADR 0015 known gaps (system-limit admission serialization, ledger-based operator view, ledger purge
tooling, unreserved engineering routes).
