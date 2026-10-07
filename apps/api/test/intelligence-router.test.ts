import { AssistantMode, SMART_ROUTING, type ProviderId } from "@dash-ai/contracts";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import { DEFAULT_POLICY, loadPolicy, PolicyError, TaskType } from "../src/intelligence/policy.js";
import { IntelligenceRouter } from "../src/intelligence/router.js";
import { chatBody, makeApp, register, sse, spyRegistry, testConfig } from "./helpers.js";

const both = new Set<ProviderId>(["openai", "anthropic"]);
const router = (configured: ReadonlySet<ProviderId> = both, policy = DEFAULT_POLICY, clock = { t: 1_000_000 }) =>
  new IntelligenceRouter(policy, () => configured, () => clock.t);

describe("DASH Intelligence Router", () => {
  it("routes chat exactly like the shared preference table while every provider is healthy", () => {
    const r = router();
    for (const mode of AssistantMode.options) {
      const d = r.route({ task: "chat", mode });
      expect(d.ok && d.providers, mode).toEqual(SMART_ROUTING[mode]);
    }
  });

  it("uses whatever is configured, and says so when nothing is", () => {
    expect(router(new Set(["anthropic"])).route({ task: "chat", mode: "general" })).toMatchObject({ ok: true, providers: ["anthropic"] });
    expect(router(new Set()).route({ task: "chat", mode: "general" })).toMatchObject({ ok: false, reason: "no_provider" });
  });

  it("applies a provider the person named as a silent preference, only when eligible", () => {
    const r = router();
    expect(r.route({ task: "chat", mode: "general", hint: "anthropic" })).toMatchObject({ providers: ["anthropic", "openai"] });
    expect(router(new Set(["openai"])).route({ task: "chat", mode: "general", hint: "anthropic" })).toMatchObject({ providers: ["openai"] });
  });

  it("refuses capabilities no provider has instead of faking them (graphics, voice)", () => {
    const r = router();
    expect(r.route({ task: "graphics" })).toMatchObject({ ok: false, reason: "capability_unavailable" });
    expect(r.route({ task: "voice" })).toMatchObject({ ok: false, reason: "capability_unavailable" });
    expect(r.route({ task: "chat", mode: "general", requires: ["vision"] })).toMatchObject({ ok: false, reason: "capability_unavailable" });
    expect(r.route({ task: "tools" })).toMatchObject({ ok: true });
  });

  it("routes every task through one router (no task is special-cased in code)", () => {
    const r = router();
    for (const task of TaskType.options) {
      const d = r.route({ task });
      expect(d.routeKey, task).toBe(task);
    }
    // Automations inherit their mode's chat preference unless the policy says otherwise.
    expect(r.route({ task: "automation", mode: "writing" })).toMatchObject({ providers: SMART_ROUTING.writing });
  });

  it("respects context limits per provider", () => {
    const r = router();
    // Larger than the first provider's context but within the second's.
    expect(r.route({ task: "chat", mode: "general", estimatedInputTokens: 150_000 })).toMatchObject({
      ok: true,
      providers: ["anthropic"],
      rejected: [{ provider: "openai", reason: "context" }],
    });
    expect(r.route({ task: "chat", mode: "general", estimatedInputTokens: 500_000 })).toMatchObject({ ok: false, reason: "context_too_large" });
  });

  it("learns from failures: reliability reorders, an open circuit moves a provider to the back, and it comes back", () => {
    const clock = { t: 1_000_000 };
    const r = router(both, DEFAULT_POLICY, clock);
    r.recordFailure("openai", "provider_error", true);
    r.recordFailure("openai", "provider_error", true);
    // Two failures lower reliability enough to prefer the healthy provider for general chat.
    expect(r.route({ task: "chat", mode: "general" })).toMatchObject({ providers: ["anthropic", "openai"] });
    r.recordFailure("openai", "provider_timeout", true);
    const open = r.route({ task: "chat", mode: "general", hint: "openai" });
    // Circuit open: even the person's named preference goes behind a healthy provider, but stays as a fallback.
    expect(open).toMatchObject({ providers: ["anthropic", "openai"] });
    expect(open.ok && open.candidates[1]!.circuitOpen).toBe(true);
    clock.t += DEFAULT_POLICY.circuit.cooldownMs + 1;
    const later = r.route({ task: "chat", mode: "general" });
    expect(later.ok && later.candidates.every((c) => !c.circuitOpen)).toBe(true);
    for (let i = 0; i < 10; i++) r.recordSuccess("openai", 1_000);
    expect(r.route({ task: "chat", mode: "general" })).toMatchObject({ providers: ["openai", "anthropic"] });
  });

  it("ignores cancellations, and never opens the circuit on non-retryable failures", () => {
    const r = router();
    for (let i = 0; i < 10; i++) r.recordFailure("openai", "cancelled", false);
    expect(r.health.snapshot(["openai"])[0]).toMatchObject({ failures: 0, reliability: 1 });
    for (let i = 0; i < 5; i++) r.recordFailure("openai", "provider_error", false);
    expect(r.health.isOpen("openai")).toBe(false);
  });

  it("weighs latency and cost by preference", () => {
    const policy = loadPolicy(JSON.stringify({ providers: { openai: { costPerMillionInput: 4, costPerMillionOutput: 16 }, anthropic: { costPerMillionInput: 6, costPerMillionOutput: 30 } } }));
    const r = router(both, policy);
    // Writing prefers the second provider on quality; economy flips it to the cheaper one.
    expect(r.route({ task: "chat", mode: "writing" })).toMatchObject({ providers: ["anthropic", "openai"] });
    expect(r.route({ task: "chat", mode: "writing", preference: "economy" })).toMatchObject({ providers: ["openai", "anthropic"] });
    const fast = router();
    fast.recordSuccess("openai", 500);
    fast.recordSuccess("anthropic", 20_000);
    expect(fast.route({ task: "chat", mode: "writing", preference: "speed" })).toMatchObject({ providers: ["openai", "anthropic"] });
  });

  it("is configurable: an operator can disable a provider or change a route's quality", () => {
    const disabled = router(both, loadPolicy('{"providers":{"openai":{"enabled":false}}}'));
    expect(disabled.route({ task: "chat", mode: "general" })).toMatchObject({ providers: ["anthropic"], rejected: [{ provider: "openai", reason: "disabled" }] });
    const tuned = router(both, loadPolicy('{"providers":{"openai":{"quality":{"chat:writing":0.99}}}}'));
    expect(tuned.route({ task: "chat", mode: "writing" })).toMatchObject({ providers: ["openai", "anthropic"] });
    const images = router(both, loadPolicy('{"providers":{"openai":{"capabilities":["text","image_generation"]}}}'));
    expect(images.route({ task: "graphics" })).toMatchObject({ ok: true, providers: ["openai"] });
  });

  it("rejects a malformed policy at start-up without echoing it", () => {
    expect(() => loadPolicy("{not json")).toThrow(PolicyError);
    expect(() => loadPolicy('{"circuit":{"failureThreshold":0}}')).toThrow(/circuit.failureThreshold/);
    expect(() => loadConfig({ ROUTER_POLICY: '{"smoothing":"secret-value"}' })).toThrow(ConfigError);
    try {
      loadConfig({ ROUTER_POLICY: '{"smoothing":"secret-value"}' });
    } catch (err) {
      expect(String(err)).not.toContain("secret-value");
    }
  });
});

