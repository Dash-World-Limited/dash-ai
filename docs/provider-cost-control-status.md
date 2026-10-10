# Provider/cost-control milestone status

## Implemented on this branch

- Amazon Bedrock runtime adapter and Nova tier selection inherited from the Bedrock foundation.
- Internal model cost estimation and usage recording inherited from the Bedrock foundation.
- Normalized provider quota tracker with soft/hard exhaustion.
- Explicit provider privacy classification; sensitive traffic fails closed unless approved.
- Internal billing classification metadata for routing policy.
- Router filtering/deprioritization based on privacy and quota state.
- Operator-only quota diagnostics in `/v1/router`.
- Pure spend circuit-breaker decision primitive and boundary tests.
- Guardrail tests for privacy and quota routing.

## Deliberately not live yet

- No provider has been activated by these changes.
- No production configuration has been changed.
- No free third-party provider has been approved or configured.
- Spend decisions are not yet wired to live traffic because durable multi-instance spend aggregation and immutable per-attempt accounting still need to be completed.

## Next engineering slices

1. Durable per-attempt inference ledger (success/failure/retry/fallback/latency/token-source/cost).
2. PostgreSQL-backed daily/monthly spend aggregation and atomic budget reservation/circuit breaking.
3. Extensible provider catalog plus reusable compatible-provider adapter for approved APIs.
4. Provider-specific quota/config ingestion.
5. Entitlements and plan budgets.
6. Controlled live-provider smoke/rollout after explicit approval.
