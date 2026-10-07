import { ProviderId, type AssistantMode } from "@dash-ai/contracts";
import { ProviderHealth } from "./health.js";
import {
  qualityFor,
  routeKeys,
  type Capability,
  type RoutePreference,
  type RouterPolicy,
  type TaskType,
  type Multipliers,
  type Weights,
} from "./policy.js";

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
}

export type RejectReason = "not_configured" | "disabled" | "capability" | "context" | "excluded";

export interface ScoredCandidate {
  provider: ProviderId;
  score: number;
  circuitOpen: boolean;
  factors: { quality: number; reliability: number; latency: number; cost: number };
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
      /** no_provider: nothing configured. capability_unavailable: nobody can do this yet. context_too_large: too big for every model. */
      reason: "no_provider" | "capability_unavailable" | "context_too_large";
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
    const rejected: Array<{ provider: ProviderId; reason: RejectReason }> = [];
    const eligible: ProviderId[] = [];

    for (const provider of ProviderId.options) {
      const profile = this.policy.providers[provider];
      if (!configured.has(provider) || !profile) rejected.push({ provider, reason: "not_configured" });
      else if (!profile.enabled) rejected.push({ provider, reason: "disabled" });
      else if (request.exclude?.includes(provider)) rejected.push({ provider, reason: "excluded" });
      else if ([...required].some((c) => !profile.capabilities.includes(c))) rejected.push({ provider, reason: "capability" });
      else if ((request.estimatedInputTokens ?? 0) > profile.contextTokens) rejected.push({ provider, reason: "context" });
      else eligible.push(provider);
    }

    if (eligible.length === 0) {
      const considered = rejected.filter((r) => r.reason !== "not_configured" && r.reason !== "disabled" && r.reason !== "excluded");
      const reason =
        considered.length === 0
          ? "no_provider"
          : considered.every((r) => r.reason === "context")
            ? "context_too_large"
            : "capability_unavailable";
      return { ok: false, reason, rejected, routeKey };
    }

    const weights = normalize(taskPolicy.weights, this.policy.preferences[request.preference ?? "balanced"]);
    const latencies = eligible.map((p) => this.health.latencyMs(p)).filter((l): l is number => l !== null);
    const fastest = latencies.length ? Math.min(...latencies) : null;
    const costs = eligible.map((p) => blendedCost(this.policy, p)).filter((c): c is number => c !== null);
    const cheapest = costs.length ? Math.min(...costs) : null;

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
      return { provider, score: Math.round(score * 10_000) / 10_000, circuitOpen: this.health.isOpen(provider), factors };
    });

    const hint = request.hint && eligible.includes(request.hint) ? request.hint : null;
    const order = [...candidates].sort(
      (a, b) =>
        Number(a.circuitOpen) - Number(b.circuitOpen) ||
        Number(b.provider === hint) - Number(a.provider === hint) ||
        b.score - a.score ||
        ProviderId.options.indexOf(a.provider) - ProviderId.options.indexOf(b.provider),
    );
    return { ok: true, providers: order.map((c) => c.provider), candidates: order, rejected, routeKey };
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
