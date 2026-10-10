# Provider rollout checklist

This checklist is intentionally separate from implementation. Completing the provider/cost-control code does not authorize live production traffic.

Before enabling any new live provider:

- CI is green on the exact commit being considered.
- Provider credentials are stored server-side only and are not present in mobile/web bundles or repository history.
- The provider's current privacy/data-use terms have been reviewed for the intended traffic class.
- Router policy explicitly records the approved privacy class; unknown remains `unapproved`.
- Model IDs, region and prices are verified from the provider's current official documentation.
- Quota/rate-limit behavior is known or left `unknown`; DASH does not invent a free allowance.
- Provider-side spend/budget alerts are configured where available.
- DASH persistent spend aggregation and circuit breakers are enabled before meaningful paid traffic.
- Operator diagnostics show healthy routing, quota state and no provider/model leakage to consumers.
- A controlled smoke test is explicitly approved and uses a tiny bounded request.
- Production rollout starts with one controlled provider/route and a rollback path to the previous provider mode.

Until these checks are complete, production remains on its existing safe configuration.
