import type { ProviderId } from "@dash-ai/contracts";
import { describe, expect, it } from "vitest";
import { ConfigError, configWarnings, loadConfig } from "../src/config.js";
import { DEFAULT_POLICY, loadPolicy, type ProviderProfile, type RouterPolicy } from "../src/intelligence/policy.js";
import { QuotaTracker, type ProviderQuotas } from "../src/intelligence/quota.js";
import { IntelligenceRouter, privacyAllows, type RouteRequest, type RoutingControls } from "../src/intelligence/router.js";
import { dayStart, monthStart, SpendGuard } from "../src/intelligence/spend.js";
import { OpenAICompatibleAdapter } from "../src/providers/compatible.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { failoverAllowed, retryAfterFrom, toProviderError } from "../src/providers/types.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import type { InferenceAttemptRow } from "../src/store/store.js";

// The provider platform below the HTTP layer: open provider ids and profiles, the router's new hard
// filters (privacy, pools, spend, per-request cost, quota, suitability), free-first ordering, quotas,
// the spend breaker, provider error signals and configuration. No network.

const profile = (over: Partial<ProviderProfile> = {}): ProviderProfile => ({
  enabled: true,
  capabilities: ["text", "long_context", "tool_use"],
  contextTokens: 128_000,
  costPerMillionInput: null,
  costPerMillionOutput: null,
  quality: { default: 0.8 },
  privacy: "approved_sensitive",
  pricing: "paid",
  tasks: null,
  plans: null,
  inputModalities: ["text"],
  outputModalities: ["text"],
  streaming: true,
  ...over,
});

/** A policy with a paid primary ("paidco"), a free pool provider ("freeco") and a promotional one ("promoco"). */
const POLICY: RouterPolicy = {
  ...DEFAULT_POLICY,
  providers: {
    paidco: profile({ quality: { default: 0.9 } }),
    freeco: profile({ pricing: "free", privacy: "non_sensitive_only", quality: { default: 0.75 }, costPerMillionInput: 0, costPerMillionOutput: 0 }),
    promoco: profile({ pricing: "promotional", privacy: "unapproved", quality: { default: 0.85 } }),
  },
};

const OPEN: RoutingControls = { aiEnabled: true, freePoolEnabled: true, paidProvidersEnabled: true, demo: new Set() };

function setup(options: { configured?: string[]; policy?: RouterPolicy; controls?: Partial<RoutingControls>; quotas?: ProviderQuotas } = {}) {
  const clock = { t: Date.parse("2026-10-10T12:00:30Z") };
  const quota = new QuotaTracker(options.quotas ?? {}, () => clock.t);
  const configured = new Set<ProviderId>(options.configured ?? ["paidco", "freeco", "promoco"]);
  const router = new IntelligenceRouter(options.policy ?? POLICY, () => configured, () => clock.t, {
    quota,
    controls: () => ({ ...OPEN, ...options.controls }),
  });
  const route = (r: Partial<RouteRequest> = {}) => router.route({ task: "chat", mode: "general", ...r });
  return { router, quota, clock, route };
}

const rejected = (d: ReturnType<IntelligenceRouter["route"]>, provider: string) => d.rejected.find((r) => r.provider === provider)?.reason;

describe("open provider ids and profiles", () => {
  it("built-in providers keep their defaults; a registered provider joins the policy and stays unapproved until approved", () => {
    expect(DEFAULT_POLICY.providers.openai).toMatchObject({ privacy: "approved_sensitive", pricing: "paid", streaming: true, tasks: null });
    const policy = loadPolicy(undefined, { "example-free": profile({ privacy: "unapproved", pricing: "free" }) });
    expect(Object.keys(policy.providers)).toEqual(["openai", "anthropic", "bedrock", "example-free"]);
    // An operator approves it individually; fields not written keep their values.
    const approved = loadPolicy(JSON.stringify({ providers: { "example-free": { privacy: "non_sensitive_only" } } }), {
      "example-free": profile({ privacy: "unapproved", pricing: "free" }),
    });
    expect(approved.providers["example-free"]).toMatchObject({ privacy: "non_sensitive_only", pricing: "free", enabled: true });
  });

  it("privacy classes: unapproved receives nothing, non-sensitive-only never receives sensitive content", () => {
    expect(privacyAllows("approved_sensitive", "sensitive")).toBe(true);
    expect(privacyAllows("non_sensitive_only", "standard")).toBe(true);
    expect(privacyAllows("non_sensitive_only", "sensitive")).toBe(false);
    expect(privacyAllows("unapproved", "standard")).toBe(false);
    expect(privacyAllows("unapproved", "sensitive")).toBe(false);
  });
});

