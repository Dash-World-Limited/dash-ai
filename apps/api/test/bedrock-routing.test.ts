import type { ConverseStreamCommand, ConverseStreamCommandOutput, ConverseStreamOutput } from "@aws-sdk/client-bedrock-runtime";
import {
  AssistantStatusResponse,
  AutomationDetailResponse,
  ConversationDetailResponse,
  UsageSummaryResponse,
  type StreamEvent,
} from "@dash-ai/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { containsProviderName } from "../src/chat/publicSurface.js";
import { configWarnings, loadConfig } from "../src/config.js";
import { estimateCostUsd, priceFor } from "../src/intelligence/cost.js";
import { BedrockAdapter } from "../src/providers/bedrock.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { toProviderError, type ProviderAdapter, type ProviderChunk, type ProviderRequest } from "../src/providers/types.js";
import { chatBody, makeApp, register, sse, testConfig } from "./helpers.js";

// Bedrock behind the unchanged DASH Intelligence Router, through the whole API: routing and internal
// fallback, provider-neutral consumer output, the cost ledger, and Demo Mode. The Bedrock adapter is
// the real one; only its SDK client is a stand-in, so nothing here calls AWS.

const KEY = "ABSKTESTONLY0000000000000000000000000000";
const NOVA = { micro: "eu.amazon.nova-micro-v1:0", lite: "eu.amazon.nova-lite-v1:0", nova2Lite: "eu.amazon.nova-2-lite-v1:0" };

type Reply = ConverseStreamOutput[] | Error;
const answer = (text: string, inputTokens = 1_000, outputTokens = 500): ConverseStreamOutput[] => [
  { messageStart: { role: "assistant" } },
  { contentBlockDelta: { contentBlockIndex: 0, delta: { text } } },
  { messageStop: { stopReason: "end_turn" } },
  { metadata: { usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }, metrics: { latencyMs: 5 } } },
];
const awsError = (name: string, status: number) => Object.assign(new Error("AWS detail SECRET-PROVIDER-TEXT"), { name, $metadata: { httpStatusCode: status } });

/** The real Bedrock adapter with a stand-in SDK client that replies from a queue (last reply repeats). */
function bedrock(replies: Reply[] = [answer("Answer from the first engine.")]) {
  const inputs: Array<ConverseStreamCommand["input"]> = [];
  const adapter = new BedrockAdapter({ kind: "api_key", apiKey: KEY }, "eu-west-1", NOVA, {
    client: {
      async send(command: ConverseStreamCommand): Promise<ConverseStreamCommandOutput> {
        inputs.push(command.input);
        const reply = replies.length > 1 ? replies.shift()! : replies[0]!;
        if (reply instanceof Error) throw reply;
        return { $metadata: {}, stream: (async function* () { yield* reply; })() };
      },
    },
  });
  return { adapter, inputs };
}

