import type { AssistantMode, ProviderId } from "@dash-ai/contracts";
import { ProviderHealth } from "./health.js";
import {
  qualityFor,
  routeKeys,
  type Capability,
  type Modality,
  type PricingClass,
  type PrivacyClass,
  type RoutePreference,
  type RouterPolicy,
  type Sensitivity,
  type TaskType,
  type Multipliers,
  type Weights,
} from "./policy.js";
import type { QuotaState, QuotaTracker } from "./quota.js";

/** One request to route. Provider-neutral: nothing here names a provider except the internal hint. */
export interface RouteRequest {
  task: TaskType;
  /** The assistant mode, when the surface has one (chat, automations). Refines the route key. */
  mode?: AssistantMode;
  /** Capabilities this particular request needs beyond its task's (e.g. tool_use when tools are offered). */
  requires?: readonly Capability[];
  /** Rough size of everything sent (system, history, documents, message), in tokens. */
  estimatedInputTokens?: number;
  /** A provider the person named in their own words: applied silently when eligible, never announced. */
  hint?: ProviderId | null;
  /** How to trade quality against speed and cost (future per-user signal; "balanced" by default). */
  preference?: RoutePreference;
  /** Providers to leave out (for example ones that already failed this request). */
  exclude?: readonly ProviderId[];
  /**
   * How sensitive the content is. Absent means "sensitive": a request is never sent to a provider
   * that is not approved for sensitive content unless DASH has classified it as standard.
   */
  sensitivity?: Sensitivity;
  /** The account's plan, for providers limited to some plans (absent: the default plan). */
  plan?: string;
  /** What the request contains (absent: text only). */
  inputModalities?: readonly Modality[];
  /** Whether paid providers may serve this request now (from the spend limits; absent: allowed). */
  paidAllowed?: boolean;
  /** Per-request ceiling on a paid provider's worst-case cost, in USD (absent: no ceiling). */
  maxCostUsd?: number | null;
  /** A paid provider's worst-case USD cost for this request, or null when its price is unknown. */
  worstCaseCostUsd?: (provider: ProviderId) => number | null;
}

export type RejectReason =
  | "not_configured"
  | "disabled"
  | "excluded"
  | "capability"
  | "context"
  | "task"
  | "plan"
  | "modality"
  /** Its privacy class does not allow this request's content. */
  | "privacy"
  /** Its pool (free or paid providers) is switched off on this server. */
  | "pricing_disabled"
  /** A spend limit stops paid inference for this request. */
  | "spend_limit"
  /** Its worst-case cost exceeds the per-request ceiling, or its price is unknown under a ceiling. */
  | "cost_limit"
  /** A quota window is exhausted. */
  | "quota"
  /** Temporarily disabled (the provider reported its quota exhausted or asked to wait). */
  | "paused";

/** Global switches the router applies to every request (see docs/provider-platform.md). */
export interface RoutingControls {
  /** AI_ENABLED: false refuses every request. */
  aiEnabled: boolean;
  /** FREE_POOL_ENABLED: free and promotional providers may serve requests. */
  freePoolEnabled: boolean;
  /** PAID_PROVIDERS_ENABLED: paid providers may serve requests. */
  paidProvidersEnabled: boolean;
  /** Demonstration adapters: never send content anywhere and cost nothing, so pool, spend, quota and privacy rules do not apply. */
  demo: ReadonlySet<ProviderId>;
}

const OPEN_CONTROLS: RoutingControls = { aiEnabled: true, freePoolEnabled: true, paidProvidersEnabled: true, demo: new Set() };

export interface ScoredCandidate {
  provider: ProviderId;
  score: number;
  circuitOpen: boolean;
  factors: { quality: number; reliability: number; latency: number; cost: number };
  pricing: PricingClass;
  privacy: PrivacyClass;
  quota: QuotaState;
  /** Free or promotional and clears the free-pool bars on this route: goes ahead of paid providers. */
  freePreferred: boolean;
}

export type RouteDecision =
  | {
      ok: true;
      /** Best first. The first serves the request; the rest are internal fallbacks. */
      providers: ProviderId[];
      candidates: ScoredCandidate[];
      rejected: Array<{ provider: ProviderId; reason: RejectReason }>;
      routeKey: string;
    }
  | {
      ok: false;
      /**
       * no_provider: nothing configured. capability_unavailable: nobody can do this yet.
       * context_too_large: too big for every model. ai_disabled: AI_ENABLED is off.
       * privacy_unavailable: no suitable provider may receive this content. limit_reached: spend
       * limits or the per-request ceiling stop every suitable provider. quota_exhausted: every
       * suitable provider is out of quota or paused.
       */
      reason:
        | "no_provider"
        | "capability_unavailable"
        | "context_too_large"
        | "ai_disabled"
        | "privacy_unavailable"
        | "limit_reached"
        | "quota_exhausted";
      rejected: Array<{ provider: ProviderId; reason: RejectReason }>;
      routeKey: string;
    };

