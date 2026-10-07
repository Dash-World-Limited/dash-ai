import {
  AssistantStatusResponse,
  ConversationDetailResponse,
  DataExportResponse,
  SyncConversationsResponse,
  ToolActivityResponse,
  UsageSummaryResponse,
  type StreamEvent,
} from "@dash-ai/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { containsProviderName } from "../src/chat/publicSurface.js";
import { IDENTITY_INSTRUCTIONS } from "../src/providers/instructions.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { ProviderError, type ProviderAdapter, type ProviderChunk, type ProviderRequest } from "../src/providers/types.js";
import { builtinPlugin } from "../src/tools/builtin.js";
import { PluginRegistry } from "../src/tools/registry.js";
import { chatBody, register, sse, testConfig, USING_POSTGRES } from "./helpers.js";
import { createTestPgStore } from "./pgTestStore.js";

// The production default: DASH AI is the product, providers are internal infrastructure. Nothing a
// consumer receives names a provider or model; operators still see everything.

type Behaviour = "answer" | "fail-before-output" | "fail-after-output" | "tool-then-fail";

/** A controllable provider: records requests and system prompts, behaves as told. */
class Scripted implements ProviderAdapter {
  readonly demo = false;
  readonly requests: ProviderRequest[] = [];
  constructor(
    readonly id: "openai" | "anthropic",
    readonly displayName: string,
    readonly model: string,
    private behaviour: Behaviour = "answer",
  ) {}

