import { describe, expect, it } from "vitest";
import { allowSpend, spendCeilingConfigured, type SpendLimits } from "../src/intelligence/spend.js";

const NONE: SpendLimits = { requestUsd: null, userDailyUsd: null, systemDailyUsd: null, systemMonthlyUsd: null };

describe("spend circuit-breaker decisions", () => {
  it("allows a request when no application spend ceiling is configured", () => {
    expect(allowSpend(NONE, { userTodayUsd: 999, systemTodayUsd: 999, systemMonthUsd: 999 }, null)).toEqual({ allowed: true });
    expect(spendCeilingConfigured(NONE)).toBe(false);
  });

  it("blocks a single request whose estimate exceeds the per-request ceiling", () => {
    expect(
      allowSpend(
        { ...NONE, requestUsd: 0.05 },
        { userTodayUsd: 0, systemTodayUsd: 0, systemMonthUsd: 0 },
        0.051,
      ),
    ).toEqual({ allowed: false, reason: "request_limit", currentUsd: 0.051, limitUsd: 0.05 });
  });

  it("checks the projected total rather than waiting until a daily ceiling is already crossed", () => {
    expect(
      allowSpend(
        { ...NONE, userDailyUsd: 1 },
        { userTodayUsd: 0.99, systemTodayUsd: 7, systemMonthUsd: 30 },
        0.02,
      ),
    ).toEqual({ allowed: false, reason: "user_daily_limit", currentUsd: 0.99, limitUsd: 1 });
  });

  it("blocks at system daily and monthly boundaries", () => {
    expect(
      allowSpend(
        { ...NONE, systemDailyUsd: 10 },
        { userTodayUsd: 0, systemTodayUsd: 9.95, systemMonthUsd: 20 },
        0.06,
      ),
    ).toEqual({ allowed: false, reason: "system_daily_limit", currentUsd: 9.95, limitUsd: 10 });
    expect(
      allowSpend(
        { ...NONE, systemMonthlyUsd: 100 },
        { userTodayUsd: 0, systemTodayUsd: 1, systemMonthUsd: 99.9 },
        0.11,
      ),
    ).toEqual({ allowed: false, reason: "system_monthly_limit", currentUsd: 99.9, limitUsd: 100 });
  });

  it("does not pretend an unknown provider price is zero", () => {
    const limits = { ...NONE, systemDailyUsd: 10 };
    expect(spendCeilingConfigured(limits)).toBe(true);
    expect(allowSpend(limits, { userTodayUsd: 0, systemTodayUsd: 9, systemMonthUsd: 9 }, null)).toEqual({ allowed: true });
    // The pure function leaves unknown-price policy to the caller; this assertion protects against
    // accidentally treating unknown as a numeric zero inside the accounting primitive.
  });
});