describe("router: hard requirements before any score", () => {
  it("a sensitive request (the default) is never routed to a provider not approved for it, even if it is the only one", () => {
    const { route } = setup({ configured: ["freeco", "promoco"] });
    const d = route();
    expect(d).toMatchObject({ ok: false, reason: "privacy_unavailable" });
    expect(rejected(d, "freeco")).toBe("privacy");
    expect(rejected(d, "promoco")).toBe("privacy");
    // Classified as standard, the non-sensitive-only provider may serve it; the unapproved one still may not.
    const standard = route({ sensitivity: "standard" });
    expect(standard).toMatchObject({ ok: true, providers: ["freeco"] });
    expect(rejected(standard, "promoco")).toBe("privacy");
  });

  it("a free provider goes first only when it clears the free-pool bars; price never outranks suitability", () => {
    const { route, router } = setup();
    // Suitable (standard content, quality 0.75 ≥ 0.7, healthy): ahead of the better-scoring paid provider.
    expect(route({ sensitivity: "standard" })).toMatchObject({ ok: true, providers: ["freeco", "paidco"] });
    // Sensitive content: the free provider is not even eligible.
    expect(route()).toMatchObject({ ok: true, providers: ["paidco"] });
    // Below the quality bar on this route: no preference, the score decides.
    const lowQuality = setup({ policy: { ...POLICY, providers: { ...POLICY.providers, freeco: profile({ ...POLICY.providers.freeco, quality: { default: 0.6 } }) } } });
    expect(lowQuality.route({ sensitivity: "standard" })).toMatchObject({ providers: ["paidco", "freeco"] });
    // Unreliable lately: no preference either.
    for (let i = 0; i < 2; i++) router.recordFailure("freeco", "provider_error", false);
    expect(route({ sensitivity: "standard" })).toMatchObject({ providers: ["paidco", "freeco"] });
    // Operators can switch the preference off.
    const off = setup({ policy: { ...POLICY, freePool: { ...POLICY.freePool, preferFree: false } } });
    expect(off.route({ sensitivity: "standard" })).toMatchObject({ providers: ["paidco", "freeco"] });
  });

  it("pool switches: the free pool or paid providers can be switched off; demonstration adapters are exempt", () => {
    expect(rejected(setup({ controls: { freePoolEnabled: false } }).route({ sensitivity: "standard" }), "freeco")).toBe("pricing_disabled");
    const noPaid = setup({ controls: { paidProvidersEnabled: false } }).route({ sensitivity: "standard" });
    expect(noPaid).toMatchObject({ ok: true, providers: ["freeco"] });
    expect(rejected(noPaid, "paidco")).toBe("pricing_disabled");
    expect(setup({ controls: { paidProvidersEnabled: false }, configured: ["paidco"] }).route()).toMatchObject({ ok: false, reason: "no_provider" });
    // Demonstration adapters (fake mode) never send content anywhere: pools, spend and privacy do not apply.
    const demo = setup({ configured: ["promoco"], controls: { paidProvidersEnabled: false, freePoolEnabled: false, demo: new Set(["promoco"]) } });
    expect(demo.route({ paidAllowed: false, maxCostUsd: 0 })).toMatchObject({ ok: true, providers: ["promoco"] });
  });

  it("AI_ENABLED=false refuses everything", () => {
    expect(setup({ controls: { aiEnabled: false } }).route()).toMatchObject({ ok: false, reason: "ai_disabled" });
  });

  it("disabled, not configured, task, plan and modality suitability", () => {
    const policy = {
      ...POLICY,
      providers: {
        ...POLICY.providers,
        paidco: profile({ quality: { default: 0.9 }, tasks: ["automation"] }),
        freeco: profile({ ...POLICY.providers.freeco, plans: ["pro"] }),
        promoco: profile({ enabled: false }),
      },
    };
    const { route } = setup({ policy, configured: ["paidco", "freeco", "promoco"] });
    const d = route({ sensitivity: "standard", plan: "standard" });
    expect(d).toMatchObject({ ok: false, reason: "capability_unavailable" });
    expect([rejected(d, "paidco"), rejected(d, "freeco"), rejected(d, "promoco")]).toEqual(["task", "plan", "disabled"]);
    expect(route({ sensitivity: "standard", plan: "pro" })).toMatchObject({ ok: true, providers: ["freeco"] });
    expect(route({ task: "automation" })).toMatchObject({ ok: true, providers: ["paidco"] });
    const image = setup().route({ inputModalities: ["text", "image"] });
    expect(image).toMatchObject({ ok: false, reason: "capability_unavailable" });
    expect(rejected(image, "paidco")).toBe("modality");
    expect(rejected(setup({ configured: ["freeco"] }).route(), "paidco")).toBe("not_configured");
  });

  it("spend limits stop paid providers only; free providers can still serve suitable requests", () => {
    const { route } = setup();
    const blocked = route({ paidAllowed: false });
    expect(blocked).toMatchObject({ ok: false, reason: "limit_reached" });
    expect(rejected(blocked, "paidco")).toBe("spend_limit");
    expect(route({ paidAllowed: false, sensitivity: "standard" })).toMatchObject({ ok: true, providers: ["freeco"] });
  });

  it("per-request ceiling: a paid provider whose worst case exceeds it, or whose price is unknown, is not used", () => {
    const { route } = setup();
    expect(route({ maxCostUsd: 0.05, worstCaseCostUsd: () => 0.01 })).toMatchObject({ ok: true, providers: ["paidco"] });
    const tooDear = route({ maxCostUsd: 0.05, worstCaseCostUsd: () => 0.2 });
    expect(tooDear).toMatchObject({ ok: false, reason: "limit_reached" });
    expect(rejected(tooDear, "paidco")).toBe("cost_limit");
    expect(rejected(route({ maxCostUsd: 0.05, worstCaseCostUsd: () => null }), "paidco")).toBe("cost_limit");
    // Free providers are not subject to the paid ceiling.
    expect(route({ maxCostUsd: 0, worstCaseCostUsd: () => null, sensitivity: "standard" })).toMatchObject({ ok: true, providers: ["freeco"] });
  });

  it("quota: exhausted or paused providers are skipped, one approaching its limit goes behind the others, and it recovers", () => {
    const quotas: ProviderQuotas = { paidco: { windows: [{ type: "requests_per_minute", limit: 10 }], softThreshold: 0.8 } };
    const { route, quota, clock } = setup({ quotas, configured: ["paidco", "freeco"], policy: { ...POLICY, providers: { ...POLICY.providers, freeco: profile({ quality: { default: 0.7 } }) } } });
    expect(route()).toMatchObject({ providers: ["paidco", "freeco"] });
    for (let i = 0; i < 8; i++) quota.record("paidco", { requests: 1, tokens: 100, costUsd: 0 });
    // Approaching the limit (8/10 ≥ 80 %): still eligible, but behind the healthy one.
    expect(route()).toMatchObject({ ok: true, providers: ["freeco", "paidco"] });
    for (let i = 0; i < 2; i++) quota.record("paidco", { requests: 1, tokens: 100, costUsd: 0 });
    const exhausted = route();
    expect(exhausted).toMatchObject({ ok: true, providers: ["freeco"] });
    expect(rejected(exhausted, "paidco")).toBe("quota");
    // Next minute: the window resets and the provider is first again.
    clock.t += 60_000;
    expect(route()).toMatchObject({ providers: ["paidco", "freeco"] });
    // Temporarily disabled by the provider's own answer, then back after the pause.
    quota.pause("paidco", 30_000, "quota_exhausted");
    expect(rejected(route(), "paidco")).toBe("paused");
    expect(setup({ configured: ["paidco"] }).route()).toMatchObject({ ok: true });
    clock.t += 30_001;
    expect(route()).toMatchObject({ providers: ["paidco", "freeco"] });
  });

  it("when every suitable provider is out of quota the reason says so", () => {
    const { route, quota } = setup({ configured: ["paidco"], quotas: { paidco: { windows: [{ type: "requests_per_day", limit: 1 }], softThreshold: 0.9 } } });
    quota.record("paidco", { requests: 1, tokens: 1, costUsd: 0 });
    expect(route()).toMatchObject({ ok: false, reason: "quota_exhausted" });
  });

  it("the circuit breaker still moves a failing provider to the back, and success closes it", () => {
    const { route, router } = setup({ configured: ["paidco", "freeco"], policy: { ...POLICY, providers: { ...POLICY.providers, freeco: profile({ quality: { default: 0.7 } }) } } });
    for (let i = 0; i < 3; i++) router.recordFailure("paidco", "provider_error", true);
    expect(route()).toMatchObject({ providers: ["freeco", "paidco"] });
    router.recordSuccess("paidco", 100);
    expect(route()).toMatchObject({ providers: ["paidco", "freeco"] });
  });
});

