export interface SpendLimits {
  /** null means this application layer has no cap; provider/account limits may still apply. */
  requestUsd: number | null;
  userDailyUsd: number | null;
  systemDailyUsd: number | null;
  systemMonthlyUsd: number | null;
}

export interface SpendSnapshot {
  userTodayUsd: number;
  systemTodayUsd: number;
  systemMonthUsd: number;
}

export type SpendRejectReason = "request_limit" | "user_daily_limit" | "system_daily_limit" | "system_monthly_limit";

export type SpendDecision =
  | { allowed: true }
  | { allowed: false; reason: SpendRejectReason; currentUsd: number; limitUsd: number };

/**
 * Pure cost circuit-breaker decision. Persistence and aggregation deliberately live outside this
 * module so PostgreSQL can be the multi-instance source of truth while tests can use simple snapshots.
 */
export function allowSpend(limits: SpendLimits, snapshot: SpendSnapshot, estimatedRequestUsd: number | null): SpendDecision {
  const estimated = estimatedRequestUsd === null ? null : Math.max(0, estimatedRequestUsd);

  if (limits.requestUsd !== null && estimated !== null && estimated > limits.requestUsd) {
    return { allowed: false, reason: "request_limit", currentUsd: estimated, limitUsd: limits.requestUsd };
  }
  if (limits.userDailyUsd !== null && estimated !== null && snapshot.userTodayUsd + estimated > limits.userDailyUsd) {
    return { allowed: false, reason: "user_daily_limit", currentUsd: snapshot.userTodayUsd, limitUsd: limits.userDailyUsd };
  }
  if (limits.systemDailyUsd !== null && estimated !== null && snapshot.systemTodayUsd + estimated > limits.systemDailyUsd) {
    return { allowed: false, reason: "system_daily_limit", currentUsd: snapshot.systemTodayUsd, limitUsd: limits.systemDailyUsd };
  }
  if (limits.systemMonthlyUsd !== null && estimated !== null && snapshot.systemMonthUsd + estimated > limits.systemMonthlyUsd) {
    return { allowed: false, reason: "system_monthly_limit", currentUsd: snapshot.systemMonthUsd, limitUsd: limits.systemMonthlyUsd };
  }
  return { allowed: true };
}

/**
 * Paid routes with unknown request cost must not bypass a configured spend ceiling. Callers can use
 * this helper to distinguish "no ceiling" from "ceiling exists but price is unknown" and fail closed.
 */
export function spendCeilingConfigured(limits: SpendLimits): boolean {
  return Object.values(limits).some((v) => v !== null);
}
