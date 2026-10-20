import type { ProviderId } from "@dash-ai/contracts";
import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "../config.js";
import type { Metrics } from "../observability/metrics.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { newId } from "../security/crypto.js";
import type { SpendReservationRecord, Store } from "../store/store.js";
import { priceFor } from "./cost.js";
import { AttemptRecorder, estimateTokensForLedger } from "./ledger.js";
import type { Sensitivity } from "./policy.js";
import { QuotaTracker, type QuotaWindow } from "./quota.js";
import type { IntelligenceRouter, RouteDecision, RouteRequest, RoutingControls } from "./router.js";
import { dayStart, monthStart, SpendGuard, spendStatusFrom, type SpendScope, type SpendStatus } from "./spend.js";
import { roundGrowthTokens, roundInputBudgets, worstCaseUsd, type ToolLoop } from "./worstCase.js";

/** Why a request could not be served, in terms the consumer surface turns into a neutral message. */
export type Refusal =
  | { kind: "unavailable" }
  | { kind: "busy" }
  | { kind: "user_limit" }
  | { kind: "too_large" }
  | { kind: "context_too_large" };

/** The route fields costFields() supplies. */
export type RouteCostFields = Pick<RouteRequest, "paidAllowed" | "paidHeadroomUsd" | "maxCostUsd" | "worstCaseCostUsd">;

/** A request admitted (or not) for routing: the decision, the spend state it used, and its hold if any. */
export interface Admission {
  decision: RouteDecision;
  spend: SpendStatus;
  /** The in-flight hold on the paid route's worst case; null when no aggregate limit or no paid provider applies. */
  reservation: SpendReservationRecord | null;
}

/**
 * The spend admission could not be checked (database unavailable, a scope's lock busy for too long).
 * Paid work is refused rather than admitted unchecked; surfaces tell the person DASH AI is busy.
 */
export class SpendAdmissionError extends Error {
  constructor() {
    super("spend admission unavailable");
    this.name = "SpendAdmissionError";
  }
}

/**
 * Added to a request's enforced execution bound to give its reservation's lease: covers the moments
 * between admission and the bound's start, and writing the last ledger row after it.
 */