/**
 * The DASH Intelligence Router: the one place that decides which internal AI infrastructure serves a
 * request, for every product surface (chat, automations, and future documents, research, reports,
 * editing, graphics, tools workflows and voice).
 *
 * Decisions come from configuration and observation, never from a hard-coded "provider X does task
 * Y": hard requirements (configured, enabled, capabilities, context size) filter; a weighted score of
 * quality for the route, observed reliability, observed latency and relative cost orders what is
 * left; a provider whose circuit is open (repeated failures) moves to the back but stays as a last
 * resort. Weights come from the task's policy and the request's preference. Everything a person sees
 * stays "DASH AI"; decisions are internal (logs, metrics, the operator view).
 */
export class IntelligenceRouter {
  readonly health: ProviderHealth;

  constructor(
    readonly policy: RouterPolicy,
    /** Providers configured on this server (an adapter exists), in a stable order. */
    private readonly configured: () => ReadonlySet<ProviderId>,
    now: () => number = Date.now,
    private readonly options: { quota?: QuotaTracker; controls?: () => RoutingControls } = {},
  ) {
    this.health = new ProviderHealth(
      { smoothing: policy.smoothing, failureThreshold: policy.circuit.failureThreshold, cooldownMs: policy.circuit.cooldownMs },
      now,
    );
  }

  route(request: RouteRequest): RouteDecision {
    const taskPolicy = this.policy.tasks[request.task];
    const keys = routeKeys(request.task, request.mode);
    const routeKey = keys[0]!;
    const required = new Set<Capability>([...taskPolicy.requires, ...(request.requires ?? [])]);
    const configured = this.configured();
    const controls = this.options.controls?.() ?? OPEN_CONTROLS;
    const rejected: Array<{ provider: ProviderId; reason: RejectReason }> = [];
    if (!controls.aiEnabled) return { ok: false, reason: "ai_disabled", rejected, routeKey };

    const sensitivity = request.sensitivity ?? "sensitive";
    const plan = request.plan ?? null;
    const modalities = request.inputModalities ?? ["text"];
    const order = this.providerOrder(configured);
    const eligible: ProviderId[] = [];

    for (const provider of order) {
      const profile = this.policy.providers[provider];
      const demo = controls.demo.has(provider);
      const quota = this.options.quota?.status(provider).state ?? "unknown";
      const reject = (reason: RejectReason) => rejected.push({ provider, reason });
      if (!configured.has(provider) || !profile) reject("not_configured");
      else if (!profile.enabled) reject("disabled");
      else if (request.exclude?.includes(provider)) reject("excluded");
      else if (!demo && (profile.pricing === "paid" ? !controls.paidProvidersEnabled : !controls.freePoolEnabled)) reject("pricing_disabled");
      else if ([...required].some((c) => !profile.capabilities.includes(c))) reject("capability");
      else if (profile.tasks && !profile.tasks.includes(request.task)) reject("task");
      else if (modalities.some((m) => !profile.inputModalities.includes(m))) reject("modality");
      else if ((request.estimatedInputTokens ?? 0) > profile.contextTokens) reject("context");
      else if (profile.plans && (plan === null || !profile.plans.includes(plan))) reject("plan");
      else if (!demo && !privacyAllows(profile.privacy, sensitivity)) reject("privacy");
      else if (!demo && profile.pricing === "paid" && request.paidAllowed === false) reject("spend_limit");
      else if (!demo && profile.pricing === "paid" && exceedsCeiling(request, provider)) reject("cost_limit");
      else if (!demo && quota === "paused") reject("paused");
      else if (!demo && quota === "exhausted") reject("quota");
      else eligible.push(provider);
    }

    if (eligible.length === 0) return { ok: false, reason: failureReason(rejected), rejected, routeKey };

    const weights = normalize(taskPolicy.weights, this.policy.preferences[request.preference ?? "balanced"]);
    const latencies = eligible.map((p) => this.health.latencyMs(p)).filter((l): l is number => l !== null);
    const fastest = latencies.length ? Math.min(...latencies) : null;
    const costs = eligible.map((p) => blendedCost(this.policy, p)).filter((c): c is number => c !== null);
    const cheapest = costs.length ? Math.min(...costs) : null;
    const free = this.policy.freePool;

    const candidates: ScoredCandidate[] = eligible.map((provider) => {
      const profile = this.policy.providers[provider]!;
      const latency = this.health.latencyMs(provider);
      const cost = blendedCost(this.policy, provider);
      const factors = {
        quality: qualityFor(profile, keys),
        reliability: this.health.reliability(provider),
        // Relative to the best observed, with a one-second allowance so noise between fast answers never
        // reorders routes. Unknown is neutral (1): a provider is never punished for being untried.
        latency: latency === null || fastest === null ? 1 : (fastest + LATENCY_SLACK_MS) / (latency + LATENCY_SLACK_MS),
        cost: cost === null || cheapest === null || cost <= 0 ? 1 : cheapest / cost,
      };
      const score =
        factors.quality * weights.quality +
        factors.reliability * weights.reliability +
        factors.latency * weights.latency +
        factors.cost * weights.cost;
      const circuitOpen = this.health.isOpen(provider);
      const quota = this.options.quota?.status(provider).state ?? "unknown";
      const freePreferred =
        free.preferFree &&
        profile.pricing !== "paid" &&
        !circuitOpen &&
        quota !== "soft" &&
        factors.quality >= free.minQuality &&
        factors.reliability >= free.minReliability;
      return {
        provider,
        score: Math.round(score * 10_000) / 10_000,
        circuitOpen,
        factors,
        pricing: profile.pricing,
        privacy: profile.privacy,
        quota,
        freePreferred,
      };
    });

    const hint = request.hint && eligible.includes(request.hint) ? request.hint : null;
    // A provider with an open circuit or approaching a quota limit goes to the back but stays a last resort.
    const degraded = (c: ScoredCandidate) => Number(c.circuitOpen || c.quota === "soft");
    const sorted = [...candidates].sort(
      (a, b) =>
        degraded(a) - degraded(b) ||
        Number(b.provider === hint) - Number(a.provider === hint) ||
        Number(b.freePreferred) - Number(a.freePreferred) ||
        b.score - a.score ||
        order.indexOf(a.provider) - order.indexOf(b.provider),
    );
    return { ok: true, providers: sorted.map((c) => c.provider), candidates: sorted, rejected, routeKey };
  }

