# DASH Intelligence Router

USER → DASH AI → **DASH Intelligence Router** → internal provider(s) → quality/normalization → DASH AI result.

The router is the one place that decides which internal AI infrastructure serves a request. Every
server-side AI surface goes through it: Chat and DASH Automates today; Documents, Research, Reports,
Editing, Graphics, Tools workflows, Voice and future workflows declare their task type now so they
route the same way when they arrive. People only ever see DASH AI ([provider-neutrality.md](provider-neutrality.md)).

Code: `apps/api/src/intelligence/` (`policy.ts`, `router.ts`, `health.ts`, `generate.ts`). Provider
registration, privacy classes, quotas, the inference ledger and spend limits are described in
[provider-platform.md](provider-platform.md).

## How a decision is made

A request names a **task** (`chat`, `documents`, `research`, `graphics`, `reports`, `editing`, `tools`,
`automation`, `voice`, `workflow`), optionally a **mode**, extra **required capabilities**, an
**estimated input size**, a silent **hint** (a provider the person named in their own words) and a
**preference** (`balanced`, `quality`, `speed`, `economy`; a future per-user signal).

1. **Filter** (hard requirements). A provider is eligible only if it is configured on this server,
   enabled in the policy, not excluded, its pool is switched on (`FREE_POOL_ENABLED`,
   `PAID_PROVIDERS_ENABLED`), it has every capability the task and request need, it is suitable for
   the task, the input modalities and the account's plan, its context window fits the estimated input,
   its **privacy class** allows the request's sensitivity, no **spend limit** or **per-request cost
   ceiling** excludes it (paid providers), and it is neither **paused** nor out of **quota**. Nothing
   eligible → a clear refusal: `ai_disabled`, `no_provider`, `capability_unavailable` (for example
   Graphics and Voice today: no configured provider has image generation or speech, so the router
   refuses instead of faking it), `context_too_large`, `privacy_unavailable`, `limit_reached` or
   `quota_exhausted`.
2. **Score** (soft signals), weighted per task and multiplied by the preference:
   - *quality* for the route key, most specific first: `chat:writing` → `chat` → `default`
     (automations fall back to their mode's chat route);
   - *reliability*: smoothed success rate observed on this instance;
   - *latency*: smoothed duration relative to the fastest observed (with a one-second allowance so
     noise never reorders routes; untried is neutral);
   - *cost*: relative blended price when the operator configures prices (unknown is neutral).
3. **Order.** Providers whose circuit is open (repeated retryable failures) or whose quota is above
   its soft threshold go to the back but stay as a last resort; then the hint; then a free or
   promotional provider that passed every filter and meets the free-pool quality and reliability bar
   (`freePool` in the policy); then the score. The first serves the request; the rest are
   internal fallbacks used only when the first fails **before any output or tool run** (ADR 0012),
   with a retryable failure, a provider-reported exhausted quota, or by refusing this server's
   configuration (credentials rejected, HTTP 401/403; configured model not found, 404). A request the provider rejects as invalid, too long or
   against its policies (400/413/422) is not sent to another provider.
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
{"freePool": {"preferFree": true, "minQuality": 0.75, "minReliability": 0.9}}
{"providers": {"example-free": {"privacy": "non_sensitive_only"}}}
```

Adding a capability to a provider (for example `image_generation` once an image adapter exists) is
what makes a task like Graphics routable; no router code changes.

A provider override changes only the fields it names: an override that sets Bedrock's quality keeps
Bedrock's default prices.

## Amazon Bedrock (Amazon Nova)

Bedrock is one more provider behind the same router ([ADR 0013](decisions/0013-amazon-bedrock-and-cost-ledger.md)).
It serves requests only with `BEDROCK_FALLBACK_ENABLED=true` ([provider-platform.md](provider-platform.md)).
Its default profile: capabilities `text`, `long_context`, `tool_use`; a context the router may rely on of
128k tokens (the smallest Nova tier); quality 0.8 on every route (below the OpenAI/Anthropic starting
values, so with them configured Bedrock is an internal fallback until an operator raises it, for
example `{"providers": {"bedrock": {"quality": {"chat:general": 0.95, "automation": 0.95}}}}`); relative
prices 0.33 / 2.75 per million tokens for scoring. With Bedrock as the only live provider it serves
everything it is capable of.

The router chooses the **provider**; the Bedrock adapter then chooses the **Nova tier** among those the
operator configured, from internal routing hints (task, mode, preference, estimated input):

| Tier | Used for | Context / max output sent |
| --- | --- | --- |
| Nova Micro | economy preference; background Automates (unless quality is preferred or the input is large) | 128k / 5,000 |
| Nova Lite | everything else (the default) | 300k / 5,000 |
| Nova 2 Lite | quality preference; Documents, Research and Reports work; requests that offer tools; input over 100k tokens | 1M / 64,000 (capped by `MAX_OUTPUT_TOKENS`) |

A tier that is not configured, or too small for the input, falls through to the next configured one.
The output ceilings are conservative on purpose: asking for more than a model allows is a request
error, while a lower ceiling only ends a long answer with finish reason `length` (Continue). Each
answer records the tier that served it, and usage records carry an estimated USD cost
([environment.md](environment.md), `MODEL_PRICES`).

## Observability (internal only)

- `GET /v1/router` with `Authorization: Bearer $OPERATOR_TOKEN` (404 for everyone else): the active
  policy, per-provider health (reliability, latency, circuit, counts, last failure code), the route
  each task would take right now, and `platform`: the global switches, spend against the limits, and
  every provider's metadata, prices, quota state and circuit.
- Metrics: `dash_router_decisions_total{task,provider}`, `dash_router_unavailable_total{task,reason}`,
  plus the existing provider failure, retry and fallback counters.
- Debug log `routing decision` with the scored candidates and rejections (no content).

## Known limits

- Health is per API instance (advisory, so instances briefly disagreeing is harmless). A shared view
  can come from metrics later.
- Latency is whole-answer duration, not time to first token, so long answers look slower.
- Quality is a configured starting judgement; measured quality (ratings, regenerations) is future work.
