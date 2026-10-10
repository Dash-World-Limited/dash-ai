# Attempt-ledger safety invariants

- Append-only semantics: inference attempts are never updated into a different outcome.
- No user prompt or generated response content is stored in the attempt ledger.
- Cost aggregation includes failed and fallback attempts.
- Unknown provider cost is explicit; it is never silently presented as known zero cost.
- Consumer APIs never expose provider/model identity from attempt records.
- Spend gates are not enabled until durable attempt persistence and aggregation tests are green.