describe("quota windows", () => {
  const at = (iso: string) => Date.parse(iso);

  it("tracks requests and tokens per minute, day and month, with reset times", () => {
    const clock = { t: at("2026-10-31T23:59:30Z") };
    const q = new QuotaTracker(
      {
        p: {
          windows: [
            { type: "requests_per_minute", limit: 2 },
            { type: "tokens_per_day", limit: 1_000 },
            { type: "tokens_per_month", limit: 5_000 },
          ],
          softThreshold: 0.9,
        },
      },
      () => clock.t,
    );
    q.record("p", { requests: 1, tokens: 400, costUsd: 0 });
    const s = q.status("p");
    expect(s.state).toBe("ok");
    expect(s.windows.map((w) => [w.type, w.used, w.remaining, w.resetsAt])).toEqual([
      ["requests_per_minute", 1, 1, "2026-11-01T00:00:00.000Z"],
      ["tokens_per_day", 400, 600, "2026-11-01T00:00:00.000Z"],
      ["tokens_per_month", 400, 4_600, "2026-11-01T00:00:00.000Z"],
    ]);
    q.record("p", { requests: 1, tokens: 500, costUsd: 0 });
    expect(q.status("p").state).toBe("exhausted"); // 2/2 requests this minute
    clock.t = at("2026-11-01T00:00:10Z"); // a new minute, day and month
    expect(q.status("p")).toMatchObject({ state: "ok", windows: [{ used: 0 }, { used: 0 }, { used: 0 }] });
  });

  it("promotional balances (USD or tokens) run down, never reset, and end at expiry", () => {
    const clock = { t: at("2026-10-10T00:00:00Z") };
    const q = new QuotaTracker(
      {
        usd: { windows: [{ type: "promotional_balance", limit: 10, unit: "usd", expiresAt: "2026-12-31T00:00:00Z" }], softThreshold: 0.9 },
        tokens: { windows: [{ type: "promotional_balance", limit: 1_000_000, unit: "tokens" }], softThreshold: 0.5 },
      },
      () => clock.t,
    );
    q.record("usd", { requests: 1, tokens: 5, costUsd: 9.5 });
    expect(q.status("usd")).toMatchObject({ state: "soft", windows: [{ used: 9.5, remaining: 0.5, resetsAt: null }] });
    q.record("tokens", { requests: 1, tokens: 600_000, costUsd: 0 });
    expect(q.status("tokens").state).toBe("soft");
    clock.t = at("2027-01-01T00:00:00Z");
    expect(q.status("usd")).toMatchObject({ state: "exhausted", windows: [{ remaining: 0 }] });
  });

  it("unknown and unlimited quotas are never exhausted by DASH's own counting; pauses are bounded; seeding restores usage", () => {
    const clock = { t: at("2026-10-10T00:00:00Z") };
    const q = new QuotaTracker(
      { u: { windows: [{ type: "unknown" }], softThreshold: 0.9 }, c: { windows: [{ type: "unlimited" }], softThreshold: 0.9 }, d: { windows: [{ type: "requests_per_day", limit: 100 }], softThreshold: 0.9 } },
      () => clock.t,
    );
    for (let i = 0; i < 1_000; i++) q.record("u", { requests: 1, tokens: 1_000, costUsd: 1 });
    expect(q.status("u").state).toBe("unknown");
    expect(q.status("c").state).toBe("unlimited");
    expect(q.status("not-configured").state).toBe("unknown");
    q.pause("c", 10 * 24 * 60 * 60 * 1000, "quota_exhausted");
    expect(Date.parse(q.status("c").pausedUntil!) - clock.t).toBe(24 * 60 * 60 * 1000);
    q.seed("d", () => 95);
    expect(q.status("d")).toMatchObject({ state: "soft", windows: [{ used: 95, remaining: 5 }] });
  });
});

