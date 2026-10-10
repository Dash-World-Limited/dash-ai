# Provider-attempt ledger

DASH AI must account for provider cost at the **attempt** level, not only at the final-answer level.

A single user request may cause retries and provider fallbacks. Every attempt can consume billable tokens even when it fails or is discarded. Spend controls therefore must aggregate attempts.

## Rules

- Never store prompt, response, tool arguments or tool results in the attempt ledger.
- Prefer provider-reported token usage. Mark estimates explicitly.
- Prefer settled/provider cost when a provider exposes it; otherwise use the configured model-price estimate.
- A failed retry or fallback attempt is still chargeable and must remain in the ledger.
- Cancellation is recorded as an attempt outcome but must not be retried automatically.
- Spend enforcement must use this ledger once persistence and aggregation are live; the existing answer-level `usage_records` table remains for product usage summaries.
- Provider/model identity is internal diagnostics only and must not be exposed to consumer clients.

## Rollout sequence

1. Add additive PostgreSQL persistence for attempts.
2. Record attempts from streaming chat and background generation paths.
3. Add daily/monthly spend aggregation and indexes.
4. Test retries, fallbacks, cancellation and unknown-cost behavior.
5. Only then wire the spend circuit breaker into inference admission.

Live providers remain disabled until the separate production rollout procedure is approved.