export const RESERVATION_GRACE_MS = 120_000;
/** Reservation attempts per request: the first on the cached estimate, then on the database's fresh numbers. */
const RESERVE_ATTEMPTS = 3;
const SETTLE_ATTEMPTS = 3;
/** Housekeeping at most this often per instance; finished holds are kept this long (diagnostics). */
const SWEEP_EVERY_MS = 60_000;
const SWEEP_BATCH = 500;
export const RESERVATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

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

  /** Spend state for this account now (paid providers allowed or not, and the allowance left). */
  async admit(userId: string | null): Promise<SpendStatus> {
    return this.spend.check({ userId, plan: this.plan });
  }

  /**
   * Spend admission (ADR 0015): route on the quick spend estimate, then atomically hold the worst case
   * of the paid providers in the route against every aggregate limit, counting actual spend and every
   * other request still in flight. If another request took the room meanwhile, route again on the
   * database's fresh numbers (a free provider may still serve), at most RESERVE_ATTEMPTS times; then
   * refuse as a spend limit. Throws SpendAdmissionError when the hold cannot be checked (fails closed).
   *
   * The hold is the dearest worst case among the paid providers in the route, so falling back inside
   * the route stays covered. The caller must settle() it when the request ends, whatever the outcome.
   */
  async admitAndReserve(req: {
    userId: string | null;
    /** The request's ledger id (InferenceContext.inferenceId): every attempt of it charges this hold. */
    inferenceId: string;
    task: string;
    /** The request's enforced execution bound; the hold lives this long plus RESERVATION_GRACE_MS. */
    maxDurationMs: number;
    inputChars: number;
    loop: ToolLoop | null;
    route: (fields: RouteCostFields) => RouteDecision;
  }): Promise<Admission> {
    const log = this.deps.log;
    const metrics = this.deps.metrics;
    let spend = await this.admit(req.userId);
    for (let attempt = 1; ; attempt++) {
      const fields = this.costFields(spend, req.inputChars, req.loop);
      const decision = req.route(fields);
      if (!decision.ok) return { decision, spend, reservation: null };
      const paid = decision.providers.filter((p) => this.isPaid(p));
      if (paid.length === 0 || this.spend.limits({ userId: req.userId, plan: this.plan }).length === 0) return { decision, spend, reservation: null };
      // Under a limit the router only keeps priced paid providers whose worst case fits; an unpriced one
      // here would be unbounded, so it is never admitted (fails closed).
      const worst = paid.map((p) => fields.worstCaseCostUsd?.(p) ?? null);
      if (worst.some((w) => w === null)) {
        return { decision: { ok: false, reason: "limit_reached", rejected: paid.map((provider) => ({ provider, reason: "spend_limit" as const })), routeKey: decision.routeKey }, spend, reservation: null };
      }
      const amountUsd = Math.max(...(worst as number[]));
      const primary = paid[0]!;
      let result;
      try {
        result = await this.spend.reserve({
          id: newId(),
          inferenceId: req.inferenceId,
          userId: req.userId,
          plan: this.plan,
          task: req.task,
          provider: primary,
          model: this.deps.providers.get(primary)?.model ?? null,
          amountUsd,
          leaseMs: req.maxDurationMs + RESERVATION_GRACE_MS,
        });
      } catch (err) {
        metrics?.spendReservations.inc({ outcome: "error" });
        metrics?.spendReservationFailures.inc({ stage: "reserve" });
        log.warn({ err, task: req.task, inferenceId: req.inferenceId }, "spend reservation could not be checked; paid request refused");
        throw new SpendAdmissionError();
      }
      if (result.ok) {
        metrics?.spendReservations.inc({ outcome: "admitted" });
        log.debug({ reservation: result.reservation.id, inferenceId: req.inferenceId, reservedUsd: result.reservation.reservedUsd, provider: primary }, "spend reserved");
        this.maybeSweep();
        return { decision, spend: spendStatusFrom(result.usage, spend.totals), reservation: result.reservation };
      }
      metrics?.spendReservations.inc({ outcome: "denied" });
      log.info({ task: req.task, inferenceId: req.inferenceId, blockedBy: result.blockedBy, amountUsd, attempt, usage: result.usage }, "spend reservation denied");
      spend = spendStatusFrom(result.usage, spend.totals);
      if (attempt >= RESERVE_ATTEMPTS) {
        spend = { ...spend, blockedBy: spend.blockedBy ?? result.blockedBy };
        return { decision: { ok: false, reason: "limit_reached", rejected: paid.map((provider) => ({ provider, reason: "spend_limit" as const })), routeKey: decision.routeKey }, spend, reservation: null };
      }
    }
  }

  /**
   * Ends a request's hold once its last ledger row is written: its paid ledger cost becomes the hold's
   * actual and the rest is released. Retried on failure; if it still fails the hold stays until its
   * lease runs out (over-protects, never under-counts). Never throws. An actual above the hold is an
   * invariant violation: logged at error level and counted, never hidden.
   */
  async settle(reservation: SpendReservationRecord | null | undefined): Promise<void> {
    if (!reservation) return;
    const { log, metrics, store } = this.deps;
    for (let attempt = 1; ; attempt++) {
      try {
        const result = await store.settleSpendReservation(reservation.id);
        this.spend.invalidate();
        if (!result || result.alreadyFinished) return;
        const r = result.reservation;
        metrics?.spendReservationSettlements.inc({ status: r.status });
        const actual = r.actualUsd ?? 0;
        if (actual - r.reservedUsd > 1e-9) {
          metrics?.spendReservationOverage.inc();
          metrics?.spendReservationOverageUsd.inc({}, actual - r.reservedUsd);
          log.error({ reservation: r.id, inferenceId: r.inferenceId, task: r.task, provider: r.provider, reservedUsd: r.reservedUsd, actualUsd: actual }, "spend reservation invariant violated: actual cost exceeded the reservation");
        } else if (r.status === "expired") {
          log.warn({ reservation: r.id, inferenceId: r.inferenceId, task: r.task }, "spend reservation settled after its lease expired");
        } else {
          log.debug({ reservation: r.id, status: r.status, reservedUsd: r.reservedUsd, actualUsd: actual }, "spend reservation settled");
        }
        this.maybeSweep();
        return;
      } catch (err) {
        if (attempt >= SETTLE_ATTEMPTS) {
          metrics?.spendReservationFailures.inc({ stage: "settle" });
          log.warn({ err, reservation: reservation.id, inferenceId: reservation.inferenceId }, "spend reservation could not be settled; it is held until its lease expires");
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 50 * 4 ** (attempt - 1)));
      }
    }
  }

  private lastSweep = Number.NEGATIVE_INFINITY;
  private sweeping = false;

  /** Lazy housekeeping (never on the admission's critical path; correctness never depends on it). */
  private maybeSweep(): void {
    const now = (this.deps.now ?? Date.now)();
    if (this.sweeping || now - this.lastSweep < SWEEP_EVERY_MS) return;
    this.lastSweep = now;
    this.sweeping = true;
    this.sweep()
      .catch(() => undefined)
      .finally(() => {
        this.sweeping = false;
      });
  }

  /** Marks lapsed holds expired and deletes old finished ones (idempotent; safe on every instance). */
  async sweep(): Promise<{ expired: number; purged: number }> {
    const { log, metrics, store } = this.deps;
    try {
      const result = await store.sweepSpendReservations(SWEEP_BATCH, RESERVATION_RETENTION_MS);
      if (result.expired > 0) {
        metrics?.spendReservationsExpired.inc({}, result.expired);
        log.info({ expired: result.expired }, "lapsed spend reservations expired");
      }
      return result;
    } catch (err) {
      metrics?.spendReservationFailures.inc({ stage: "sweep" });
      log.warn({ err }, "spend reservation housekeeping failed");
      throw err;
    }
  }

  /** The limit that kept paid providers out of this route: one already reached, or the one with too little left. */
  private limitingScope(decision: RouteDecision, spend: SpendStatus | null): SpendScope | null {
    if (!decision.rejected.some((r) => r.reason === "spend_limit")) return null;
    return spend?.blockedBy ?? spend?.headroom?.scope ?? null;
  }

  /** Counts a routed request for which a spend limit kept at least one paid provider out. */
  noteSpendLimit(decision: RouteDecision, spend: SpendStatus): void {
    const scope = this.limitingScope(decision, spend);
    if (scope) this.deps.metrics?.spendBlocked.inc({ scope });
  }

  /**
   * The most output tokens one provider request to `model` can be billed for: MAX_OUTPUT_TOKENS, or
   * the adapter's lower cap where it knows the model's real limit (for example Amazon Nova's).
   */
  outputTokenCap(provider: ProviderId, model: string): number {
    const cap = this.deps.providers.get(provider)?.outputTokenCap?.(model);
    return cap !== undefined && cap > 0 ? Math.min(this.deps.config.maxOutputTokens, cap) : this.deps.config.maxOutputTokens;
  }

  /**
   * Estimated input tokens each provider request of one answer on `provider` may send (see
   * worstCase.ts): the first request, then each tool round's growth, capped at the provider's context
   * window. Spend admission prices these, and the orchestrator holds the answer's requests to them.
   */
  inputBudgets(provider: ProviderId, firstInputTokens: number, loop: ToolLoop | null): number[] {
    const { config, providers } = this.deps;
    const caps = providers.modelsFor(provider).map((m) => this.outputTokenCap(provider, m));
    const outputCap = caps.length > 0 ? Math.max(...caps) : config.maxOutputTokens;
    return roundInputBudgets(firstInputTokens, {
      rounds: loop ? loop.toolRounds + 1 : 1,
      growthTokens: loop ? roundGrowthTokens(outputCap, loop) : 0,
      contextTokens: config.routerPolicy.providers[provider]?.contextTokens ?? Number.POSITIVE_INFINITY,
    });
  }

  /** Whether paid providers are admitted on their worst case: a spend limit or a per-request ceiling applies. */
  costBounded(spend: SpendStatus): boolean {
    return spend.headroom !== null || this.deps.config.ai.limits.requestUsd !== null;
  }

  /** Whether a provider's requests count against spend limits (paid and not a demonstration adapter). */
  isPaid(provider: ProviderId): boolean {
    const { config, providers } = this.deps;
    if (providers.get(provider)?.demo) return false;
    return (config.routerPolicy.providers[provider]?.pricing ?? "paid") === "paid";
  }

  /**
   * The cost fields of a route request: whether paid providers may serve it, the spend allowance left,
   * and a per-request ceiling, all compared with a paid provider's worst case: for the dearest model
   * it may use, every provider request the answer may make (each tool round and the final answer) at
   * its input budget, each with the model's full output cap.
   */
  costFields(
    spend: SpendStatus,
    /** Everything the first provider request sends, in characters (system prompt and tool schemas included). */
    inputChars: number,
    /** The tool loop when the request offers tools (null: one provider request). */
    loop: ToolLoop | null = null,
  ): RouteCostFields {
    const { config, providers } = this.deps;
    const firstInputTokens = estimateTokensForLedger(inputChars);
    const worstCaseCostUsd = (provider: ProviderId): number | null => {
      const models = providers.modelsFor(provider);
      if (models.length === 0) return null;
      const budgets = this.inputBudgets(provider, firstInputTokens, loop);
      let worst = 0;
      for (const model of models) {
        const price = priceFor(config.modelPrices, provider, model);
        // An unpriced model cannot be bounded: the provider never fits (spend limits fail closed).
        if (!price) return null;
        worst = Math.max(worst, worstCaseUsd(price, budgets, this.outputTokenCap(provider, model)));
      }
      return worst;
    };
    return { paidAllowed: spend.paidAllowed, paidHeadroomUsd: spend.headroom?.usd ?? null, maxCostUsd: config.ai.limits.requestUsd, worstCaseCostUsd };
  }

  /** A failed route decision → what the person is told (always DASH AI's own words). */
  refusal(decision: Extract<RouteDecision, { ok: false }>, spend: SpendStatus | null): Refusal {
    switch (decision.reason) {
      case "context_too_large":
        return { kind: "context_too_large" };
      case "quota_exhausted":
        return { kind: "busy" };
      case "limit_reached": {
        const scope = this.limitingScope(decision, spend);
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
        bedrockEnabled: config.ai.bedrockEnabled,
        defaultPlan: config.ai.defaultPlan,
        defaultSensitivity: config.ai.defaultSensitivity,
      },
      spend: {
        limits: config.ai.limits,
        today: { systemUsd: spend.totals.systemDailyUsd },
        month: { systemUsd: spend.totals.systemMonthlyUsd },
        // Each configured system limit: actual, reserved by requests in flight, available.
        usage: spend.usage,
        paidAllowed: spend.paidAllowed,
        blockedBy: spend.blockedBy,
      },
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
