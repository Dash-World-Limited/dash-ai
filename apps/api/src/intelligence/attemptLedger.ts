import type { ProviderId } from "@dash-ai/contracts";

/** Provider-attempt accounting is internal only. Never attach prompt/response content here. */
export type UsageSource = "provider_reported" | "estimated" | "unknown";

export interface InferenceAttempt {
  id: string;
  inferenceId: string;
  userId: string | null;
  task: string;
  provider: ProviderId;
  configuredModel: string;
  servedModel: string | null;
  attemptIndex: number;
  fallbackIndex: number;
  startedAt: string;
  finishedAt: string;
  latencyMs: number;
  status: "success" | "failure" | "cancelled";
  errorCode: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  usageSource: UsageSource;
  estimatedCostUsd: number | null;
  actualCostUsd: number | null;
  currency: "USD";
}

/** Append-only boundary used by inference without coupling callers to a storage implementation. */
export interface AttemptRecorder {
  record(attempt: InferenceAttempt): void | Promise<void>;
}

export interface InferenceAttemptTotals {
  estimatedCostUsd: number;
  actualCostUsd: number;
}

/**
 * Cost used by spend controls: prefer provider/settled cost when present, otherwise the estimate.
 * Unknown cost contributes zero here and must be handled by the caller's fail-safe policy.
 */
export function attemptSpendUsd(attempt: Pick<InferenceAttempt, "actualCostUsd" | "estimatedCostUsd">): number {
  return attempt.actualCostUsd ?? attempt.estimatedCostUsd ?? 0;
}

export function summarizeAttemptSpend(attempts: readonly InferenceAttempt[]): InferenceAttemptTotals {
  let estimatedCostUsd = 0;
  let actualCostUsd = 0;
  for (const attempt of attempts) {
    estimatedCostUsd += attempt.estimatedCostUsd ?? 0;
    actualCostUsd += attempt.actualCostUsd ?? attempt.estimatedCostUsd ?? 0;
  }
  return { estimatedCostUsd, actualCostUsd };
}