  async *stream(request: ProviderRequest): AsyncIterable<ProviderChunk> {
    this.requests.push(request);
    const toolDone = request.messages.some((m) => m.role === "tool");
    switch (this.behaviour) {
      case "fail-before-output":
        throw new ProviderError("provider_error", `${this.displayName} is temporarily unavailable. Try again.`, true, 503);
      case "fail-after-output":
        yield { type: "text", text: "Partial " };
        throw new ProviderError("provider_error", `Could not reach ${this.displayName}. Try again.`, true);
      case "tool-then-fail":
        if (!toolDone) {
          yield { type: "tool_calls", calls: [{ id: "c1", name: "dash-demo__current_time", argumentsJson: "{}" }] };
          yield { type: "finish", finishReason: "stop", usage: { inputTokens: 5, outputTokens: 1 } };
          return;
        }
        throw new ProviderError("rate_limited", `${this.displayName} is receiving too many requests. Try again shortly.`, true, 429);
      default:
        yield { type: "text", text: `Answer written by ${this.id === "openai" ? "the first" : "the second"} engine.` };
        yield { type: "finish", finishReason: "stop", usage: { inputTokens: 11, outputTokens: 7 } };
    }
  }
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

async function setup(openai: Scripted, anthropic: Scripted, env: Record<string, string> = {}) {
  const pg = USING_POSTGRES ? await createTestPgStore() : undefined;
  const plugins = new PluginRegistry().register(builtinPlugin);
  const config = testConfig({ PROVIDER_DETAILS: "hidden", PROVIDER_RETRY_BASE_MS: "0", PROVIDER_MAX_RETRIES: "0", ...env });
  const { app, context } = await buildApp({ config, providers: new ProviderRegistry({ openai, anthropic }), plugins, store: pg?.store });
  if (pg) app.addHook("onClose", async () => pg.dispose());
  await app.ready();
  apps.push(app);
  const user = await register(app);
  return { app, context, auth: user.auth, userId: user.user.id };
}

async function chat(app: FastifyInstance, auth: Record<string, string>, over: Record<string, unknown> = {}) {
  const body = chatBody({ modelChoice: "smart", mode: "general", ...over });
  const res = await app.inject({ method: "POST", url: "/v1/chat/stream", headers: auth, payload: body });
  expect(res.statusCode).toBe(200);
  return { body, raw: res.body, events: sse(res.body) };
}

const byEvent = <N extends StreamEvent["event"]>(events: StreamEvent[], name: N) =>
  events.filter((e): e is Extract<StreamEvent, { event: N }> => e.event === name);

/** Every string a consumer could receive, flattened. The model's own text is excluded (scripted here). */
const leaks = (value: unknown): string[] => {
  const out: string[] = [];
  const walk = (v: unknown, key = ""): void => {
    if (typeof v === "string") {
      if (containsProviderName(v) || /^(openai|anthropic)$/.test(v) || /fake-(openai|anthropic)|cfg-/.test(v)) out.push(`${key}=${v}`);
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(value);
  return out;
};

describe("consumer responses never name a provider or model", () => {
  it("stream metadata, history, sync, usage, tool activity and the export are provider-neutral", async () => {
    const openai = new Scripted("openai", "OpenAI", "cfg-openai-model");
    const anthropic = new Scripted("anthropic", "Claude", "cfg-claude-model");
    const { app, auth } = await setup(openai, anthropic);
    await app.inject({ method: "PUT", url: "/v1/plugins/dash-demo", headers: auth, payload: { enabled: true } });

    const { body, events } = await chat(app, auth);
    const start = byEvent(events, "stream.start")[0]!;
    expect(start.data.targets).toEqual([{ messageId: expect.any(String), demo: false }]);
    expect(start.data.modelChoice).toBe("smart");
    expect(leaks(events.filter((e) => e.event !== "message.delta"))).toEqual([]);

    const responses = await Promise.all(
      [`/v1/conversations/${body.conversationId}`, "/v1/sync/conversations", "/v1/usage", "/v1/tools/activity", "/v1/me/export", "/v1/assistant", "/v1/conversations"].map(
        async (url) => [url, (await app.inject({ method: "GET", url, headers: auth })).json()] as const,
      ),
    );
    for (const [url, json] of responses) expect(leaks(json), url).toEqual([]);

    const detail = ConversationDetailResponse.parse(responses[0]![1]);
    expect(detail.messages.find((m) => m.role === "assistant")).toMatchObject({ origin: null, model: null });
    SyncConversationsResponse.parse(responses[1]![1]);
    const usage = UsageSummaryResponse.parse(responses[2]![1]);
    expect(usage.totals).toEqual([{ requests: 1, inputTokens: 11, outputTokens: 7 }]); // one DASH AI total
    expect(usage.recent[0]).not.toHaveProperty("provider");
    ToolActivityResponse.parse(responses[3]![1]);
    DataExportResponse.parse(responses[4]![1]);
    expect(AssistantStatusResponse.parse(responses[5]![1])).toMatchObject({ available: true, demo: false });
  });

  it("consumers cannot pick a provider: explicit routes and Compare are treated as DASH AI routing", async () => {
    const openai = new Scripted("openai", "OpenAI", "m1");
    const anthropic = new Scripted("anthropic", "Claude", "m2");
    const { app, auth } = await setup(openai, anthropic);
    for (const modelChoice of ["claude", "openai", "compare"]) {
      const { events } = await chat(app, auth, { modelChoice, mode: "general" });
      const start = byEvent(events, "stream.start")[0]!;
      expect(start.data).toMatchObject({ modelChoice: "smart", compareGroupId: null });
      expect(start.data.targets).toHaveLength(1);
      expect(byEvent(events, "message.end")).toHaveLength(1);
    }
    // General mode routes to the same engine each time; the request never reached the other one.
    expect(anthropic.requests).toHaveLength(0);
    expect(openai.requests).toHaveLength(3);
  });

  it("the operator view of providers needs the operator token; consumers get a neutral status", async () => {
    const { app, auth } = await setup(new Scripted("openai", "OpenAI", "m1"), new Scripted("anthropic", "Claude", "m2"), {
      METRICS_TOKEN: "operator-token-for-tests-0123456789",
    });
    expect((await app.inject({ method: "GET", url: "/v1/providers", headers: auth })).statusCode).toBe(404);
    const operator = await app.inject({ method: "GET", url: "/v1/providers", headers: { authorization: "Bearer operator-token-for-tests-0123456789" } });
    expect(operator.statusCode).toBe(200);
    expect(operator.json().providers.map((p: { id: string; model: string }) => [p.id, p.model])).toEqual([["openai", "m1"], ["anthropic", "m2"]]);
  });
});

describe("failures: DASH AI recovers internally where safe, and speaks for itself", () => {
  it("a provider failing before any output is replaced silently by the next one; the truth stays internal", async () => {
    const openai = new Scripted("openai", "OpenAI", "m1", "fail-before-output");
    const anthropic = new Scripted("anthropic", "Claude", "m2");
    const { app, context, auth, userId } = await setup(openai, anthropic);
    const { body, events } = await chat(app, auth);
    expect(byEvent(events, "message.error")).toHaveLength(0);
    expect(byEvent(events, "message.delta").map((e) => e.data.text).join("")).toBe("Answer written by the second engine.");
    // Operators: the stored message, usage and metrics say exactly what happened.
    const stored = await context.store.listMessages(body.conversationId as string);
    expect(stored.at(-1)).toMatchObject({ origin: "anthropic", model: "m2", status: "complete" });
    expect((await context.store.listUsage(userId)).at(-1)).toMatchObject({ provider: "anthropic", model: "m2", inputTokens: 11 });
    expect(context.metrics.render()).toMatch(/dash_provider_fallbacks_total\{from="openai",to="anthropic",code="provider_error"\} 1/);
  });

  it("no fallback once text reached the person: the answer fails with a neutral message and Retry", async () => {
    const openai = new Scripted("openai", "OpenAI", "m1", "fail-after-output");
    const anthropic = new Scripted("anthropic", "Claude", "m2");
    const { app, auth } = await setup(openai, anthropic);
    const { body, events } = await chat(app, auth);
    expect(anthropic.requests).toHaveLength(0);
    const error = byEvent(events, "message.error")[0]!.data;
    expect(error.error).toEqual({ code: "provider_error", message: "DASH AI couldn't complete that response. Please try again.", retryable: true });
    expect(error.recovery?.alternatives).toEqual([]);
    expect(leaks(events.filter((e) => e.event !== "message.delta"))).toEqual([]);
    // Retry works: the same message again (here the first engine has recovered).
    (openai as unknown as { behaviour: Behaviour }).behaviour = "answer";
    const retry = await chat(app, auth, { conversationId: body.conversationId, message: body.message });
    expect(byEvent(retry.events, "message.end")).toHaveLength(1);
  });

  it("no fallback after a tool ran (it would run twice); rate limits read as DASH AI being busy", async () => {
    const openai = new Scripted("openai", "OpenAI", "m1", "tool-then-fail");
    const anthropic = new Scripted("anthropic", "Claude", "m2");
    const { app, auth } = await setup(openai, anthropic);
    await app.inject({ method: "PUT", url: "/v1/plugins/dash-demo", headers: auth, payload: { enabled: true } });
    const { events } = await chat(app, auth);
    expect(anthropic.requests).toHaveLength(0);
    expect(byEvent(events, "message.error")[0]!.data.error.message).toBe("DASH AI is very busy right now. Please try again in a moment.");
  });

  it("with no AI infrastructure configured, the error is DASH AI's own", async () => {
    const config = testConfig({ PROVIDER_DETAILS: "hidden" });
    const { app } = await buildApp({ config, providers: new ProviderRegistry({}) });
    await app.ready();
    apps.push(app);
    const { auth } = await register(app);
    const res = await app.inject({ method: "POST", url: "/v1/chat/stream", headers: auth, payload: chatBody({ modelChoice: "smart" }) });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.message).toBe("DASH AI is temporarily unavailable. Please try again later.");
    expect(AssistantStatusResponse.parse((await app.inject({ method: "GET", url: "/v1/assistant" })).json())).toMatchObject({ available: false });
  });
});

describe("identity and routing", () => {
  it("every provider is told it is DASH AI, never which provider or model it is", async () => {
    const openai = new Scripted("openai", "OpenAI", "secret-model-a");
    const anthropic = new Scripted("anthropic", "Claude", "secret-model-b");
    const { app, auth } = await setup(openai, anthropic);
    await chat(app, auth, { mode: "general" });
    await chat(app, auth, { mode: "writing" });
    for (const seen of [openai.requests[0]!, anthropic.requests[0]!]) {
      expect(seen.system.startsWith(IDENTITY_INSTRUCTIONS)).toBe(true);
      expect(seen.system).not.toMatch(/secret-model|running on/);
    }
  });

  it("a provider the person names in their own words is preferred when available, without saying so", async () => {
    const openai = new Scripted("openai", "OpenAI", "m1");
    const anthropic = new Scripted("anthropic", "Claude", "m2");
    const { app, auth } = await setup(openai, anthropic);
    // General mode would route to the first engine; the request asks for a Claude-style answer.
    const { events } = await chat(app, auth, {
      mode: "general",
      message: { id: "55555555-5555-4555-8555-555555555551", content: "Give me a Claude-style analysis of my plan", attachmentIds: [] },
    });
    expect(anthropic.requests).toHaveLength(1);
    expect(openai.requests).toHaveLength(0);
    // The title comes from the person's own words; nothing DASH AI adds names a provider.
    expect(leaks(events.filter((e) => e.event !== "message.delta" && e.event !== "conversation.title"))).toEqual([]);
  });
});
