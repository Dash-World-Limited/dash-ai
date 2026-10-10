import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, type RouterPolicy } from "../src/intelligence/policy.js";
import {
  DEFAULT_SPEND_SETTINGS,
  admitBySpend,
  projectedRequestCostUsd,
  type SpendSettings,
} from "../src/intelligence/spendAdmission.js";
import type { SpendWindow } from "../src/intelligence/spendWindow.js";

const ZERO: SpendWindow = { userDailyUsd: 0, systemDailyUsd: 0, systemMonthlyUsd: 0 };
const ledger = (window: SpendWindow = ZERO) => ({ spend: async () => window });
const settings = (patch: Partial<SpendSettings> = {}): SpendSettings => ({
  ...DEFAULT_SPEND_SETTINGS,
  ...patch,
  limits: { ...DEFAULT_SPEND_SETTINGS.limits, ...(patch.limits ?? {}) },
});
const candidate = (provider: "openai" | "anthropic" | "bedrock", model = `model-${provider}`, demo = false) => ({ provider, model, demo });

const policyWith = (provider: "openai" | "anthropic" | "bedrock", patch: Partial<NonNullable<RouterPolicy["providers"][typeof provider]>>): RouterPolicy => ({
  ...DEFAULT_POLICY,
  providers: {
    ...DEFAULT_POLICY.providers,
    [provider]: { ...DEFAULT_POLICY.providers[provider]!, ...patch },
  },
});

describe("projectedRequestCostUsd", () => {
  it("returns zero for demo/free routes", () => {
    expect(
      projectedRequestCostUsd({
        provider: "openai",
        model: "m",
        demo: true,
        billing: "demo",
        estimatedInputTokens: 1000,
        maxOutputTokens: 1000,
        policy: DEFAULT_POLICY,
        prices: {},
      }),
    ).toBe(0);
    expect(
      projectedRequestCostUsd({
        provider: "openai",
        model: "m",
        demo: false,
        billing: "free",
        estimatedInputTokens: 1000,
        maxOutputTokens: 1000,
        policy: DEFAULT_POLICY,
        prices: {},
      }),
    ).toBe(0);
  });

  it("uses the conservative larger rate between router metadata and model-specific accounting price", () => {
    const policy = policyWith("openai", { costPerMillionInput: 1, costPerMillionOutput: 2 });
    const projected = projectedRequestCostUsd({
      provider: "openai",
      model: "gpt-test-2026",
      demo: false,
      billing: "paid",
      estimatedInputTokens: 1_000_000,
      maxOutputTokens: 1_000_000,
      policy,
      prices: { "openai:gpt-test": { inputPerMillion: 1.5, outputPerMillion: 1.5 } },
    });
    expect(projected).toBe(3.5);
  });

  it("keeps unknown paid cost unknown", () => {
    expect(
      projectedRequestCostUsd({
        provider: "openai",
        model: "unpriced",
        demo: false,
        billing: "paid",
        estimatedInputTokens: 1000,
        maxOutputTokens: 1000,
        policy: DEFAULT_POLICY,
        prices: {},
      }),
    ).toBeNull();
  });
});

describe("admitBySpend", () => {
  const base = {
    prices: {},
    estimatedInputTokens: 1_000,
    maxOutputTokens: 1_000,
    userId: "user_a",
    nowIso: "2026-10-10T12:00:00.000Z",
  } as const;

  it("blocks every route when the global AI kill switch is off", async () => {
    const result = await admitBySpend({
      ...base,
      ordered: [candidate("openai"), candidate("bedrock")],
      settings: settings({ aiEnabled: false }),
      ledger: ledger(),
      policy: DEFAULT_POLICY,
    });
    expect(result.candidates).toEqual([]);
    expect(result.rejected).toEqual([
      { provider: "openai", reason: "ai_disabled" },
      { provider: "bedrock", reason: "ai_disabled" },
    ]);
  });

  it("allows a free route even when paid spend ceilings are already exhausted", async () => {
    const policy = policyWith("openai", { billing: "free" });
    const result = await admitBySpend({
      ...base,
      ordered: [candidate("openai")],
      settings: settings({ limits: { systemDailyUsd: 1 } }),
      ledger: ledger({ userDailyUsd: 2, systemDailyUsd: 2, systemMonthlyUsd: 20 }),
      policy,
    });
    expect(result.candidates.map((c) => c.provider)).toEqual(["openai"]);
    expect(result.rejected).toEqual([]);
  });

  it("rejects paid routes when paid providers are disabled", async () => {
    const result = await admitBySpend({
      ...base,
      ordered: [candidate("bedrock")],
      settings: settings({ paidProvidersEnabled: false }),
      ledger: ledger(),
      policy: DEFAULT_POLICY,
    });
    expect(result.candidates).toEqual([]);
    expect(result.rejected).toEqual([{ provider: "bedrock", reason: "paid_providers_disabled" }]);
  });

  it("fails closed on unknown paid cost when any spend ceiling is configured", async () => {
    const result = await admitBySpend({
      ...base,
      ordered: [candidate("openai")],
      settings: settings({ limits: { systemDailyUsd: 10 } }),
      ledger: ledger(),
      policy: DEFAULT_POLICY,
    });
    expect(result.candidates).toEqual([]);
    expect(result.rejected).toEqual([{ provider: "openai", reason: "unknown_cost" }]);
  });

  it("allows unknown paid cost while spend ceilings are intentionally unconfigured", async () => {
    const result = await admitBySpend({
      ...base,
      ordered: [candidate("openai")],
      settings: settings(),
      ledger: ledger(),
      policy: DEFAULT_POLICY,
    });
    expect(result.candidates.map((c) => c.provider)).toEqual(["openai"]);
  });

  it("enforces request and accumulated spend ceilings using projected cost", async () => {
    const policy = policyWith("bedrock", { costPerMillionInput: 1, costPerMillionOutput: 1 });
    const requestBlocked = await admitBySpend({
      ...base,
      ordered: [candidate("bedrock")],
      settings: settings({ limits: { requestUsd: 0.0015 } }),
      ledger: ledger(),
      policy,
    });
    expect(requestBlocked.rejected).toEqual([{ provider: "bedrock", reason: "request_limit" }]);

    const dailyBlocked = await admitBySpend({
      ...base,
      ordered: [candidate("bedrock")],
      settings: settings({ limits: { userDailyUsd: 1 } }),
      ledger: ledger({ userDailyUsd: 0.999, systemDailyUsd: 0.999, systemMonthlyUsd: 0.999 }),
      policy,
    });
    expect(dailyBlocked.rejected).toEqual([{ provider: "bedrock", reason: "user_daily_limit" }]);
  });

  it("preserves router order while filtering an ineligible Bedrock fallback", async () => {
    const policy: RouterPolicy = {
      ...policyWith("openai", { billing: "free" }),
      providers: {
        ...policyWith("openai", { billing: "free" }).providers,
        bedrock: { ...DEFAULT_POLICY.providers.bedrock!, billing: "paid" },
      },
    };
    const result = await admitBySpend({
      ...base,
      ordered: [candidate("openai"), candidate("bedrock"), candidate("anthropic")],
      settings: settings({ bedrockFallbackEnabled: false }),
      ledger: ledger(),
      policy,
    });
    expect(result.candidates.map((c) => c.provider)).toEqual(["openai", "anthropic"]);
    expect(result.rejected).toContainEqual({ provider: "bedrock", reason: "bedrock_fallback_disabled" });
  });
});
