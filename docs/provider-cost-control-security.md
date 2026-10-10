# Provider/cost-control security notes

- Treat provider names, model IDs, quota balances and spend state as operator diagnostics, not consumer product data.
- Never log prompt/response bodies in routing, quota or cost-control code.
- Do not infer a provider's privacy eligibility from its reputation or billing class. Approval is explicit policy.
- A free/promotional route is still rejected when capability, privacy, health or hard quota requirements fail.
- Unknown quota remains unknown. Unknown price is not converted to zero.
- Paid-spend ceilings require durable shared aggregation before they can be relied on in a multi-instance deployment.
- Provider credentials remain server-side and are not part of router policy, quota snapshots, metrics labels or client contracts.
- Retries/fallbacks must be included in the future per-attempt ledger so hidden provider failures cannot become hidden spend.
