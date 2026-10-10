# Provider cost-control implementation order

The implementation order is intentionally strict:

1. Attempt-level accounting contract and tests.
2. Durable PostgreSQL attempt persistence.
3. Recording from chat and background generation paths.
4. Indexed daily/monthly spend aggregation.
5. Spend-admission checks and kill switches.
6. Free/promotional provider pool integration.
7. Live provider rollout only after all preceding layers are green.

This order prevents a common failure mode: enforcing budgets using only final-answer usage while retries and fallbacks continue to incur uncounted provider cost.
