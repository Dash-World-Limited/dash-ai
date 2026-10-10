import type { InferenceAttempt } from "./attemptLedger.js";
import { attemptSpendUsd } from "./attemptLedger.js";

export interface SpendWindow {
  userDailyUsd: number;
  systemDailyUsd: number;
  systemMonthlyUsd: number;
}

const dayKey = (iso: string) => iso.slice(0, 10);
const monthKey = (iso: string) => iso.slice(0, 7);

/**
 * Pure aggregation used by tests and the in-memory store. PostgreSQL uses equivalent indexed SQL.
 */
export function aggregateSpendWindow(
  attempts: readonly InferenceAttempt[],
  nowIso: string,
  userId: string | null,
): SpendWindow {
  const day = dayKey(nowIso);
  const month = monthKey(nowIso);
  let userDailyUsd = 0;
  let systemDailyUsd = 0;
  let systemMonthlyUsd = 0;

  for (const attempt of attempts) {
    const spend = attemptSpendUsd(attempt);
    if (monthKey(attempt.finishedAt) === month) systemMonthlyUsd += spend;
    if (dayKey(attempt.finishedAt) !== day) continue;
    systemDailyUsd += spend;
    if (userId !== null && attempt.userId === userId) userDailyUsd += spend;
  }

  return { userDailyUsd, systemDailyUsd, systemMonthlyUsd };
}