describe("spend circuit breaker", () => {
  const row = (over: Partial<InferenceAttemptRow>): InferenceAttemptRow => ({
    id: Math.random().toString(36).slice(2),
    inferenceId: "inference-1",
    userId: null,
    plan: "standard",
    task: "chat",
    mode: "general",
    provider: "paidco",
    model: "m",
    configuredModel: "m",
    pricing: "paid",
    createdAt: "2026-10-10T10:00:00.000Z",
    latencyMs: 10,
    outcome: "success",
    errorCode: null,
    httpStatus: null,
    retry: 0,
    round: 0,
    fallbackIndex: 0,
    inputTokens: 10,
    outputTokens: 10,
    cachedInputTokens: null,
    estimatedInputTokens: 10,
    estimatedOutputTokens: 10,
    tokenSource: "provider",
    estimatedCostUsd: 1,
    providerCostUsd: null,
    currency: "USD",
    route: {},
    ...over,
  });
  const limits = (over: Partial<ReturnType<typeof loadConfig>["ai"]["limits"]> = {}) => ({
    ...loadConfig({}).ai,
    limits: { requestUsd: null, userDailyUsd: null, systemDailyUsd: null, systemMonthlyUsd: null, planDailyUsd: {}, ...over },
  });
  const now = () => Date.parse("2026-10-10T12:00:00Z");

  it("system daily and monthly limits; only paid spend counts; the provider's own cost is preferred", async () => {
    const store = new MemoryStore();
    await store.recordInferenceAttempt(row({ estimatedCostUsd: 3 }));
    await store.recordInferenceAttempt(row({ estimatedCostUsd: 2, providerCostUsd: 4 })); // provider-reported wins
    await store.recordInferenceAttempt(row({ pricing: "free", estimatedCostUsd: 100 }));
    await store.recordInferenceAttempt(row({ pricing: "demo", estimatedCostUsd: 0 }));
    await store.recordInferenceAttempt(row({ createdAt: "2026-10-09T23:00:00.000Z", estimatedCostUsd: 5 })); // yesterday, same month
    expect(dayStart(now())).toBe("2026-10-10T00:00:00.000Z");
    expect(monthStart(now())).toBe("2026-10-01T00:00:00.000Z");
    const ok = await new SpendGuard(store, limits({ systemDailyUsd: 7.5, systemMonthlyUsd: 100 }), now).check({ userId: null, plan: "standard" });
    expect(ok).toMatchObject({ paidAllowed: true, blockedBy: null, totals: { systemDailyUsd: 7, systemMonthlyUsd: 12 } });
    expect(await new SpendGuard(store, limits({ systemDailyUsd: 7 }), now).check({ userId: null, plan: "standard" })).toMatchObject({ paidAllowed: false, blockedBy: "system_daily" });
    expect(await new SpendGuard(store, limits({ systemMonthlyUsd: 12 }), now).check({ userId: null, plan: "standard" })).toMatchObject({ paidAllowed: false, blockedBy: "system_monthly" });
  });

  it("per-account and per-plan daily limits", async () => {
    const store = new MemoryStore();
    await store.recordInferenceAttempt(row({ userId: "user-a", estimatedCostUsd: 0.5 }));
    await store.recordInferenceAttempt(row({ userId: "user-b", plan: "pro", estimatedCostUsd: 3 }));
    const guard = new SpendGuard(store, limits({ userDailyUsd: 0.5, planDailyUsd: { pro: 3 } }), now);
    expect(await guard.check({ userId: "user-a", plan: "standard" })).toMatchObject({ paidAllowed: false, blockedBy: "user_daily" });
    expect(await guard.check({ userId: "user-c", plan: "standard" })).toMatchObject({ paidAllowed: true });
    expect(await guard.check({ userId: "user-c", plan: "pro" })).toMatchObject({ paidAllowed: false, blockedBy: "plan_daily" });
  });
});

