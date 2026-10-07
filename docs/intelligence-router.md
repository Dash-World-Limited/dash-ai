# DASH Intelligence Router

USER → DASH AI → **DASH Intelligence Router** → internal provider(s) → quality/normalization → DASH AI result.

The router is the one place that decides which internal AI infrastructure serves a request. Every
server-side AI surface goes through it: Chat and DASH Automates today; Documents, Research, Reports,
Editing, Graphics, Tools workflows, Voice and future workflows declare their task type now so they
route the same way when they arrive. People only ever see DASH AI ([provider-neutrality.md](provider-neutrality.md)).

Code: `apps/api/src/intelligence/` (`policy.ts`, `router.ts`, `health.ts`, `generate.ts`).

## How a decision is made

A request names a **task** (`chat`, `documents`, `research`, `graphics`, `reports`, `editing`, `tools`,
`automation`, `voice`, `workflow`), optionally a **mode**, extra **required capabilities**, an
**estimated input size**, a silent **hint** (a provider the person named in their own words) and a
**preference** (`balanced`, `quality`, `speed`, `economy`; a future per-user signal).

1. **Filter** (hard requirements). A provider is eligible only if it is configured on this server,
   enabled in the policy, not excluded, has every capability the task and request need, and its context
   window fits the estimated input. Nothing eligible → a clear refusal: `no_provider`,
   `capability_unavailable` (for example Graphics and Voice today: no configured provider has image
   generation or speech, so the router refuses instead of faking it) or `context_too_large`.
2. **Score** (soft signals), weighted per task and multiplied by the preference:
   - *quality* for the route key, most specific first: `chat:writing` → `chat` → `default`
     (automations fall back to their mode's chat route);
   - *reliability*: smoothed success rate observed on this instance;
   - *latency*: smoothed duration relative to the fastest observed (with a one-second allowance so
     noise never reorders routes; untried is neutral);
   - *cost*: relative blended price when the operator configures prices (unknown is neutral).
3. **Order.** Providers whose circuit is open (repeated retryable failures) go to the back but stay
   as a last resort; then the hint; then the score. The first serves the request; the rest are
   internal fallbacks used only when the first fails **before any output or tool run** (ADR 0012).
4. **Learn.** Every routed request reports success (with duration) or failure (with its normalized
   code) back to the router. Cancellations are ignored; non-retryable failures lower reliability but
   never open the circuit.

No rule says "provider X always does task Y". The default policy's starting quality reproduces the
shared chat preference table (`SMART_ROUTING`, also used by Android Demo Mode), so with healthy
providers chat routes exactly as before; health, latency, cost and the operator's policy can change it.

## Configuration

`ROUTER_POLICY` (JSON, optional) is merged over the defaults per provider and per task. Invalid JSON or
values stop start-up with a message naming the path (never the value). Examples:

```json
{"circuit": {"failureThreshold": 5, "cooldownMs": 120000}}
{"providers": {"openai": {"enabled": false}}}
{"providers": {"anthropic": {"quality": {"chat:research": 0.92}}}}
{"providers": {"openai": {"costPerMillionInput": 2.5, "costPerMillionOutput": 10}, "anthropic": {"costPerMillionInput": 3, "costPerMillionOutput": 15}}}
{"tasks": {"automation": {"weights": {"quality": 0.5, "reliability": 0.3, "latency": 0, "cost": 0.2}}}}
```

Adding a capability to a provider (for example `image_generation` once an image adapter exists) is
what makes a task like Graphics routable; no router code changes.

## Observability (internal only)

- `GET /v1/router` with `Authorization: Bearer $OPERATOR_TOKEN` (404 for everyone else): the active
  policy, per-provider health (reliability, latency, circuit, counts, last failure code) and the route
  each task would take right now.
- Metrics: `dash_router_decisions_total{task,provider}`, `dash_router_unavailable_total{task,reason}`,
  plus the existing provider failure, retry and fallback counters.
- Debug log `routing decision` with the scored candidates and rejections (no content).

## Known limits

- Health is per API instance (advisory, so instances briefly disagreeing is harmless). A shared view
  can come from metrics later.
- Latency is whole-answer duration, not time to first token, so long answers look slower.
- Quality is a configured starting judgement; measured quality (ratings, regenerations) is future work.
