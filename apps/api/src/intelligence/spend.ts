import type { InferenceSpend, Store } from "../store/store.js";
import type { AiControls } from "./settings.js";

/** Which limit stopped paid inference (most specific reported). */
export type SpendScope = "system_monthly" | "system_daily" | "plan_daily" | "user_daily";

export interface SpendStatus {
  /** False when a spend limit stops paid providers for this request (free providers may still serve it). */
  paidAllowed: boolean;
  blockedBy: SpendScope | null;
  /**
   * The tightest remaining allowance across the configured limits (limit minus paid spend), and which
   * limit it is; null when no limit is configured. A paid provider is admitted only when its
   * worst-case cost for the request fits in it (see RouteRequest.paidHeadroomUsd).
   */
  headroom: { usd: number; scope: SpendScope } | null;
  totals: { systemDailyUsd: number; systemMonthlyUsd: number; planDailyUsd: number | null; userDailyUsd: number | null };
}

/** Start of the current UTC day / month (limits reset at 00:00 UTC). */
export const dayStart = (now: number): string => {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
};
export const monthStart = (now: number): string => {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
};

/**
 * The global spend circuit breaker. Paid spend comes from the inference ledger (shared by every API
 * instance through the database), so limits hold across restarts and instances. Limits are checked
 * before a request is routed, against the spend already recorded plus the request's own worst case,
 * so a request that is admitted cannot by itself take spend past a limit. Requests running at the
 * same time are each admitted against the same recorded spend, so together they can overshoot a
 * limit by at most their combined worst cases.
 * Only paid traffic counts: free and promotional providers cost DASH nothing.
 */
export class SpendGuard {
  private cache: { at: number; daily: number; monthly: number } | null = null;

  constructor(
    private readonly store: Store,
    private readonly controls: AiControls,
    private readonly now: () => number = Date.now,
    /** How long system totals are reused (they change with every answer; a few seconds is enough). */
    private readonly cacheMs = 5_000,
  ) {}

  /** Forget cached totals (after recording spend). */
  invalidate(): void {
    this.cache = null;
  }

  private async paid(query: { since: string; userId?: string; plan?: string }): Promise<InferenceSpend> {
    return this.store.sumInferenceSpend({ ...query, pricing: ["paid"] });
  }

  private async systemTotals(): Promise<{ daily: number; monthly: number }> {
    const now = this.now();
    if (this.cache && now - this.cache.at < this.cacheMs) return this.cache;
    const [daily, monthly] = await Promise.all([this.paid({ since: dayStart(now) }), this.paid({ since: monthStart(now) })]);
    this.cache = { at: now, daily: daily.costUsd, monthly: monthly.costUsd };
    return this.cache;
  }

  async check(who: { userId: string | null; plan: string }): Promise<SpendStatus> {
    const { limits } = this.controls;
    const now = this.now();
    const system = await this.systemTotals();
    const planLimit = limits.planDailyUsd[who.plan] ?? null;
    const [plan, user] = await Promise.all([
      planLimit !== null ? this.paid({ since: dayStart(now), plan: who.plan }) : Promise.resolve(null),
      limits.userDailyUsd !== null && who.userId ? this.paid({ since: dayStart(now), userId: who.userId }) : Promise.resolve(null),
    ]);
    const totals = {
      systemDailyUsd: system.daily,
      systemMonthlyUsd: system.monthly,
      planDailyUsd: plan?.costUsd ?? null,
      userDailyUsd: user?.costUsd ?? null,
    };
    const reached = (spent: number | null, limit: number | null) => limit !== null && spent !== null && spent >= limit;
    const blockedBy: SpendScope | null = reached(totals.systemMonthlyUsd, limits.systemMonthlyUsd)
      ? "system_monthly"
      : reached(totals.systemDailyUsd, limits.systemDailyUsd)
        ? "system_daily"
        : reached(totals.planDailyUsd, planLimit)
          ? "plan_daily"
          : reached(totals.userDailyUsd, limits.userDailyUsd)
            ? "user_daily"
            : null;
    const remaining: Array<{ usd: number; scope: SpendScope }> = [];
    const allow = (scope: SpendScope, spent: number | null, limit: number | null) => {
      if (limit !== null && spent !== null) remaining.push({ usd: limit - spent, scope });
    };
    allow("system_monthly", totals.systemMonthlyUsd, limits.systemMonthlyUsd);
    allow("system_daily", totals.systemDailyUsd, limits.systemDailyUsd);
    allow("plan_daily", totals.planDailyUsd, planLimit);
    allow("user_daily", totals.userDailyUsd, limits.userDailyUsd);
    const headroom = remaining.reduce<{ usd: number; scope: SpendScope } | null>((min, r) => (min === null || r.usd < min.usd ? r : min), null);
    return { paidAllowed: blockedBy === null, blockedBy, headroom, totals };
  }
}