/** A scripted second engine (stands in for Anthropic or OpenAI). */
class Engine implements ProviderAdapter {
  readonly demo = false;
  readonly requests: ProviderRequest[] = [];
  constructor(
    readonly id: "openai" | "anthropic",
    readonly displayName: string,
    readonly model: string,
    public failWith?: number,
  ) {}
  async *stream(request: ProviderRequest): AsyncIterable<ProviderChunk> {
    this.requests.push(request);
    if (this.failWith) throw toProviderError(this.displayName, { name: "APIError", status: this.failWith });
    yield { type: "text", text: "Answer from the second engine." };
    yield { type: "finish", finishReason: "stop", usage: { inputTokens: 20, outputTokens: 10 } };
  }
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

async function setup(adapters: Partial<Record<"openai" | "anthropic" | "bedrock", ProviderAdapter>>, env: Record<string, string> = {}) {
  // Bedrock serves traffic only with BEDROCK_ENABLED (off by default).
  const config = testConfig({ PROVIDER_DETAILS: "hidden", PROVIDER_MAX_RETRIES: "0", PROVIDER_RETRY_BASE_MS: "0", BEDROCK_ENABLED: "true", ...env });
  const made = await makeApp({ config, providers: new ProviderRegistry(adapters) });
  apps.push(made.app);
  const user = await register(made.app);
  return { ...made, auth: user.auth, userId: user.user.id };
}

async function chat(app: FastifyInstance, auth: Record<string, string>, over: Record<string, unknown> = {}) {
  const body = chatBody({ modelChoice: "smart", mode: "general", ...over });
  const res = await app.inject({ method: "POST", url: "/v1/chat/stream", headers: auth, payload: body });
  expect(res.statusCode).toBe(200);
  return { body, raw: res.body, events: sse(res.body) };
}

const byEvent = <N extends StreamEvent["event"]>(events: StreamEvent[], name: N) =>
  events.filter((e): e is Extract<StreamEvent, { event: N }> => e.event === name);

/** Every consumer-visible string that names an AI provider, Bedrock or a Nova model id. */
const leaks = (value: unknown): string[] => {
  const out: string[] = [];
  const walk = (v: unknown, key = ""): void => {
    if (typeof v === "string") {
      if (containsProviderName(v) || /^(openai|anthropic|bedrock)$/.test(v) || /nova|amazon|eu\.amazon/i.test(v)) out.push(`${key}=${v}`);
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(value);
  return out;
};

describe("Bedrock as the first live provider (Bedrock-only server)", () => {
  it("the router sends chat to Bedrock; the person sees DASH AI only; the ledger records tier, tokens and cost", async () => {
    const b = bedrock([answer("Answer from the first engine.", 1_000, 500)]);
    const { app, auth, userId, context } = await setup({ bedrock: b.adapter });
    const { body, raw, events } = await chat(app, auth);

    expect(byEvent(events, "message.delta").map((e) => e.data.text).join("")).toBe("Answer from the first engine.");
    expect(byEvent(events, "stream.start")[0]!.data.targets).toEqual([{ messageId: expect.any(String), demo: false }]);
    expect(leaks(events.filter((e) => e.event !== "message.delta"))).toEqual([]);
    expect(raw).not.toMatch(/bedrock|nova|amazon/i);
    // Ordinary chat goes to Nova Lite, with the routing hints the adapter uses.
    expect(b.inputs[0]!.modelId).toBe(NOVA.lite);

    // Operators: the stored message and usage row keep the real provider, the served tier and the cost.
    const stored = (await context.store.listMessages(body.conversationId as string)).at(-1)!;
    expect(stored).toMatchObject({ origin: "bedrock", model: NOVA.lite, status: "complete" });
    const [row] = await context.store.listUsage(userId);
    // Nova Lite estimate: 1,000 × $0.06/M + 500 × $0.24/M = $0.00018.
    expect(row).toMatchObject({ provider: "bedrock", model: NOVA.lite, demo: false, inputTokens: 1_000, outputTokens: 500, estimatedCostUsd: 0.00018 });
    expect(context.metrics.render()).toMatch(/dash_ai_estimated_cost_usd_total\{provider="bedrock"\} 0\.00018/);

    // Every consumer endpoint stays provider-neutral, and none exposes the cost.
    for (const url of [`/v1/conversations/${body.conversationId}`, "/v1/sync/conversations", "/v1/usage", "/v1/me/export", "/v1/assistant", "/v1/conversations"]) {
      const res = await app.inject({ method: "GET", url, headers: auth });
      expect(leaks(res.json()), url).toEqual([]);
      expect(res.body, url).not.toMatch(/estimatedCost|cost_usd|0\.00018/i);
    }
    const detail = ConversationDetailResponse.parse((await app.inject({ method: "GET", url: `/v1/conversations/${body.conversationId}`, headers: auth })).json());
    expect(detail.messages.find((m) => m.role === "assistant")).toMatchObject({ origin: null, model: null });
    expect(UsageSummaryResponse.parse((await app.inject({ method: "GET", url: "/v1/usage", headers: auth })).json()).totals).toEqual([
      { requests: 1, inputTokens: 1_000, outputTokens: 500 },
    ]);
    expect(AssistantStatusResponse.parse((await app.inject({ method: "GET", url: "/v1/assistant" })).json())).toMatchObject({ available: true, demo: false });
  });

  it("documents and research modes, and tools, escalate to Nova 2 Lite inside the adapter", async () => {
    const b = bedrock();
    const { app, auth } = await setup({ bedrock: b.adapter });
    await chat(app, auth, { mode: "documents" });
    await chat(app, auth, { mode: "research" });
    await app.inject({ method: "PUT", url: "/v1/plugins/dash-demo", headers: auth, payload: { enabled: true } });
    await chat(app, auth, { mode: "general" });
    expect(b.inputs.map((i) => i.modelId)).toEqual([NOVA.nova2Lite, NOVA.nova2Lite, NOVA.nova2Lite]);
    // With tools offered, the tool list reaches Bedrock under Bedrock-safe names.
    expect(b.inputs[2]!.toolConfig?.tools?.length).toBeGreaterThan(0);
    expect(b.inputs[2]!.toolConfig?.tools?.map((t) => t.toolSpec?.name).every((n) => /^[A-Za-z][A-Za-z0-9_]*$/.test(n ?? ""))).toBe(true);
  });

  it("DASH Automates run on Bedrock (Nova Micro for background work), with cost and a neutral result", async () => {
    const b = bedrock([answer("# Morning brief\n\nThree priorities.", 2_000, 1_000)]);
    const { app, auth, userId, context } = await setup({ bedrock: b.adapter });
    const created = await app.inject({
      method: "POST",
      url: "/v1/automations",
      headers: auth,
      payload: { name: "Morning brief", prompt: "Write my morning brief.", mode: "business", schedule: { kind: "daily", time: "08:00" }, timeZone: "Africa/Lagos" },
    });
    const automationId = (created.json() as { id: string }).id;
    await app.inject({ method: "POST", url: `/v1/automations/${automationId}/run`, headers: auth });
    await context.automations.idle();

    expect(b.inputs[0]!.modelId).toBe(NOVA.micro);
    const detail = await app.inject({ method: "GET", url: `/v1/automations/${automationId}`, headers: auth });
    expect(AutomationDetailResponse.parse(detail.json()).automation.lastRun).toMatchObject({ status: "ready", demo: false });
    expect(leaks(detail.json())).toEqual([]);
    const [row] = await context.store.listUsage(userId);
    // Nova Micro estimate: 2,000 × $0.035/M + 1,000 × $0.14/M = $0.00021.
    expect(row).toMatchObject({ provider: "bedrock", model: NOVA.micro, estimatedCostUsd: 0.00021 });
  });

  it("a Bedrock failure reads as DASH AI's own error, never Bedrock's", async () => {
    for (const [error, message] of [
      [awsError("ThrottlingException", 429), "DASH AI is very busy right now. Please try again in a moment."],
      [awsError("AccessDeniedException", 403), "DASH AI couldn't complete that response. Please try again."],
      [awsError("ModelTimeoutException", 408), "DASH AI took too long to respond. Please try again."],
    ] as const) {
      const { app, auth } = await setup({ bedrock: bedrock([error]).adapter });
      const { raw, events } = await chat(app, auth);
      expect(byEvent(events, "message.error")[0]!.data.error.message, error.name).toBe(message);
      expect(raw).not.toMatch(/bedrock|nova|amazon|SECRET-PROVIDER-TEXT/i);
    }
  });
});

describe("Bedrock alongside another provider: the router's order, internal fallback and the circuit", () => {
  it("with default quality the other provider leads and Bedrock is the internal fallback before any output", async () => {
    const b = bedrock([answer("Answer from the first engine.")]);
    const anthropic = new Engine("anthropic", "Claude", "cfg-claude", 503);
    const { app, auth, userId, context } = await setup({ anthropic, bedrock: b.adapter });
    const { events } = await chat(app, auth, { mode: "writing" });
    expect(byEvent(events, "message.error")).toHaveLength(0);
    expect(byEvent(events, "message.delta").map((e) => e.data.text).join("")).toBe("Answer from the first engine.");
    expect(anthropic.requests).toHaveLength(1);
    expect(context.metrics.render()).toMatch(/dash_provider_fallbacks_total\{from="anthropic",to="bedrock",code="provider_error"\} 1/);
    expect((await context.store.listUsage(userId))[0]).toMatchObject({ provider: "bedrock", model: NOVA.lite });
  });

  it("an operator can put Bedrock first; if it refuses credentials or model access the other provider answers", async () => {
    const policy = JSON.stringify({ providers: { bedrock: { quality: { "chat:general": 0.99 } } } });
    for (const error of [awsError("AccessDeniedException", 403), awsError("ThrottlingException", 429), awsError("ResourceNotFoundException", 404)]) {
      const anthropic = new Engine("anthropic", "Claude", "cfg-claude");
      const { app, auth, userId, context } = await setup({ anthropic, bedrock: bedrock([error]).adapter }, { ROUTER_POLICY: policy });
      expect(context.router.route({ task: "chat", mode: "general" })).toMatchObject({ ok: true, providers: ["bedrock", "anthropic"] });
      const { raw, events } = await chat(app, auth);
      expect(byEvent(events, "message.error"), error.name).toHaveLength(0);
      expect(byEvent(events, "message.delta").map((e) => e.data.text).join("")).toBe("Answer from the second engine.");
      expect(raw).not.toMatch(/bedrock|nova|amazon/i);
      // The second engine has no configured price: its cost is unknown, not zero.
      expect((await context.store.listUsage(userId))[0]).toMatchObject({ provider: "anthropic", estimatedCostUsd: null });
    }
  });

  it("a request Bedrock rejects as invalid is not shopped to the other provider", async () => {
    const policy = JSON.stringify({ providers: { bedrock: { quality: { "chat:general": 0.99 } } } });
    const anthropic = new Engine("anthropic", "Claude", "cfg-claude");
    const { app, auth } = await setup({ anthropic, bedrock: bedrock([awsError("ValidationException", 400)]).adapter }, { ROUTER_POLICY: policy });
    const { events } = await chat(app, auth);
    expect(anthropic.requests).toHaveLength(0);
    expect(byEvent(events, "message.error")[0]!.data.error).toMatchObject({ code: "provider_error", retryable: false });
  });

  it("Automates fall over from a failing Bedrock to the other provider", async () => {
    // Automates route as task "automation", so the operator's preference names that route.
    const policy = JSON.stringify({ providers: { bedrock: { quality: { automation: 0.99 } } } });
    const anthropic = new Engine("anthropic", "Claude", "cfg-claude");
    const { app, auth, context } = await setup({ anthropic, bedrock: bedrock([awsError("ServiceUnavailableException", 503)]).adapter }, { ROUTER_POLICY: policy });
    const created = await app.inject({
      method: "POST",
      url: "/v1/automations",
      headers: auth,
      payload: { name: "Brief", prompt: "Write my brief.", mode: "business", schedule: { kind: "daily", time: "08:00" }, timeZone: "Africa/Lagos" },
    });
    const automationId = (created.json() as { id: string }).id;
    await app.inject({ method: "POST", url: `/v1/automations/${automationId}/run`, headers: auth });
    await context.automations.idle();
    const detail = AutomationDetailResponse.parse((await app.inject({ method: "GET", url: `/v1/automations/${automationId}`, headers: auth })).json());
    expect(detail.automation.lastRun).toMatchObject({ status: "ready" });
    expect(anthropic.requests).toHaveLength(1);
  });

  it("repeated retryable Bedrock failures open its circuit: the router moves it to the back, then forgives it", async () => {
    const policy = JSON.stringify({ providers: { bedrock: { quality: { "chat:general": 0.99 } } }, circuit: { failureThreshold: 3, cooldownMs: 1_000 } });
    const { context } = await setup({ anthropic: new Engine("anthropic", "Claude", "cfg-claude"), bedrock: bedrock().adapter }, { ROUTER_POLICY: policy });
    expect(context.router.route({ task: "chat", mode: "general" })).toMatchObject({ providers: ["bedrock", "anthropic"] });
    for (let i = 0; i < 3; i++) context.router.recordFailure("bedrock", "rate_limited", true);
    expect(context.router.route({ task: "chat", mode: "general" })).toMatchObject({ providers: ["anthropic", "bedrock"] });
    // Non-retryable failures (a rejected key) lower reliability but never open the circuit on their own.
    const fresh = await setup({ anthropic: new Engine("anthropic", "Claude", "cfg-claude"), bedrock: bedrock().adapter }, { ROUTER_POLICY: policy });
    for (let i = 0; i < 3; i++) fresh.context.router.recordFailure("bedrock", "provider_error", false);
    expect(fresh.context.router.health.isOpen("bedrock")).toBe(false);
  });
});

describe("Demo Mode is unchanged by Bedrock", () => {
  it("PROVIDER_MODE=fake ignores Bedrock settings, answers as a demonstration and records zero cost", async () => {
    const config = testConfig({
      PROVIDER_MODE: "fake",
      PROVIDER_DETAILS: "hidden",
      BEDROCK_API_KEY: KEY,
      BEDROCK_REGION: "eu-west-1",
      BEDROCK_MODEL_LITE: NOVA.lite,
    });
    const registry = ProviderRegistry.fromConfig(config);
    expect(registry.get("bedrock")).toBeUndefined();
    expect(registry.status().map((s) => [s.id, s.mode])).toEqual([["openai", "fake"], ["anthropic", "fake"], ["bedrock", "unconfigured"]]);
    const made = await makeApp({ config });
    apps.push(made.app);
    const { auth, user } = await register(made.app);
    const { events } = await chat(made.app, auth);
    expect(byEvent(events, "stream.start")[0]!.data.targets[0]).toMatchObject({ demo: true });
    expect(byEvent(events, "message.end")).toHaveLength(1);
    expect(AssistantStatusResponse.parse((await made.app.inject({ method: "GET", url: "/v1/assistant" })).json())).toMatchObject({ available: true, demo: true });
    expect((await made.context.store.listUsage(user.id))[0]).toMatchObject({ demo: true, estimatedCostUsd: 0 });
  });
});

describe("cost ledger: estimated USD per answer", () => {
  const usage = (inputTokens: number | null, outputTokens: number | null) => ({ inputTokens, outputTokens });

  it("an operator policy override keeps Bedrock's default prices unless it sets them", () => {
    const tuned = loadConfig({ BEDROCK_ENABLED: "true", ROUTER_POLICY: JSON.stringify({ providers: { bedrock: { quality: { "chat:general": 0.9 } } } }) }).routerPolicy;
    expect(tuned.providers.bedrock).toMatchObject({ costPerMillionInput: 0.33, costPerMillionOutput: 2.75, enabled: true });
    const repriced = loadConfig({ BEDROCK_ENABLED: "true", ROUTER_POLICY: JSON.stringify({ providers: { bedrock: { costPerMillionInput: 0.06 } } }) }).routerPolicy;
    expect(repriced.providers.bedrock).toMatchObject({ costPerMillionInput: 0.06, costPerMillionOutput: 2.75 });
  });

  it("prices each Nova tier from its built-in estimate, with or without a cross-Region prefix", () => {
    const cases: Array<[string, number]> = [
      ["amazon.nova-micro-v1:0", 0.035 + 0.14],
      ["eu.amazon.nova-micro-v1:0", 0.035 + 0.14],
      ["us.amazon.nova-lite-v1:0", 0.06 + 0.24],
      ["global.amazon.nova-2-lite-v1:0", 0.33 + 2.75],
    ];
    for (const [model, perMillionEach] of cases) {
      expect(estimateCostUsd({}, { provider: "bedrock", model, demo: false, usage: usage(1_000_000, 1_000_000) }), model).toBeCloseTo(perMillionEach, 10);
    }
    // 1,234 × $0.06/M + 567 × $0.24/M = $0.00007404 + $0.00013608.
    expect(estimateCostUsd({}, { provider: "bedrock", model: NOVA.lite, demo: false, usage: usage(1_234, 567) })).toBe(0.00021012);
  });

  it("unknown price or token counts are unknown (null), demonstrations cost nothing", () => {
    expect(estimateCostUsd({}, { provider: "openai", model: "any-openai-model", demo: false, usage: usage(10, 10) })).toBeNull();
    expect(estimateCostUsd({}, { provider: "bedrock", model: "eu.anthropic.claude-model", demo: false, usage: usage(10, 10) })).toBeNull();
    expect(estimateCostUsd({}, { provider: "bedrock", model: NOVA.lite, demo: false, usage: usage(null, 10) })).toBeNull();
    expect(estimateCostUsd({}, { provider: "openai", model: "fake-openai", demo: true, usage: usage(null, null) })).toBe(0);
    // A Nova price is never applied to another provider's model that merely looks similar.
    expect(priceFor({}, "openai", NOVA.lite)).toBeUndefined();
  });

  it("MODEL_PRICES overrides built-in estimates (longest prefix wins) and prices other providers", () => {
    const config = loadConfig({
      MODEL_PRICES: JSON.stringify({
        "bedrock:eu.amazon.nova-lite": { inputPerMillion: 0.07, outputPerMillion: 0.28 },
        "bedrock:eu.amazon.nova-lite-v1:0": { inputPerMillion: 0.08, outputPerMillion: 0.32 },
        "openai:gpt-test": { inputPerMillion: 1, outputPerMillion: 4 },
      }),
    });
    expect(priceFor(config.modelPrices, "bedrock", NOVA.lite)).toEqual({ inputPerMillion: 0.08, outputPerMillion: 0.32 });
    expect(priceFor(config.modelPrices, "bedrock", "us.amazon.nova-lite-v1:0")).toEqual({ inputPerMillion: 0.06, outputPerMillion: 0.24 });
    // Prefix matching covers dated snapshots the provider reports as the served model.
    expect(estimateCostUsd(config.modelPrices, { provider: "openai", model: "gpt-test-2026-01-01", demo: false, usage: usage(1_000_000, 500_000) })).toBe(3);
  });

  it("refuses malformed MODEL_PRICES at start-up, naming the variable and never echoing its content", () => {
    for (const [value, expected] of [
      ["{not json", /MODEL_PRICES is not valid JSON/],
      [JSON.stringify({ "gpt-SECRETVALUE": { inputPerMillion: 1, outputPerMillion: 1 } }), /MODEL_PRICES .*<provider>:<model id or prefix>/],
      [JSON.stringify({ "bedrock:SECRETVALUE": { inputPerMillion: -1, outputPerMillion: 1 } }), /MODEL_PRICES an entry's inputPerMillion/],
    ] as const) {
      let message = "";
      try {
        loadConfig({ MODEL_PRICES: value });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(expected);
      expect(message).not.toContain("SECRETVALUE");
    }
  });
});

describe("production start-up validation for Bedrock", () => {
  // Production with paid providers also needs spend limits (docs/provider-platform.md).
  const prod = (env: Record<string, string>) => () =>
    loadConfig({ NODE_ENV: "production", PROVIDER_MODE: "live", BEDROCK_ENABLED: "true", MAX_DAILY_AI_SPEND: "10", MAX_MONTHLY_AI_SPEND: "200", ...env });
  const refusal = (env: Record<string, string>): string => {
    try {
      prod(env)();
    } catch (err) {
      return (err as Error).message;
    }
    throw new Error("expected a ConfigError");
  };
  const bedrockKey = { BEDROCK_AUTH: "api_key", BEDROCK_API_KEY: KEY, BEDROCK_REGION: "eu-west-1" };

  it("starts with Bedrock alone (API key or IAM), warning that there is nothing to fail over to", () => {
    const viaKey = prod({ ...bedrockKey, BEDROCK_MODEL_LITE: NOVA.lite })();
    expect(viaKey.bedrock).toMatchObject({ auth: "api_key", region: "eu-west-1", models: { lite: NOVA.lite } });
    expect(configWarnings(viaKey).join(" ")).toMatch(/Only one AI provider is configured/);
    expect(prod({ BEDROCK_AUTH: "iam", BEDROCK_REGION: "eu-west-1", BEDROCK_MODEL_MICRO: NOVA.micro, BEDROCK_MODEL_NOVA2_LITE: NOVA.nova2Lite })().bedrock.auth).toBe("iam");
  });

  it("a preset Region or auth mode alone does not switch Bedrock on or block start-up", () => {
    expect(() =>
      prod({
        BEDROCK_REGION: "eu-west-1",
        BEDROCK_AUTH: "iam",
        ANTHROPIC_API_KEY: "test-anthropic-key-not-real",
        ANTHROPIC_MODEL: "m",
        MODEL_PRICES: JSON.stringify({ "anthropic:m": { inputPerMillion: 3, outputPerMillion: 15 } }),
      })(),
    ).not.toThrow();
  });

  it("refuses incomplete, misplaced or malformed Bedrock settings by variable name only", () => {
    expect(refusal({ BEDROCK_MODEL_LITE: NOVA.lite })).toMatch(/BEDROCK_REGION is required.*BEDROCK_API_KEY is required/);
    expect(refusal({ ...bedrockKey })).toMatch(/Bedrock needs at least one of BEDROCK_MODEL_MICRO/);
    expect(refusal({ ...bedrockKey, BEDROCK_REGION: "Ireland", BEDROCK_MODEL_LITE: NOVA.lite })).toMatch(/BEDROCK_REGION is not an AWS Region code/);
    expect(refusal({ ...bedrockKey, BEDROCK_MODEL_MICRO: NOVA.lite })).toMatch(/BEDROCK_MODEL_MICRO is not an Amazon Nova Micro model or inference profile id/);
    expect(refusal({ ...bedrockKey, BEDROCK_MODEL_NOVA2_LITE: "eu.anthropic.claude-SECRETVALUE" })).toMatch(/BEDROCK_MODEL_NOVA2_LITE is not an Amazon Nova 2 Lite/);
    expect(refusal({ ...bedrockKey, BEDROCK_API_KEY: "changeme", BEDROCK_MODEL_LITE: NOVA.lite })).toMatch(/BEDROCK_API_KEY looks like a placeholder/);
    expect(refusal({ ...bedrockKey, BEDROCK_MODEL_LITE: `"${NOVA.lite}"` })).toMatch(/BEDROCK_MODEL_LITE is wrapped in quotes/);
    expect(refusal({ BEDROCK_AUTH: "iam", BEDROCK_API_KEY: KEY, BEDROCK_REGION: "eu-west-1", BEDROCK_MODEL_LITE: NOVA.lite })).toMatch(
      /BEDROCK_API_KEY is set but BEDROCK_AUTH=iam/,
    );
    for (const message of [refusal({ ...bedrockKey, BEDROCK_MODEL_NOVA2_LITE: "eu.anthropic.claude-SECRETVALUE" }), refusal({ BEDROCK_MODEL_LITE: NOVA.lite })]) {
      expect(message).not.toMatch(/SECRETVALUE|ABSKTESTONLY|nova-lite/);
    }
  });

  it("development starts anyway and explains the same problems as warnings", () => {
    const registry = ProviderRegistry.fromConfig(loadConfig({ NODE_ENV: "development", PROVIDER_MODE: "live", BEDROCK_MODEL_MICRO: NOVA.lite, BEDROCK_REGION: "eu-west-1", BEDROCK_API_KEY: KEY }));
    expect(registry.get("bedrock")).toBeUndefined();
    expect(registry.warnings).toContain("Amazon Bedrock: BEDROCK_MODEL_MICRO is not an Amazon Nova Micro model or inference profile id.");
  });
});
