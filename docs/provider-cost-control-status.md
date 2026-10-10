# Provider & Cost Control Foundation — status

This branch remains a backend-only foundation. No production provider activation is part of this milestone.

## Completed on this branch

- Amazon Bedrock adapter and Nova model routing support.
- Provider-neutral routing extensions for capability, cost and health.
- Normalized quota policy and privacy eligibility metadata.
- Operator-only provider diagnostics.
- Usage cost estimates in the existing answer-level usage ledger.
- Pure spend-circuit-breaker decision primitives and boundary tests.

## Next implementation slice

Before wiring spend limits into live inference, persist **every provider attempt** (including failed/retried/fallback attempts), then aggregate spend from that attempt ledger. This prevents undercounting when a request tries more than one paid provider.

Required attempt ledger fields:

- inference/request id
- user id where applicable
- task/category
- provider + served/configured model
- attempt index and fallback index
- started/finished timestamps and latency
- success/failure + normalized error code
- provider-reported input/output/cached token counts when available
- estimated usage only when reported usage is unavailable, with an explicit source flag
- estimated/actual cost fields where available
- currency

The ledger must not store prompt or response content.

## Rollout rule

Do not enable spend enforcement against the answer-level usage table. The enforcement path should only become active after per-attempt accounting is persisted and PostgreSQL daily/monthly aggregation is covered by tests.
