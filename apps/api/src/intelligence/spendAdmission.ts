import type { ProviderId } from "@dash-ai/contracts";
import type { ModelPrices } from "./cost.js";
import { priceFor } from "./cost.js";
import type { BillingClass, RouterPolicy } from "./policy.js";
import { allowSpend, spendCeilingConfigured, type SpendLimits } from "./spend.js";
import type { SpendWindow } from "./spendWindow.js";

export interface SpendSettings {
  aiEnabled: boolean;
  freePoolEnabled: boolean;
  paidProvidersEnabled: boolean;
  bedrockFallbackEnabled: boolean;
  limits: SpendLimits;
}

export const DEFAULT_SPEND_SETTINGS: SpendSettings = {
  aiEnabled: true,
  freePoolEnabled: true,
  paidProvidersEnabled: true,
  bedrockFallbackEnabled: true,
  limits: { requestUsd: null, userDailyUsd: null, systemDailyUsd: null, systemMonthlyUsd: null },
};

export interface SpendLedger {
  /** Optional for legacy/background callers that only record attempts and do not enable spend ceilings. */
  spend?(nowIso: string, userId: string | null): Promise<SpendWindow> | SpendWindow;
}

export interface SpendCandidate {
  provider: ProviderId;
  model: string;
  demo: boolean;
}

export type SpendRejectReason =
  | "ai_disabled"
  | "free_pool_disabled"
  | "paid_providers_disabled"
  | "bedrock_fallback_disabled"
  | "unknown_cost"
  | "request_limit"
  | "user_daily_limit"
  | "system_daily_limit"
  | "system_monthly_limit";

export interface SpendAdmissionResult {
  candidates: SpendCandidate[];
  rejected: Array<{ provider: ProviderId; reason: SpendRejectReason }>;
}

/**
 * Conservative pre-request estimate for spend admission. Actual accounting always comes from the
 * immutable attempt ledger; this only decides whether a paid request may start.
 */
export function projectedRequestCostUsd(input: {
  provider: ProviderId;
  model: string;
  demo: boolean;
  billing: BillingClass;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  policy: RouterPolicy;
  prices: ModelPrices;
}): number | null {
  if (input.demo || input.billing === "demo" || input.billing === "free") return 0;
  const profile = input.policy.providers[input.provider];
  const modelPrice = priceFor(input.prices, input.provider, input.model);

  // Router profile prices are intentionally conservative routing estimates; MODEL_PRICES is the
  // operator's model-specific accounting price. If both exist, use the larger side-by-side ceiling.
  const inputRate = [profile?.costPerMillionInput ?? null, modelPrice?.inputPerMillion ?? null]
    .filter((n): n is number => n !== null)
    .reduce<number | null>((best, n) => (best === null ? n : Math.max(best, n)), null);
  const outputRate = [profile?.costPerMillionOutput ?? null, modelPrice?.outputPerMillion ?? null]
    .filter((n): n is number => n !== null)
    .reduce<number | null>((best, n) => (best === null ? n : Math.max(best, n)), null);
  if (inputRate === null || outputRate === null) return null;
  const usd = (Math.max(0, input.estimatedInputTokens) * inputRate + Math.max(0, input.maxOutputTokens) * outputRate) / 1_000_000;
  return Math.round(usd * 1e10) / 1e10;
}

/**
 * Filters an already-ranked route through the cost circuit breaker without changing its order.
 * Free/demo routes do not consume the paid spend window. Paid/promotional routes fail closed when
 * a spend ceiling exists but their request cost cannot be estimated.
 */
export async function admitBySpend(input: {
  ordered: readonly SpendCandidate[];
  settings: SpendSettings;
  ledger: SpendLedger;
  policy: RouterPolicy;
  prices: ModelPrices;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  userId: string | null;
  nowIso: string;
}): Promise<SpendAdmissionResult> {
  const rejected: Array<{ provider: ProviderId; reason: SpendRejectReason }> = [];
  if (!input.settings.aiEnabled) {
    return {
      candidates: [],
      rejected: input.ordered.map((c) => ({ provider: c.provider, reason: "ai_disabled" as const })),
    };
  }

  const hasCeiling = spendCeilingConfigured(input.settings.limits);
  const hasSpendReader = typeof input.ledger.spend === "function";
  const window = hasCeiling && hasSpendReader ? await input.ledger.spend!(input.nowIso, input.userId) : null;
  const candidates: SpendCandidate[] = [];

  for (const [index, candidate] of input.ordered.entries()) {
    const billing = input.policy.providers[candidate.provider]?.billing ?? "paid";
    if ((billing === "free" || billing === "demo") && !input.settings.freePoolEnabled && !candidate.demo) {
      rejected.push({ provider: candidate.provider, reason: "free_pool_disabled" });
      continue;
    }
    if ((billing === "paid" || billing === "promotional") && !input.settings.paidProvidersEnabled) {
      rejected.push({ provider: candidate.provider, reason: "paid_providers_disabled" });
      continue;
    }
    if (candidate.provider === "bedrock" && index > 0 && !input.settings.bedrockFallbackEnabled) {
      rejected.push({ provider: candidate.provider, reason: "bedrock_fallback_disabled" });
      continue;
    }

    if (billing !== "paid" && billing !== "promotional") {
      candidates.push(candidate);
      continue;
    }

    // A configured ceiling without a readable spend ledger must fail closed for paid inference.
    if (hasCeiling && !hasSpendReader) {
      rejected.push({ provider: candidate.provider, reason: "unknown_cost" });
      continue;
    }

    const projected = projectedRequestCostUsd({
      ...candidate,
      billing,
      estimatedInputTokens: input.estimatedInputTokens,
      maxOutputTokens: input.maxOutputTokens,
      policy: input.policy,
      prices: input.prices,
    });
    if (hasCeiling && projected === null) {
      rejected.push({ provider: candidate.provider, reason: "unknown_cost" });
      continue;
    }
    if (window) {
      const decision = allowSpend(
        input.settings.limits,
        {
          userTodayUsd: window.userDailyUsd,
          systemTodayUsd: window.systemDailyUsd,
          systemMonthUsd: window.systemMonthlyUsd,
        },
        projected,
      );
      if (!decision.allowed) {
        rejected.push({ provider: candidate.provider, reason: decision.reason });
        continue;
      }
    }
    candidates.push(candidate);
  }

  return { candidates, rejected };
}