describe("provider error signals", () => {
  it("reads Retry-After (seconds, date or milliseconds), bounded", () => {
    const now = Date.parse("2026-10-10T12:00:00Z");
    expect(retryAfterFrom(new Headers({ "retry-after": "30" }), now)).toBe(30_000);
    expect(retryAfterFrom({ "retry-after-ms": "1500" }, now)).toBe(1_500);
    expect(retryAfterFrom(new Headers({ "retry-after": "Sat, 10 Oct 2026 12:01:00 GMT" }), now)).toBe(60_000);
    expect(retryAfterFrom(new Headers({ "retry-after": "99999999" }), now)).toBe(24 * 60 * 60 * 1000);
    expect(retryAfterFrom(undefined, now)).toBeUndefined();
  });

  it("429 is a retryable rate limit carrying Retry-After; an exhausted quota is not retried but may fail over", () => {
    const limited = toProviderError("P", { name: "APIError", status: 429, headers: new Headers({ "retry-after": "20" }) });
    expect(limited).toMatchObject({ code: "rate_limited", retryable: true, retryAfterMs: 20_000, quotaExhausted: false });
    const quota = toProviderError("P", { name: "APIError", status: 429, code: "insufficient_quota" });
    expect(quota).toMatchObject({ code: "rate_limited", retryable: false, quotaExhausted: true });
    expect(failoverAllowed(quota)).toBe(true);
    expect(toProviderError("P", { name: "APIError", status: 429, error: { error: { type: "quota_exceeded" } } })).toMatchObject({ quotaExhausted: true });
    expect(toProviderError("P", { name: "APIError", status: 503 })).toMatchObject({ code: "provider_error", retryable: true });
  });
});

