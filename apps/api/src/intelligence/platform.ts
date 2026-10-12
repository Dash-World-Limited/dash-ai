import type { ProviderId } from "@dash-ai/contracts";
import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "../config.js";
import type { Metrics } from "../observability/metrics.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { Store } from "../store/store.js";
import { estimateCostUsd, priceFor } from "./cost.js";
import { AttemptRecorder, estimateTokensForLedger } from "./ledger.js";
import type { Sensitivity } from "./policy.js";
import { QuotaTracker, type QuotaWindow } from "./quota.js";
import type { IntelligenceRouter, RouteDecision, RouteRequest, RoutingControls } from "./router.js";
import { dayStart, monthStart, SpendGuard, type SpendStatus } from "./spend.js";

/** Why a request could not be served, in terms the consumer surface turns into a neutral message. */
export type Refusal =
  | { kind: "unavailable" }
  | { kind: "busy" }
  | { kind: "user_limit" }
  | { kind: "too_large" }
  | { kind: "context_too_large" };

/**
 * DASH AI's provider and cost-control plane: the global switches, quotas, the spend circuit breaker
 * and the inference ledger, shared by every surface (chat and Automates today). The DASH Intelligence
 * Router stays the one place that orders providers; this supplies what it needs to know.
 */
export class AiPlatform {
  readonly quota: QuotaTracker;
  readonly spend: SpendGuard;
  readonly attempts: AttemptRecorder;

  constructor(
    private readonly deps: { config: AppConfig; store: Store; providers: ProviderRegistry; log: FastifyBaseLogger; metrics?: Metrics; now?: () => number },
  ) {
    const now = deps.now ?? Date.now;
    this.quota = new QuotaTracker(deps.config.providerQuotas, now);
    this.spend = new SpendGuard(deps.store, deps.config.ai, now);
    this.attempts = new AttemptRecorder({
      store: deps.store,
      quota: this.quota,
      prices: deps.config.modelPrices,
      policy: deps.config.routerPolicy,
      spend: this.spend,
      metrics: deps.metrics,
      log: deps.log,
      now,
    });
  }

  /** The global switches for the router. Demonstration adapters are exempt from pools, spend, quota and privacy. */
  controls(): RoutingControls {
    const ai = this.deps.config.ai;
    return { aiEnabled: ai.enabled, freePoolEnabled: ai.freePoolEnabled, paidProvidersEnabled: ai.paidProvidersEnabled, demo: this.deps.providers.demoIds() };
  }

  get plan(): string {
    return this.deps.config.ai.defaultPlan;
  }

  /**
   * How sensitive a request is. Everything is sensitive unless AI_DEFAULT_SENSITIVITY=standard, and
   * even then a request with attached documents or enabled tools (private files, connected accounts)
   * stays sensitive.
   */
  classify(input: { documents: number; toolsOffered: boolean }): Sensitivity {
    if (input.documents > 0 || input.toolsOffered) return "sensitive";
    return this.deps.config.ai.defaultSensitivity;
  }

  /** Spend state for this account now (paid providers allowed or not). */
  async admit(userId: string | null): Promise<SpendStatus> {
    const status = await this.spend.check({ userId, plan: this.plan });
    if (status.blockedBy) this.deps.metrics?.spendBlocked.inc({ scope: status.blockedBy });
    return status;
  }

  /**
   * The cost fields of a route request: whether paid providers may serve it, and a per-request
   * ceiling on a paid provider's worst case (the dearest model it may use, the conservative input
   * estimate and the full output allowance).
   */
  costFields(spend: SpendStatus, inputChars: number): Pick<RouteRequest, "paidAllowed" | "maxCostUsd" | "worstCaseCostUsd"> {
    const { config, providers } = this.deps;
    const inputTokens = estimateTokensForLedger(inputChars);
    const worstCaseCostUsd = (provider: ProviderId): number | null => {
      const costs = providers
        .modelsFor(provider)
        .map((model) =>
          estimateCostUsd(config.modelPrices, { provider, model, demo: false, usage: { inputTokens, outputTokens: config.maxOutputTokens } }),
        );
      if (costs.length === 0 || costs.some((c) => c === null)) return null;
      return Math.max(...(costs as number[]));
    };
    return { paidAllowed: spend.paidAllowed, maxCostUsd: config.ai.limits.requestUsd, worstCaseCostUsd };
  }

