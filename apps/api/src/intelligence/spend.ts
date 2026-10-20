import type { InferenceSpend, ReserveSpendInput, ReserveSpendResult, SpendLimit, SpendScope, SpendUsage, Store } from "../store/store.js";
import type { AiControls } from "./settings.js";

/** Which limit stopped paid inference (most specific reported). */
export type { SpendScope } from "../store/store.js";

export interface SpendStatus {
  /** False when a spend limit stops paid providers for this request (free providers may still serve it). */
  paidAllowed: boolean;
  blockedBy: SpendScope | null;
  /**
   * The tightest AVAILABLE allowance across the configured limits (limit minus actual paid spend minus
   * what requests still in flight have reserved), and which limit it is; null when no limit is
   * configured. A paid provider is routed to only when its worst-case cost for the request fits in it
   * (see RouteRequest.paidHeadroomUsd), and admitted only when its reservation succeeds.
   */
  headroom: { usd: number; scope: SpendScope } | null;
  /** Actual paid spend (ledger). Plan and person totals are null when that limit is not configured. */
  totals: { systemDailyUsd: number; systemMonthlyUsd: number; planDailyUsd: number | null; userDailyUsd: number | null };
  /** Each configured limit: actual, reserved (in flight) and available. */
  usage: SpendUsage[];
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

/** Spend state from each limit's usage: a limit with nothing available stops paid inference. */
export function spendStatusFrom(usage: readonly SpendUsage[], totals: SpendStatus["totals"]): SpendStatus {
  const blockedBy = usage.find((u) => u.availableUsd <= 0)?.scope ?? null;
  const headroom = usage.reduce<{ usd: number; scope: SpendScope } | null>(
    (min, u) => (min === null || u.availableUsd < min.usd ? { usd: u.availableUsd, scope: u.scope } : min),
    null,
  );
  return { paidAllowed: blockedBy === null, blockedBy, headroom, totals, usage: [...usage] };
}

/**
 * The global spend circuit breaker. Paid spend comes from the inference ledger and in-flight holds from
 * spend reservations, both shared by every API instance through the database, so limits hold across
 * restarts and instances.
 *
 * Two steps (ADR 0015): `check` is a quick read (system totals cached for a few seconds) that the
 * router uses to leave out paid providers whose worst case cannot fit; `reserve` is the admission
 * itself, an atomic check-and-hold in the store that counts actual spend and every other request still
 * in flight. Correctness never depends on the cache: only `reserve` admits paid work.
 * Only paid traffic counts: free and promotional providers cost DASH nothing.
 */
export class SpendGuard {
  private cache: { at: number; daily: number; monthly: number; usage: SpendUsage[] } | null = null;

  constructor(
    private readonly store: Store,
    private readonly controls: AiControls,
    private readonly now: () => number = Date.now,
    /** How long system totals are reused (they change with every answer; a few seconds is enough). */
    private readonly cacheMs = 5_000,
  ) {}

  /** Forget cached totals (after recording spend, reserving or settling). */
  invalidate(): void {
    this.cache = null;
  }

  /**
   * Every configured aggregate limit a request for this account falls under, in the order a refusal
   * reports them (system monthly, system daily, plan, person). The per-request ceiling is not here: it
   * bounds one request on its own and needs no reservation.
   */
  limits(who: { userId: string | null; plan: string }): SpendLimit[] {
    const { limits } = this.controls;
    const now = this.now();
    const out: SpendLimit[] = [];
    if (limits.systemMonthlyUsd !== null) out.push({ scope: "system_monthly", limitUsd: limits.systemMonthlyUsd, since: monthStart(now) });
    if (limits.systemDailyUsd !== null) out.push({ scope: "system_daily", limitUsd: limits.systemDailyUsd, since: dayStart(now) });
    const planLimit = limits.planDailyUsd[who.plan];
    if (planLimit !== undefined) out.push({ scope: "plan_daily", limitUsd: planLimit, since: dayStart(now), plan: who.plan });
    if (limits.userDailyUsd !== null && who.userId) out.push({ scope: "user_daily", limitUsd: limits.userDailyUsd, since: dayStart(now), userId: who.userId });
    return out;
  }

  private async paid(query: { since: string }): Promise<InferenceSpend> {
    return this.store.sumInferenceSpend({ ...query, pricing: ["paid"] });
  }

  private async systemState(limits: SpendLimit[]): Promise<{ daily: number; monthly: number; usage: SpendUsage[] }> {
    const now = this.now();
    if (this.cache && now - this.cache.at < this.cacheMs) return this.cache;
    const [daily, monthly, usage] = await Promise.all([this.paid({ since: dayStart(now) }), this.paid({ since: monthStart(now) }), this.store.spendUsage(limits)]);
    this.cache = { at: now, daily: daily.costUsd, monthly: monthly.costUsd, usage };
    return this.cache;
  }

  /** A quick read of the spend state (routing hint and operator view; never an admission). */
  async check(who: { userId: string | null; plan: string }): Promise<SpendStatus> {
    const limits = this.limits(who);
    const isSystem = (l: SpendLimit) => l.scope === "system_daily" || l.scope === "system_monthly";
    const [system, own] = await Promise.all([this.systemState(limits.filter(isSystem)), this.store.spendUsage(limits.filter((l) => !isSystem(l)))]);
    const usage = [...system.usage, ...own];
    const actual = (scope: SpendScope) => usage.find((u) => u.scope === scope)?.actualUsd ?? null;
    return spendStatusFrom(usage, {
      systemDailyUsd: system.daily,
      systemMonthlyUsd: system.monthly,
      planDailyUsd: actual("plan_daily"),
      userDailyUsd: actual("user_daily"),
    });
  }

  /** The admission: atomically holds `amountUsd` against every limit, or refuses with fresh usage. */
  async reserve(input: Omit<ReserveSpendInput, "limits">): Promise<ReserveSpendResult> {
    try {
      return await this.store.reserveSpend({ ...input, limits: this.limits({ userId: input.userId, plan: input.plan }) });
    } finally {
      this.invalidate();
    }
  }
}
