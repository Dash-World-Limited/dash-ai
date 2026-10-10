import { describe, expect, it } from "vitest";
import { InMemoryAttemptLedger } from "../src/intelligence/attemptLedgerMemory.js";
import type { InferenceAttempt } from "../src/intelligence/attemptLedger.js";

const attempt = (id: string, userId: string, cost: number): InferenceAttempt => ({
  id,
  inferenceId: `inf_${id}`,
  userId,
  task: "chat",
  provider: "bedrock",
  configuredModel: "m",
  servedModel: "m",
  attemptIndex: 0,
  fallbackIndex: 0,
  startedAt: "2026-10-10T00:00:00.000Z",
  finishedAt: "2026-10-10T00:00:01.000Z",
  latencyMs: 1000,
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

describe("InMemoryAttemptLedger", () => {
  it("keeps attempts immutable from callers and aggregates spend", () => {
    const ledger = new InMemoryAttemptLedger();
    ledger.record(attempt("a", "user_a", 0.01));
    ledger.record(attempt("b", "user_b", 0.02));

    const listed = ledger.list();
    listed[0]!.estimatedCostUsd = 99;

    expect(ledger.list()[0]!.estimatedCostUsd).toBe(0.01);
    expect(ledger.spend("2026-10-10T12:00:00.000Z", "user_a")).toEqual({
      userDailyUsd: 0.01,
      systemDailyUsd: 0.03,
      systemMonthlyUsd: 0.03,
    });
  });
});
