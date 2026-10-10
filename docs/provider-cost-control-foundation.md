# Provider and cost-control foundation

This work extends the existing DASH Intelligence Router without changing the consumer product surface.

## Current safety boundary

- Provider and model identity remain internal when provider details are hidden.
- New provider infrastructure does not enable live traffic by itself.
- Production may continue to run with `PROVIDER_MODE=fake` until a separate rollout is approved.
- Unknown provider privacy posture is conservative: private/sensitive requests require an explicit operator approval in routing policy.

## Provider quota model

The router has a normalized quota view that can represent request and token windows without assuming every provider reports the same counters. Unknown quota remains unknown rather than being treated as free or exhausted. Expired/reset windows are ignored until a fresh snapshot arrives.

Hard exhaustion removes the provider from an eligible route. Soft exhaustion keeps the provider available as a fallback but deprioritizes it so scarce free/promotional capacity can be preserved.

Supported normalized dimensions currently include:

- requests per minute
- requests per day
- tokens per minute
- tokens per day
- tokens per month
- optional promotional/prepaid USD balance

The operator-only router endpoint exposes normalized quota state and snapshots. It never exposes prompts or response content.

## Privacy routing

Provider profiles declare one of:

- `sensitive_allowed`
- `non_sensitive_only`
- `unapproved`

The default for live providers is `unapproved`. This is intentional: DASH does not infer privacy suitability from a provider brand. Before a provider receives private/sensitive traffic, the operator must review the provider's current terms, data handling and the exact deployment configuration, then explicitly approve that route.

## Commercial metadata

Provider profiles also carry internal billing classification (`demo`, `free`, `promotional`, `paid`). This metadata does not substitute for actual prices or quota state and is never a consumer-facing label.

## Still to complete before live rollout

- provider catalog / reusable compatible-provider integration for approved third-party inference APIs
- immutable per-attempt inference accounting (including retries/fallbacks/errors)
- persistent daily/monthly spend aggregation and cost circuit breakers
- plan/entitlement integration
- provider-specific quota polling/configuration
- explicit privacy approvals based on current provider terms
- controlled live smoke tests

No production deployment or provider activation is part of this document or milestone branch.
