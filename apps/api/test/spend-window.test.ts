import { describe, expect, it } from "vitest";
import type { InferenceAttempt } from "../src/intelligence/attemptLedger.js";
import { aggregateSpendWindow, spendWindowBounds } from "../src/intelligence/spendWindow.js";

const row = (id: string, finishedAt: string, cost: number, userId = "user_a"): InferenceAttempt => ({
  id,
  inferenceId: `inf_${id}`,
  userId,
  task: "chat",
  provider: "bedrock",
  configuredModel: "m",
  servedModel: "m",
  attemptIndex: 0,
  fallbackIndex: 0,
  startedAt: finishedAt,
  finishedAt,
  latencyMs: 1,
  status: "success",
  errorCode: null,
  inputTokens: 1,
  outputTokens: 1,
  cachedTokens: null,
  usageSource: "provider_reported",
  estimatedCostUsd: cost,
  actualCostUsd: null,
  currency: "USD",
});

describe("aggregateSpendWindow", () => {
  it("separates user daily, system daily and system monthly spend", () => {
    const attempts = [
      row("a", "2026-10-10T01:00:00.000Z", 1),
      row("b", "2026-10-10T02:00:00.000Z", 2, "user_b"),
      row("c", "2026-10-09T23:00:00.000Z", 3),
      row("d", "2026-09-30T23:00:00.000Z", 4),
    ];
    expect(aggregateSpendWindow(attempts, "2026-10-10T12:00:00.000Z", "user_a")).toEqual({
      userDailyUsd: 1,
      systemDailyUsd: 3,
      systemMonthlyUsd: 6,
    });
  });

  it("uses actual cost when available", () => {
    const attempts = [{ ...row("a", "2026-10-10T01:00:00.000Z", 1), actualCostUsd: 0.75 }];
    expect(aggregateSpendWindow(attempts, "2026-10-10T12:00:00.000Z", "user_a").systemDailyUsd).toBe(0.75);
  });

  it("uses UTC day/month boundaries even when now carries a non-UTC offset", () => {
    expect(spendWindowBounds("2026-11-01T00:30:00+01:00")).toEqual({
      dayStart: "2026-10-31T00:00:00.000Z",
      dayEnd: "2026-11-01T00:00:00.000Z",
      monthStart: "2026-10-01T00:00:00.000Z",
      monthEnd: "2026-11-01T00:00:00.000Z",
    });
    const attempts = [
      row("before", "2026-10-30T23:59:59.999Z", 100),
      row("start", "2026-10-31T00:00:00.000Z", 1),
      row("end", "2026-11-01T00:00:00.000Z", 10),
    ];
    expect(aggregateSpendWindow(attempts, "2026-11-01T00:30:00+01:00", "user_a")).toEqual({
      userDailyUsd: 1,
      systemDailyUsd: 1,
      systemMonthlyUsd: 101,
    });
  });
});
