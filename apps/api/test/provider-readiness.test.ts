import { ProvidersResponse, UsageSummaryResponse, ConversationDetailResponse, type StreamEvent } from "@dash-ai/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { AnthropicAdapter } from "../src/providers/anthropic.js";
import { OpenAIAdapter } from "../src/providers/openai.js";
import { looksLikePlaceholder, ProviderRegistry } from "../src/providers/registry.js";
import { chatBody, register, sse, testConfig } from "./helpers.js";
import { registryFor, scriptedProvider } from "./providerServer.js";

// Production providers are configured only through the environment (secrets), never in code. These
// tests use made-up keys and scripted provider servers behind the real SDKs: no network, no cost.
// Live verification against OpenAI and Anthropic still needs real keys (pnpm smoke:live / live-smoke.yml).

const OPENAI_KEY = "sk-proj-TESTONLY0000000000000000000000";
const ANTHROPIC_KEY = "sk-ant-api03-TESTONLY000000000000000000";

const liveEnv = (extra: Record<string, string> = {}) =>
  loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent", PROVIDER_MODE: "live", ...extra });

describe("provider configuration comes from the environment only", () => {
  it("both providers become live with the configured models; keys never appear in what clients see", () => {
    const registry = ProviderRegistry.fromConfig(
      liveEnv({ OPENAI_API_KEY: `${OPENAI_KEY}\n`, OPENAI_MODEL: "openai-model-from-env", ANTHROPIC_API_KEY: ` ${ANTHROPIC_KEY} `, ANTHROPIC_MODEL: "claude-model-from-env" }),
    );
    expect(registry.warnings).toEqual([]);
    expect(registry.get("openai")).toBeInstanceOf(OpenAIAdapter);
    expect(registry.get("anthropic")).toBeInstanceOf(AnthropicAdapter);
    expect(registry.status()).toEqual([
      { id: "openai", displayName: "OpenAI", configured: true, model: "openai-model-from-env", mode: "live" },
      { id: "anthropic", displayName: "Claude", configured: true, model: "claude-model-from-env", mode: "live" },
    ]);
    expect(JSON.stringify(registry.status())).not.toContain("TESTONLY");
  });

  it("a half-configured provider stays off with a warning that names the variable, never the value", () => {
    const registry = ProviderRegistry.fromConfig(liveEnv({ OPENAI_API_KEY: OPENAI_KEY, ANTHROPIC_MODEL: "claude-model" }));
    expect([...registry.configured()]).toEqual([]);
    expect(registry.warnings).toContain("OpenAI needs both OPENAI_API_KEY and OPENAI_MODEL.");
    expect(registry.warnings).toContain("Claude needs both ANTHROPIC_API_KEY and ANTHROPIC_MODEL.");
    expect(registry.warnings).toContain("No AI provider is configured. Chat requests will fail until one is configured.");
    expect(registry.warnings.join(" ")).not.toContain("TESTONLY");
  });

  it("one provider is enough to run; the other is reported as not configured", () => {
    const registry = ProviderRegistry.fromConfig(liveEnv({ ANTHROPIC_API_KEY: ANTHROPIC_KEY, ANTHROPIC_MODEL: "claude-model" }));
    expect([...registry.configured()]).toEqual(["anthropic"]);
    expect(registry.status().find((s) => s.id === "openai")).toMatchObject({ configured: false, mode: "unconfigured", model: null });
    expect(registry.warnings).toEqual([]);
  });

  it("values copied from an example are flagged at start-up", () => {
    for (const bad of ["your-api-key", "sk-...", "<OPENAI_API_KEY>", "changeme", "sk-proj abc defghijklmnopq", "short"]) {
      expect(looksLikePlaceholder(bad), bad).toBe(true);
    }
    expect(looksLikePlaceholder(OPENAI_KEY)).toBe(false);
    expect(looksLikePlaceholder(ANTHROPIC_KEY)).toBe(false);
    const registry = ProviderRegistry.fromConfig(liveEnv({ OPENAI_API_KEY: "your-api-key", OPENAI_MODEL: "m" }));
    expect(registry.warnings).toContain("OPENAI_API_KEY looks like a placeholder, not a real key: OpenAI will refuse requests.");
  });

  it("fake mode needs no keys and is labelled; it is the default in the example configuration only", () => {
    const registry = ProviderRegistry.fromConfig(testConfig());
    expect(registry.status().map((s) => s.mode)).toEqual(["fake", "fake"]);
    expect(loadConfig({ NODE_ENV: "test" }).providerMode).toBe("live");
  });
});