  /** A failed route decision → what the person is told (always DASH AI's own words). */
  refusal(decision: Extract<RouteDecision, { ok: false }>, spend: SpendStatus | null): Refusal {
    switch (decision.reason) {
      case "context_too_large":
        return { kind: "context_too_large" };
      case "quota_exhausted":
        return { kind: "busy" };
      case "limit_reached": {
        const scope = spend?.blockedBy;
        if (scope === "user_daily" || scope === "plan_daily") return { kind: "user_limit" };
        if (!scope && decision.rejected.some((r) => r.reason === "cost_limit")) return { kind: "too_large" };
        return { kind: "unavailable" };
      }
      default:
        return { kind: "unavailable" };
    }
  }

  /**
   * OPERATOR VIEW: every provider this server knows, with its metadata (capabilities, suitability,
   * modalities, privacy, pricing, prices), live state (quota, health, circuit) and the spend against
   * the limits. Never part of a consumer response.
   */
  async catalog(router: IntelligenceRouter) {
    const { config, providers } = this.deps;
    const health = new Map(router.health.snapshot(providers.ids()).map((h) => [h.provider, h]));
    const status = new Map(providers.status().map((p) => [p.id, p]));
    const demo = providers.demoIds();
    const spend = await this.spend.check({ userId: null, plan: this.plan });
    return {
      controls: {
        aiEnabled: config.ai.enabled,
        freePoolEnabled: config.ai.freePoolEnabled,
        paidProvidersEnabled: config.ai.paidProvidersEnabled,
        bedrockFallbackEnabled: config.ai.bedrockFallbackEnabled,
        defaultPlan: config.ai.defaultPlan,
        defaultSensitivity: config.ai.defaultSensitivity,
      },
      spend: { limits: config.ai.limits, today: { systemUsd: spend.totals.systemDailyUsd }, month: { systemUsd: spend.totals.systemMonthlyUsd }, paidAllowed: spend.paidAllowed, blockedBy: spend.blockedBy },
      providers: providers.ids().map((id) => {
        const profile = config.routerPolicy.providers[id];
        const models = providers.modelsFor(id);
        const h = health.get(id);
        return {
          provider: id,
          configured: status.get(id)?.configured ?? false,
          mode: status.get(id)?.mode ?? "unconfigured",
          model: status.get(id)?.model ?? null,
          models,
          enabled: profile?.enabled ?? false,
          capabilities: profile?.capabilities ?? [],
          toolUse: profile?.capabilities.includes("tool_use") ?? false,
          tasks: profile?.tasks ?? null,
          plans: profile?.plans ?? null,
          inputModalities: profile?.inputModalities ?? [],
          outputModalities: profile?.outputModalities ?? [],
          streaming: profile?.streaming ?? false,
          contextTokens: profile?.contextTokens ?? null,
          privacy: demo.has(id) ? "demo" : (profile?.privacy ?? "unapproved"),
          sensitiveAllowed: demo.has(id) || profile?.privacy === "approved_sensitive",
          pricing: demo.has(id) ? "demo" : (profile?.pricing ?? "paid"),
          pricesUsdPerMillion: Object.fromEntries(models.map((m) => [m, priceFor(config.modelPrices, id, m) ?? null])),
          quota: this.quota.status(id),
          health: h ? { reliability: h.reliability, latencyMs: h.latencyMs, consecutiveFailures: h.consecutiveFailures, circuitOpenUntil: h.circuitOpenUntil } : null,
          circuitOpen: router.health.isOpen(id),
        };
      }),
    };
  }

  /** Start-up: seed quota counters from the ledger so limits survive restarts. */
  async seedQuotas(): Promise<void> {
    const { config, store, log } = this.deps;
    const now = (this.deps.now ?? Date.now)();
    for (const [provider, quota] of Object.entries(config.providerQuotas)) {
      try {
        const [day, month, all] = await Promise.all([
          store.sumInferenceSpend({ since: dayStart(now), provider }),
          store.sumInferenceSpend({ since: monthStart(now), provider }),
          quota.windows.some((w) => w.type === "promotional_balance")
            ? store.sumInferenceSpend({ since: new Date(0).toISOString(), provider })
            : Promise.resolve({ attempts: 0, costUsd: 0, tokens: 0 }),
        ]);
        this.quota.seed(provider, (w: QuotaWindow) => {
          switch (w.type) {
            case "requests_per_day":
              return day.attempts;
            case "tokens_per_day":
              return day.tokens;
            case "tokens_per_month":
              return month.tokens;
            case "promotional_balance":
              return w.unit === "usd" ? all.costUsd : all.tokens;
            default:
              return 0;
          }
        });
      } catch (err) {
        log.warn({ err, provider }, "could not seed quota usage from the ledger");
      }
    }
  }
}