describe("configuration: compatible providers, quotas and cost controls", () => {
  const ENTRY = {
    id: "example-free",
    baseUrl: "https://inference.example.test/v1",
    apiKeyEnv: "EXAMPLE_FREE_API_KEY",
    model: "example-model",
    contextTokens: 32_000,
    pricing: "free",
    privacy: "non_sensitive_only",
    inputPerMillion: 0,
    outputPerMillion: 0,
    quota: { windows: [{ type: "requests_per_day", limit: 1_000 }] },
  };
  const KEY = "test-example-key-not-real";
  const cfg = (entries: unknown[], env: Record<string, string> = {}) =>
    loadConfig({ PROVIDER_MODE: "live", COMPATIBLE_PROVIDERS: JSON.stringify(entries), EXAMPLE_FREE_API_KEY: KEY, ...env });

  it("registers a compatible provider: key from its own variable, profile, price and quota", () => {
    const config = cfg([ENTRY]);
    expect(config.compatibleProviders[0]).toMatchObject({ id: "example-free", apiKey: KEY, privacy: "non_sensitive_only", pricing: "free" });
    expect(config.routerPolicy.providers["example-free"]).toMatchObject({ pricing: "free", privacy: "non_sensitive_only", contextTokens: 32_000, quality: { default: 0.7 } });
    expect(config.modelPrices["example-free:example-model"]).toEqual({ inputPerMillion: 0, outputPerMillion: 0 });
    expect(config.providerQuotas["example-free"]).toMatchObject({ windows: [{ type: "requests_per_day", limit: 1_000 }], softThreshold: 0.9 });
    const registry = ProviderRegistry.fromConfig(config);
    expect(registry.get("example-free")).toBeInstanceOf(OpenAICompatibleAdapter);
    expect(registry.status().map((s) => s.id)).toEqual(["openai", "anthropic", "bedrock", "example-free"]);
    expect(JSON.stringify(registry.status())).not.toContain(KEY);
  });

  it("defaults to unapproved, and stays off without its key", () => {
    const { privacy, ...rest } = ENTRY;
    void privacy;
    const unapproved = ProviderRegistry.fromConfig(cfg([rest]));
    expect(unapproved.warnings).toContain('Compatible provider "example-free" is unapproved: it receives no requests until approved.');
    const noKey = ProviderRegistry.fromConfig(loadConfig({ PROVIDER_MODE: "live", COMPATIBLE_PROVIDERS: JSON.stringify([ENTRY]) }));
    expect(noKey.get("example-free")).toBeUndefined();
    expect(noKey.warnings.join(" ")).toMatch(/EXAMPLE_FREE_API_KEY is not set/);
    // Fake mode keeps the two demonstration adapters only.
    expect(ProviderRegistry.fromConfig(cfg([ENTRY], { PROVIDER_MODE: "fake" })).get("example-free")).toBeUndefined();
  });

  it("refuses unsafe or malformed entries, naming fields only", () => {
    const refuse = (entries: unknown[], env: Record<string, string> = {}): string => {
      try {
        cfg(entries, env);
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        return (err as Error).message;
      }
      throw new Error("expected a ConfigError");
    };
    expect(refuse([{ ...ENTRY, id: "openai" }])).toMatch(/must not reuse a built-in provider id/);
    expect(refuse([{ ...ENTRY, apiKeyEnv: "DATA_ENCRYPTION_KEY" }])).toMatch(/apiKeyEnv/);
    expect(refuse([{ ...ENTRY, apiKeyEnv: "OPENAI_API_KEY" }])).toMatch(/names one of DASH's own settings/);
    expect(refuse([{ ...ENTRY, baseUrl: "http://inference.example.test/v1" }])).toMatch(/must use https/);
    expect(refuse([{ ...ENTRY, baseUrl: "https://user:secret@inference.example.test/v1" }])).toMatch(/must not contain credentials/);
    expect(refuse([ENTRY, ENTRY])).toMatch(/unique/);
    expect(refuse([{ ...ENTRY, privacy: "trusted" }])).toMatch(/privacy/);
    expect(refuse([{ ...ENTRY, apiKey: "SECRETVALUE" }])).not.toContain("SECRETVALUE");
    expect(() => cfg([{ ...ENTRY, baseUrl: "http://localhost:8080/v1" }])).not.toThrow();
    expect(refuse([], { PROVIDER_QUOTAS: '{"p":{"windows":[{"type":"requests_per_week","limit":1}]}}' })).toMatch(/PROVIDER_QUOTAS is invalid/);
    expect(refuse([], { AI_PLAN_DAILY_SPEND: '{"Pro":1}' })).toMatch(/AI_PLAN_DAILY_SPEND is invalid/);
    expect(refuse([], { COMPATIBLE_PROVIDERS: "{not json" })).toMatch(/COMPATIBLE_PROVIDERS is not valid JSON/);
  });

  it("safe defaults when the new variables are absent", () => {
    const c = loadConfig({});
    expect(c.ai).toEqual({
      enabled: true,
      freePoolEnabled: false,
      paidProvidersEnabled: true,
      bedrockEnabled: false,
      defaultPlan: "standard",
      defaultSensitivity: "sensitive",
      limits: { requestUsd: null, userDailyUsd: null, systemDailyUsd: null, systemMonthlyUsd: null, planDailyUsd: {} },
    });
    expect(c.routerPolicy.providers.bedrock?.enabled).toBe(false);
    expect(c.compatibleProviders).toEqual([]);
    // Production in fake mode (today's production) starts unchanged with none of them set.
    expect(() => loadConfig({ NODE_ENV: "production", PROVIDER_MODE: "fake" })).not.toThrow();
  });

  it("production with paid providers requires daily and monthly limits and a price for every paid model", () => {
    const prod = (env: Record<string, string>) => {
      try {
        loadConfig({ NODE_ENV: "production", PROVIDER_MODE: "live", ...env });
        return "";
      } catch (err) {
        return (err as Error).message;
      }
    };
    const openai = { OPENAI_API_KEY: "test-openai-key-not-real", OPENAI_MODEL: "test-openai-model" };
    expect(prod(openai)).toMatch(/MAX_DAILY_AI_SPEND and MAX_MONTHLY_AI_SPEND are required/);
    expect(prod(openai)).toMatch(/OPENAI_MODEL has no price/);
    expect(prod({ ...openai, MAX_DAILY_AI_SPEND: "5", MAX_MONTHLY_AI_SPEND: "100", MODEL_PRICES: '{"openai:test-openai":{"inputPerMillion":1,"outputPerMillion":4}}' })).toBe("");
    // With paid providers switched off nothing paid can run, so no limits are needed (a free provider serves).
    expect(prod({ ...openai, PAID_PROVIDERS_ENABLED: "false" })).toBe("");
    // A free approved compatible provider alone needs neither.
    expect(prod({ COMPATIBLE_PROVIDERS: JSON.stringify([ENTRY]), EXAMPLE_FREE_API_KEY: KEY, FREE_POOL_ENABLED: "true" })).toBe("");
    // An unapproved one does not count as a live provider; a missing key is named.
    expect(prod({ COMPATIBLE_PROVIDERS: JSON.stringify([{ ...ENTRY, privacy: "unapproved" }]), EXAMPLE_FREE_API_KEY: KEY })).toMatch(/No AI provider is configured/);
    expect(prod({ COMPATIBLE_PROVIDERS: JSON.stringify([ENTRY]) })).toMatch(/EXAMPLE_FREE_API_KEY is required for the compatible provider "example-free"/);
    // Bedrock settings without BEDROCK_ENABLED do not count either.
    expect(prod({ BEDROCK_AUTH: "iam", BEDROCK_REGION: "eu-west-1", BEDROCK_MODEL_LITE: "eu.amazon.nova-lite-v1:0" })).toMatch(/BEDROCK_ENABLED=true/);
    // Never a key value in the message.
    expect(prod(openai)).not.toContain("test-openai-key-not-real");
  });

  it("BEDROCK_ENABLED switches Bedrock; the deprecated BEDROCK_FALLBACK_ENABLED still works and may never disagree", () => {
    const bedrock = (env: Record<string, string>) => {
      const config = loadConfig({ PROVIDER_MODE: "live", ...env });
      return { enabled: config.ai.bedrockEnabled, routed: config.routerPolicy.providers.bedrock?.enabled, warnings: configWarnings(config) };
    };
    // Off by default, and the router then never sends Bedrock anything.
    expect(bedrock({})).toEqual({ enabled: false, routed: false, warnings: [] });
    expect(bedrock({ BEDROCK_ENABLED: "" })).toEqual({ enabled: false, routed: false, warnings: [] });
    expect(bedrock({ BEDROCK_ENABLED: "true" })).toEqual({ enabled: true, routed: true, warnings: [] });
    expect(bedrock({ BEDROCK_ENABLED: "false" })).toMatchObject({ enabled: false, routed: false });

    // The former name alone keeps working, with a warning to rename it (in every environment).
    const legacy = bedrock({ BEDROCK_FALLBACK_ENABLED: "true" });
    expect(legacy).toMatchObject({ enabled: true, routed: true });
    expect(legacy.warnings).toEqual(["BEDROCK_FALLBACK_ENABLED is deprecated: rename it to BEDROCK_ENABLED (same value, true)."]);
    expect(bedrock({ BEDROCK_FALLBACK_ENABLED: "false" })).toMatchObject({ enabled: false, routed: false });
    // Both set to the same value: fine, with a warning to remove the old one.
    expect(bedrock({ BEDROCK_ENABLED: "true", BEDROCK_FALLBACK_ENABLED: "true" }).warnings).toEqual([
      "BEDROCK_FALLBACK_ENABLED is deprecated and set to the same value as BEDROCK_ENABLED: remove it.",
    ]);
    expect(bedrock({ BEDROCK_ENABLED: "false", BEDROCK_FALLBACK_ENABLED: "false" })).toMatchObject({ enabled: false, routed: false });

    // Disagreeing values refuse to start, either way round: no silent precedence.
    for (const [current, deprecated] of [["true", "false"], ["false", "true"]] as const) {
      expect(() => loadConfig({ BEDROCK_ENABLED: current, BEDROCK_FALLBACK_ENABLED: deprecated })).toThrow(ConfigError);
      expect(() => loadConfig({ BEDROCK_ENABLED: current, BEDROCK_FALLBACK_ENABLED: deprecated })).toThrow(
        `BEDROCK_ENABLED=${current} and the deprecated BEDROCK_FALLBACK_ENABLED=${deprecated} disagree`,
      );
    }
    // Anything but true or false is refused as before.
    expect(() => loadConfig({ BEDROCK_ENABLED: "yes" })).toThrow(ConfigError);
    expect(() => loadConfig({ BEDROCK_FALLBACK_ENABLED: "1" })).toThrow(ConfigError);

    // In production the deprecation is logged with the other warnings.
    const prod = loadConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://placeholder",
      RATE_LIMIT_BACKEND: "redis",
      REDIS_URL: "rediss://placeholder",
      PROVIDER_MODE: "fake",
      BEDROCK_FALLBACK_ENABLED: "false",
      DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    });
    expect(configWarnings(prod)).toContain("BEDROCK_FALLBACK_ENABLED is deprecated: rename it to BEDROCK_ENABLED (same value, false).");
  });

  it("production warnings still name single-provider setups (compatible providers count)", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://placeholder",
      RATE_LIMIT_BACKEND: "redis",
      REDIS_URL: "rediss://placeholder",
      PROVIDER_MODE: "live",
      COMPATIBLE_PROVIDERS: JSON.stringify([ENTRY]),
      EXAMPLE_FREE_API_KEY: KEY,
      FREE_POOL_ENABLED: "true",
    });
    expect(configWarnings(config).join(" ")).toMatch(/Only one AI provider is configured/);
  });
});
