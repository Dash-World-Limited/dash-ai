import { describe, expect, it } from "vitest";
import { attemptSpendUsd, summarizeAttemptSpend, type InferenceAttempt } from "../src/intelligence/attemptLedger.js";

const attempt = (overrides: Partial<InferenceAttempt> = {}): InferenceAttempt => ({
  id: "attempt_0001",
  inferenceId: "inference_0001",
  userId: "user_0001",
  task: "chat",
  provider: "bedrock",
  configuredModel: "configured-model",
  servedModel: "served-model",
  attemptIndex: 0,
  fallbackIndex: 0,
  startedAt: "2026-10-10T00:00:00.000Z",
  finishedAt: "2026-10-10T00:00:01.000Z",
  latencyMs: 1000,
  status: "success",
  errorCode: null,
  inputTokens: 100,
  outputTokens: 20,
  cachedTokens: null,
  usageSource: "provider_reported",
  estimatedCostUsd: 0.01,
  actualCostUsd: null,
  currency: "USD",
  ...overrides,
});

describe("provider-attempt cost accounting", () => {
  it("prefers actual provider cost when available", () => {
    expect(attemptSpendUsd(attempt({ estimatedCostUsd: 0.01, actualCostUsd: 0.008 }))).toBe(0.008);
  });

  it("falls back to estimated cost and treats unknown as zero for aggregation", () => {
    expect(attemptSpendUsd(attempt({ estimatedCostUsd: 0.01, actualCostUsd: null }))).toBe(0.01);
    expect(attemptSpendUsd(attempt({ estimatedCostUsd: null, actualCostUsd: null }))).toBe(0);
  });

  it("counts every retry and fallback attempt rather than only the final answer", () => {
    const totals = summarizeAttemptSpend([
      attempt({ id: "attempt_0001", status: "failure", estimatedCostUsd: 0.002 }),
      attempt({ id: "attempt_0002", attemptIndex: 1, status: "failure", estimatedCostUsd: 0.003 }),
      attempt({ id: "attempt_0003", fallbackIndex: 1, status: "success", estimatedCostUsd: 0.01, actualCostUsd: 0.009 }),
    ]);
    expect(totals.estimatedCostUsd).toBeCloseTo(0.015, 12);
    expect(totals.actualCostUsd).toBeCloseTo(0.014, 12);
  });
});
