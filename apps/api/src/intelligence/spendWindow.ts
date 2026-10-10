import type { InferenceAttempt } from "./attemptLedger.js";
import { attemptSpendUsd } from "./attemptLedger.js";

export interface SpendWindow {
  userDailyUsd: number;
  systemDailyUsd: number;
  systemMonthlyUsd: number;
}

export interface SpendWindowBounds {
  dayStart: string;
  dayEnd: string;
  monthStart: string;
  monthEnd: string;
}

/** Explicit UTC boundaries so in-memory and PostgreSQL accounting cannot depend on host/session TZ. */
export function spendWindowBounds(nowIso: string): SpendWindowBounds {
  const now = new Date(nowIso);
  if (Number.isNaN(now.getTime())) throw new Error("Invalid spend-window timestamp.");
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.getUTCDate();
  return {
    dayStart: new Date(Date.UTC(year, month, day)).toISOString(),
    dayEnd: new Date(Date.UTC(year, month, day + 1)).toISOString(),
    monthStart: new Date(Date.UTC(year, month, 1)).toISOString(),
    monthEnd: new Date(Date.UTC(year, month + 1, 1)).toISOString(),
  };
}

/**
 * Pure aggregation used by tests and the in-memory store. PostgreSQL uses the same explicit UTC
 * bounds rather than relying on its session timezone.
 */
export function aggregateSpendWindow(
  attempts: readonly InferenceAttempt[],
  nowIso: string,
  userId: string | null,
): SpendWindow {
  const bounds = spendWindowBounds(nowIso);
  const dayStart = Date.parse(bounds.dayStart);
  const dayEnd = Date.parse(bounds.dayEnd);
  const monthStart = Date.parse(bounds.monthStart);
  const monthEnd = Date.parse(bounds.monthEnd);
  let userDailyUsd = 0;
  let systemDailyUsd = 0;
  let systemMonthlyUsd = 0;

  for (const attempt of attempts) {
    const finished = Date.parse(attempt.finishedAt);
    if (Number.isNaN(finished)) continue;
    const spend = attemptSpendUsd(attempt);
    if (finished >= monthStart && finished < monthEnd) systemMonthlyUsd += spend;
    if (finished < dayStart || finished >= dayEnd) continue;
    systemDailyUsd += spend;
    if (userId !== null && attempt.userId === userId) userDailyUsd += spend;
  }

  return { userDailyUsd, systemDailyUsd, systemMonthlyUsd };
}