describe("both real SDK adapters through the whole API", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    while (apps.length) await apps.pop()!.close();
  });

  it("Compare streams both answers, labels them, stores them and accounts usage per provider", async () => {
    const openai = scriptedProvider("openai", () => ({ kind: "text", text: "OpenAI answer about pricing." }), "served-openai-model");
    const anthropic = scriptedProvider("anthropic", () => ({ kind: "text", text: "Claude answer about pricing." }), "served-claude-model");
    const { app } = await buildApp({ config: testConfig(), providers: registryFor(openai, anthropic) });
    apps.push(app);
    await app.ready();
    const user = await register(app);

    const providers = ProvidersResponse.parse((await app.inject({ method: "GET", url: "/v1/providers", headers: user.auth })).json());
    expect(providers.providers.map((p) => [p.id, p.configured, p.mode])).toEqual([["openai", true, "live"], ["anthropic", true, "live"]]);

    const body = chatBody({ modelChoice: "compare", message: { id: "55555555-5555-4555-8555-555555555555", content: "How should I price a kiosk?", attachmentIds: [] } });
    const res = await app.inject({ method: "POST", url: "/v1/chat/stream", headers: user.auth, payload: body });
    expect(res.statusCode).toBe(200);
    const events = sse(res.body);
    const start = events.find((e): e is Extract<StreamEvent, { event: "stream.start" }> => e.event === "stream.start")!;
    expect(start.data.targets.map((t) => [t.provider, t.demo])).toEqual([["openai", false], ["anthropic", false]]);
    const ends = events.filter((e): e is Extract<StreamEvent, { event: "message.end" }> => e.event === "message.end");
    expect(ends).toHaveLength(2);
    for (const end of ends) expect(end.data).toMatchObject({ finishReason: "stop", usage: { inputTokens: expect.any(Number), outputTokens: expect.any(Number) } });

    // Each request went to its own provider's official endpoint, with the configured model.
    expect(openai.requests).toHaveLength(1);
    expect(new URL(openai.requests[0]!.url).pathname).toMatch(/\/responses$/);
    expect(openai.requests[0]!.body.model).toBe("cfg-openai");
    expect(anthropic.requests).toHaveLength(1);
    expect(new URL(anthropic.requests[0]!.url).pathname).toMatch(/\/messages$/);
    expect(anthropic.requests[0]!.body.model).toBe("cfg-claude");

    const detail = ConversationDetailResponse.parse((await app.inject({ method: "GET", url: `/v1/conversations/${body.conversationId}`, headers: user.auth })).json());
    const answers = detail.messages.filter((m) => m.role === "assistant");
    expect(answers.map((m) => [m.origin, m.content, m.demo, m.status])).toEqual([
      ["openai", "OpenAI answer about pricing.", false, "complete"],
      ["anthropic", "Claude answer about pricing.", false, "complete"],
    ]);
    expect(new Set(answers.map((m) => m.compareGroupId))).toEqual(new Set([body.message.id]));

    const usage = UsageSummaryResponse.parse((await app.inject({ method: "GET", url: "/v1/usage", headers: user.auth })).json());
    const totals = Object.fromEntries(usage.totals.map((t) => [t.provider, t]));
    expect(totals.openai).toMatchObject({ requests: 1, inputTokens: 10, outputTokens: 5 });
    expect(totals.anthropic?.requests).toBe(1);
    expect(totals.anthropic!.inputTokens).toBeGreaterThan(0);
    expect(totals.anthropic!.outputTokens).toBeGreaterThan(0);
    expect(usage.recent.every((r) => !r.demo)).toBe(true);
  });
});
