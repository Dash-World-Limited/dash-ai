# Provider/cost-control progress

Current implementation focus: durable per-attempt accounting before spend enforcement.

The branch now has:

- attempt-level accounting types
- pure attempt spend aggregation
- in-memory attempt ledger for tests/development
- spend-window aggregation
- tests for retries/fallback aggregation and daily/monthly windows

Next code change: add additive PostgreSQL persistence and then wire recording into inference paths.
