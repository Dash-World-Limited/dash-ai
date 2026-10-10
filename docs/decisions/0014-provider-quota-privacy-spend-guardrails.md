# ADR 0014: Provider quota, privacy and spend guardrails

## Status

Proposed on the provider/cost-control milestone branch. No production activation is implied.

## Context

DASH AI can already route across multiple internal providers and now has a Bedrock adapter with per-answer cost estimation. A production free/paid routing layer also needs to know when a route is unavailable because of quota, whether a provider is eligible for sensitive content, and whether spending should be stopped before a configured ceiling is crossed.

Provider APIs do not expose quota in one universal shape, and "free" does not imply an acceptable privacy posture. Likewise, estimated provider cost is useful for preflight controls but provider-reported usage remains the accounting source of truth after an attempt completes.

## Decision

1. Normalize quota into optional request/token windows plus optional promotional balance. Unknown quota stays unknown.
2. Hard quota exhaustion removes a provider from routing. Soft exhaustion only deprioritizes it, preserving it as a fallback.
3. Privacy eligibility is explicit operator policy. New/live provider profiles default to `unapproved`; private or sensitive requests require `sensitive_allowed`.
4. Billing class (`demo`, `free`, `promotional`, `paid`) is routing metadata only. It never replaces price or quota data.
5. Spend-circuit decisions are a pure primitive over configured limits, current persisted spend and a preflight request estimate. Durable aggregation will be implemented in the store so multiple API instances share one source of truth.
6. Unknown cost is never silently converted to zero. The integration layer must choose an explicit fail-open/fail-closed rule according to route billing class and configured ceilings.
7. Provider/model/quota/cost details remain operator-only when provider details are hidden.

## Consequences

- A newly added free API cannot receive sensitive user data until its terms and deployment have been reviewed and approved.
- Provider-specific quota pollers can be added without changing the router's normalized model.
- Persistent spend aggregation and per-attempt accounting remain required before the spend breaker is allowed to control live paid traffic.
- Production remains on its existing provider mode until a separate rollout and smoke test are approved.