describe("chat through the router", () => {
  it("sends DASH AI chat to the healthy provider when the preferred one keeps failing", async () => {
    const { registry, spies } = spyRegistry();
    const { app, context } = await makeApp({ providers: registry });
    const user = await register(app);
    for (let i = 0; i < DEFAULT_POLICY.circuit.failureThreshold; i++) context.router.recordFailure("openai", "provider_error", true);
    const res = await app.inject({ method: "POST", url: "/v1/chat/stream", headers: user.auth, payload: chatBody({ modelChoice: "smart" }) });
    const start = sse(res.body).find((e) => e.event === "stream.start");
    expect(start?.event === "stream.start" && start.data.targets[0]).toMatchObject({ provider: "anthropic" });
    expect(spies.openai!.requests).toHaveLength(0);
    // The answer itself is recorded as a success for the provider that served it.
    expect(context.router.health.snapshot(["anthropic"])[0]).toMatchObject({ successes: 1 });
    await app.close();
  });

  it("gives the operator a router view and hides it from everyone else", async () => {
    const operator = "o".repeat(40);
    const { app } = await makeApp({ config: testConfig({ PROVIDER_DETAILS: "hidden", OPERATOR_TOKEN: operator }) });
    const user = await register(app);
    expect((await app.inject({ method: "GET", url: "/v1/router" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/v1/router", headers: user.auth })).statusCode).toBe(404);
    const res = await app.inject({ method: "GET", url: "/v1/router", headers: { authorization: `Bearer ${operator}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { routes: Record<string, unknown>; health: unknown[] };
    expect(Object.keys(body.routes).sort()).toEqual([...TaskType.options].sort());
    expect(body.routes.graphics).toMatchObject({ unavailable: "capability_unavailable" });
    expect(body.health).toHaveLength(2);
    await app.close();
  });
});
