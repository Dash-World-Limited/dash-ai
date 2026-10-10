import type { ProviderId } from "@dash-ai/contracts";
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, loadPolicy } from "../src/intelligence/policy.js";
import { ProviderQuotaTracker } from "../src/intelligence/quota.js";
import { IntelligenceRouter } from "../src/intelligence/router.js";

const both = new Set<ProviderId>(["openai", "anthropic"]);

function makeRouter(policy = DEFAULT_POLICY, clock = { t: Date.parse("2026-10-10T06:00:00Z") }) {
  return new IntelligenceRouter(policy, () => both, () => clock.t);
}

describe("provider privacy and quota guardrails", () => {
  it("never sends private or sensitive content to an unapproved provider", () => {
    const policy = loadPolicy(
      JSON.stringify({
        providers: {
          openai: { privacy: "sensitive_allowed" },
          anthropic: { privacy: "non_sensitive_only" },
        },
      }),
    );
    const router = makeRouter(policy);

    expect(router.route({ task: "chat", mode: "general", sensitivity: "private" })).toMatchObject({
      ok: true,
      providers: ["openai"],
    });
    expect(router.route({ task: "chat", mode: "general", sensitivity: "sensitive" })).toMatchObject({
      ok: true,
      providers: ["openai"],
    });
    const publicRoute = router.route({ task: "chat", mode: "general", sensitivity: "public" });
    expect(publicRoute).toMatchObject({ ok: true, providers: ["openai", "anthropic"] });
  });

  it("defaults provider privacy to unapproved instead of guessing from the provider brand", () => {
    const decision = makeRouter().route({ task: "chat", mode: "general", sensitivity: "sensitive" });
    expect(decision.ok).toBe(false);
    expect(decision.rejected).toEqual(
      expect.arrayContaining([
        { provider: "openai", reason: "privacy" },
        { provider: "anthropic", reason: "privacy" },
      ]),
    );
  });

  it("hard-exhausted quota removes a provider from the route", () => {
    const router = makeRouter();
    router.quotas.update("openai", {
      classification: "metered",
      dimensions: { requests_day: { limit: 100, used: 100 } },
    });

    const decision = router.route({ task: "chat", mode: "general" });
    expect(decision).toMatchObject({ ok: true, providers: ["anthropic"] });
    expect(decision.rejected).toEqual(expect.arrayContaining([{ provider: "openai", reason: "quota" }]));
  });

  it("soft exhaustion preserves a provider as fallback but spends healthier quota first", () => {
    const router = makeRouter();
    router.quotas.update("openai", {
      classification: "metered",
      dimensions: { tokens_day: { limit: 100_000, used: 95_000 } },
    });

    expect(router.quotas.status("openai")).toMatchObject({ hardExhausted: false, softExhausted: true, remainingFraction: 0.05 });
    expect(router.route({ task: "chat", mode: "general" })).toMatchObject({
      ok: true,
      providers: ["anthropic", "openai"],
    });
  });

  it("does not let a stale quota window block traffic after its reset time", () => {
    const clock = { t: Date.parse("2026-10-10T06:00:00Z") };
    const quotas = new ProviderQuotaTracker(0.1, () => clock.t);
    const router = new IntelligenceRouter(DEFAULT_POLICY, () => both, () => clock.t, quotas);
    quotas.update("openai", {
      classification: "metered",
      dimensions: {
        requests_day: { limit: 100, used: 100, resetAt: "2026-10-10T05:59:59Z" },
      },
    });

    expect(quotas.status("openai")).toEqual({ hardExhausted: false, softExhausted: false, remainingFraction: null });
    expect(router.route({ task: "chat", mode: "general" })).toMatchObject({
      ok: true,
      providers: ["openai", "anthropic"],
    });
  });

  it("treats a zero promotional balance as hard exhaustion without inventing token limits", () => {
    const router = makeRouter();
    router.quotas.update("openai", { classification: "metered", promotionalBalanceUsd: 0 });
    expect(router.quotas.status("openai")).toMatchObject({ hardExhausted: true, remainingFraction: null });
    expect(router.route({ task: "chat", mode: "general" })).toMatchObject({ providers: ["anthropic"] });
  });
});