  /** Every provider the policy or the registry knows, built-in ones first, in a stable order. */
  private providerOrder(configured: ReadonlySet<ProviderId>): ProviderId[] {
    return [...new Set([...Object.keys(this.policy.providers), ...configured])];
  }

  /** Report how a routed request went, so later decisions learn from it. */
  recordSuccess(provider: ProviderId, durationMs: number): void {
    this.health.recordSuccess(provider, durationMs);
  }

  recordFailure(provider: ProviderId, code: string, retryable: boolean): void {
    if (code === "cancelled") return;
    this.health.recordFailure(provider, code, retryable);
  }
}

const LATENCY_SLACK_MS = 1_000;

/** Never send sensitive content to a provider not approved for it; unapproved providers receive nothing. */
export function privacyAllows(privacy: PrivacyClass, sensitivity: Sensitivity): boolean {
  if (privacy === "approved_sensitive") return true;
  if (privacy === "non_sensitive_only") return sensitivity === "standard";
  return false;
}

function exceedsCeiling(request: RouteRequest, provider: ProviderId): boolean {
  if (request.maxCostUsd === undefined || request.maxCostUsd === null) return false;
  const worst = request.worstCaseCostUsd?.(provider) ?? null;
  // A price nobody knows cannot be bounded: under a ceiling, an unpriced paid provider is not used.
  return worst === null || worst > request.maxCostUsd;
}

/** Why nothing could serve a request, from what stopped the providers that were otherwise suitable. */
function failureReason(rejected: ReadonlyArray<{ reason: RejectReason }>): Exclude<RouteDecision, { ok: true }>["reason"] {
  const considered = rejected.filter((r) => !["not_configured", "disabled", "excluded", "pricing_disabled"].includes(r.reason));
  if (considered.length === 0) return "no_provider";
  const suitable = considered.filter((r) => ["privacy", "spend_limit", "cost_limit", "quota", "paused"].includes(r.reason));
  if (suitable.length === 0) return considered.every((r) => r.reason === "context") ? "context_too_large" : "capability_unavailable";
  if (suitable.some((r) => r.reason === "spend_limit" || r.reason === "cost_limit")) return "limit_reached";
  if (suitable.some((r) => r.reason === "quota" || r.reason === "paused")) return "quota_exhausted";
  return "privacy_unavailable";
}

function normalize(task: Weights, multiplier: Multipliers): Weights {
  const raw = {
    quality: task.quality * multiplier.quality,
    reliability: task.reliability * multiplier.reliability,
    latency: task.latency * multiplier.latency,
    cost: task.cost * multiplier.cost,
  };
  const sum = raw.quality + raw.reliability + raw.latency + raw.cost;
  if (sum <= 0) return { quality: 1, reliability: 0, latency: 0, cost: 0 };
  return { quality: raw.quality / sum, reliability: raw.reliability / sum, latency: raw.latency / sum, cost: raw.cost / sum };
}

function blendedCost(policy: RouterPolicy, provider: ProviderId): number | null {
  const p = policy.providers[provider];
  if (!p || p.costPerMillionInput === null || p.costPerMillionOutput === null) return null;
  // Typical answers read more than they write; weight input 3:1.
  return (3 * p.costPerMillionInput + p.costPerMillionOutput) / 4;
}

/** Rough token estimate for routing (about four characters per token). Never used for billing. */
export const estimateTokens = (chars: number): number => Math.ceil(chars / 4);
