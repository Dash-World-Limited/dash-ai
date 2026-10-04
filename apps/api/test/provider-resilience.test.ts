import { ConversationDetailResponse, type StreamEvent } from "@dash-ai/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { retryDelayMs } from "../src/chat/orchestrator.js";
import { Metrics } from "../src/observability/metrics.js";
import { builtinPlugin } from "../src/tools/builtin.js";
import { PluginRegistry } from "../src/tools/registry.js";
import { LogCapture, chatBody, register, sse, testConfig, testId, waitFor } from "./helpers.js";
import { makeMockGithubPlugin } from "./mockPlugin.js";
import { hasToolResult, registryFor, scriptedProvider, type ScriptedProvider } from "./providerServer.js";

/**
 * Provider outages through the real SDKs. A wrapper fails the first requests in a chosen way
 * (HTTP status, stall, malformed stream, reset mid-stream), then lets the scripted provider answer.
 */

type Kind = "openai" | "anthropic";
type Failure = number | "stall" | "malformed" | "reset-after-text";

const enc = new TextEncoder();
const errorBody = (kind: Kind, status: number) =>
  kind === "anthropic"
    ? { type: "error", error: { type: status === 429 ? "rate_limit_error" : status === 529 ? "overloaded_error" : "api_error", message: "SECRET-PROVIDER-TEXT" } }
    : { error: { message: "SECRET-PROVIDER-TEXT", type: "server_error", code: status === 429 ? "rate_limit_exceeded" : null } };

const partialText = (kind: Kind) =>
  kind === "openai"
    ? `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "Partial ", item_id: "i", output_index: 0, content_index: 0, sequence_number: 1, logprobs: [] })}\n\n`
    : [
        ["message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Partial " } }],
      ].map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");

function failFirst(kind: Kind, base: ScriptedProvider, failures: Failure[]): ScriptedProvider & { attempts: () => number } {
  let n = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const failure = failures[n++];
    if (failure === undefined) return base.fetch(input, init);
    if (typeof failure === "number") {
      return new Response(JSON.stringify(errorBody(kind, failure)), { status: failure, headers: { "content-type": "application/json" } });
    }
    if (failure === "malformed") {
      return new Response("event: message_start\ndata: {not json SECRET-PROVIDER-TEXT\n\n", { headers: { "content-type": "text/event-stream" } });
    }
    const signal = init?.signal;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          if (failure === "reset-after-text") {
            c.enqueue(enc.encode(partialText(kind)));
            setTimeout(() => c.error(new TypeError("terminated")), 5);
            return;
          }
          // "stall": headers arrive, then nothing until the request is aborted.
          signal?.addEventListener("abort", () => c.error(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  }) as typeof fetch;
  return { requests: base.requests, fetch: fetchImpl, attempts: () => n };
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

const answer = (kind: Kind) => scriptedProvider(kind, () => ({ kind: "text", text: `Recovered answer from ${kind}.` }));

async function setup(options: { openai?: ScriptedProvider; anthropic?: ScriptedProvider; env?: Record<string, string>; logs?: LogCapture; withTools?: boolean }) {
  const metrics = new Metrics();
  const mock = makeMockGithubPlugin();
  const { app, context } = await buildApp({
    config: testConfig({ PROVIDER_RETRY_BASE_MS: "10", PROVIDER_IDLE_TIMEOUT_MS: "500", ...(options.logs ? { LOG_LEVEL: "debug" } : {}), ...options.env }),
    providers: registryFor(options.openai, options.anthropic),
    plugins: new PluginRegistry().register(builtinPlugin).register(mock.plugin),
    logStream: options.logs,
    metrics,
  });
  await app.ready();
  apps.push(app);
  const user = await register(app);
  if (options.withTools) {
    await app.inject({ method: "PUT", url: "/v1/plugins/mock-github", headers: user.auth, payload: { enabled: true } });
  }
  const chat = async (over: Record<string, unknown> = {}) => {
    const body = chatBody({ modelChoice: "openai", ...over });
    const res = await app.inject({ method: "POST", url: "/v1/chat/stream", headers: user.auth, payload: body });
    expect(res.statusCode).toBe(200);
    return { body, raw: res.body, events: sse(res.body) };
  };
  const stored = async (conversationId: string) =>
    ConversationDetailResponse.parse((await app.inject({ method: "GET", url: `/v1/conversations/${conversationId}`, headers: user.auth })).json()).messages;
  return { app, context, user, chat, stored, metrics, probe: mock.probe };
}

const byEvent = <N extends StreamEvent["event"]>(events: StreamEvent[], name: N) =>
  events.filter((e): e is Extract<StreamEvent, { event: N }> => e.event === name);
const text = (events: StreamEvent[]) => byEvent(events, "message.delta").map((d) => d.data.text).join("");

describe("retryable failures before any output are retried, once each, then succeed", () => {
  it.each([
    ["429 rate limit", "openai", [429]],
    ["503", "openai", [503]],
    ["Claude 529 overloaded, twice", "anthropic", [529, 529]],
    ["a timeout (provider stalls before the first byte)", "anthropic", ["stall"]],
    ["a malformed stream", "openai", ["malformed"]],
  ] as const)("%s", async (_label, kind, failures) => {
    const provider = failFirst(kind, answer(kind), [...failures]);
    const s = await setup({ [kind]: provider });
    const { body, events, raw } = await s.chat({ modelChoice: kind === "openai" ? "openai" : "claude" });
    expect(byEvent(events, "message.error")).toEqual([]);
    expect(text(events)).toBe(`Recovered answer from ${kind}.`); // no duplicated or partial text
    expect(provider.attempts()).toBe(failures.length + 1);
    expect(raw).not.toContain("SECRET-PROVIDER-TEXT");
    const messages = await s.stored(body.conversationId as string);
    expect(messages.map((m) => [m.role, m.status])).toEqual([["user", "complete"], ["assistant", "complete"]]);
    expect(s.metrics.providerRetries.get({ provider: kind, code: typeof failures[0] === "number" && failures[0] === 429 ? "rate_limited" : failures[0] === "stall" ? "provider_timeout" : "provider_error" })).toBe(failures.length);
  });
});

describe("bounded: no retry storms", () => {
  it("repeated retryable failures stop after PROVIDER_MAX_RETRIES and expose a recoverable state", async () => {
    const provider = failFirst("openai", answer("openai"), [503, 503, 503, 503]);
    const s = await setup({ openai: provider, anthropic: answer("anthropic") });
    const { events, body } = await s.chat();
    expect(provider.attempts()).toBe(3); // 1 + 2 retries
    const [error] = byEvent(events, "message.error");
    expect(error!.data).toMatchObject({ error: { code: "provider_error", retryable: true }, recovery: { attempts: 3, alternatives: ["anthropic"] } });
    // No silent failover: Claude was never called for an OpenAI request.
    expect(s.context.providers.get("anthropic")).toBeDefined();
    const messages = await s.stored(body.conversationId as string);
    expect(messages.filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(messages.at(-1)).toMatchObject({ status: "failed", origin: "openai" });
  });

  it("PROVIDER_MAX_RETRIES=0 makes exactly one request", async () => {
    const provider = failFirst("openai", answer("openai"), [503]);
    const s = await setup({ openai: provider, env: { PROVIDER_MAX_RETRIES: "0" } });
    const { events } = await s.chat();
    expect(provider.attempts()).toBe(1);
    expect(byEvent(events, "message.error")[0]!.data.recovery).toEqual({ attempts: 1, alternatives: [] });
  });

  it("permanent request errors (400, 401) are never retried", async () => {
    for (const status of [400, 401]) {
      const provider = failFirst("anthropic", answer("anthropic"), [status, status]);
      const s = await setup({ anthropic: provider });
      const { events } = await s.chat({ modelChoice: "claude" });
      expect(provider.attempts(), String(status)).toBe(1);
      expect(byEvent(events, "message.error")[0]!.data.error.retryable).toBe(false);
    }
  });

  it("a retry is skipped when its delay would not fit in the overall time limit", async () => {
    const provider = failFirst("openai", answer("openai"), [503, 503]);
    const s = await setup({ openai: provider, env: { PROVIDER_RETRY_BASE_MS: "5000", PROVIDER_TIMEOUT_MS: "3000" } });
    const started = Date.now();
    const { events } = await s.chat();
    expect(provider.attempts()).toBe(1);
    expect(byEvent(events, "message.error")).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("backoff doubles, is longer after rate limiting, has jitter and a cap", () => {
    const mid = () => 0.5;
    expect([0, 1, 2].map((a) => retryDelayMs({ baseMs: 500 }, a, { code: "provider_error" }, mid))).toEqual([500, 1_000, 2_000]);
    expect(retryDelayMs({ baseMs: 500 }, 0, { code: "rate_limited" }, mid)).toBe(2_000);
    expect(retryDelayMs({ baseMs: 500 }, 0, { code: "provider_error" }, () => 0)).toBe(400);
    expect(retryDelayMs({ baseMs: 500 }, 0, { code: "provider_error" }, () => 1)).toBe(600);
    expect(retryDelayMs({ baseMs: 5_000 }, 4, { code: "rate_limited" }, mid)).toBe(8_000);
  });
});

describe("failures after output reached the client are final (retrying would duplicate it)", () => {
  it("a network disconnect mid-stream keeps the partial text once, stored as failed, not retried", async () => {
    const provider = failFirst("anthropic", answer("anthropic"), ["reset-after-text"]);
    const s = await setup({ anthropic: provider });
    const { events, body } = await s.chat({ modelChoice: "claude" });
    expect(provider.attempts()).toBe(1);
    expect(text(events)).toBe("Partial ");
    expect(byEvent(events, "message.error")[0]!.data.error).toMatchObject({ code: "provider_error", retryable: true });
    const messages = await s.stored(body.conversationId as string);
    expect(messages.map((m) => [m.role, m.status, m.content])).toEqual([["user", "complete", expect.any(String)], ["assistant", "failed", "Partial "]]);
  });
});

describe("tools are never run twice because a provider request was retried", () => {
  it("a failure after the tool ran retries only the follow-up request; the tool ran once", async () => {
    const base = scriptedProvider("openai", (req) =>
      hasToolResult("openai", req) ? { kind: "text", text: "Two mocked issues." } : { kind: "tool", name: "mock-github__list_issues", args: { repo: "dash/dash-ai" } },
    );
    // Request 1 succeeds (tool call), request 2 (after the tool) fails twice, then succeeds.
    let n = 0;
    const provider: ScriptedProvider = {
      requests: base.requests,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        n += 1;
        if (n === 2 || n === 3) return new Response(JSON.stringify(errorBody("openai", 503)), { status: 503, headers: { "content-type": "application/json" } });
        return base.fetch(input, init);
      }) as typeof fetch,
    };
    const s = await setup({ openai: provider, withTools: true });
    const { events, body } = await s.chat();
    expect(n).toBe(4);
    expect(s.probe.calls.list_issues).toBe(1);
    expect(byEvent(events, "tool.result")).toHaveLength(1);
    expect(byEvent(events, "message.error")).toEqual([]);
    expect(text(events)).toBe("Two mocked issues.");
    // Each retried follow-up carried the same single tool result.
    const outputs = base.requests.slice(1).map((r) => (r.body.input as Array<{ type?: string }>).filter((i) => i.type === "function_call_output").length);
    expect(outputs).toEqual([1]);
    expect((await s.stored(body.conversationId as string)).filter((m) => m.role === "assistant")).toHaveLength(1);
  });
});

describe("cancellation and explicit recovery", () => {
  it("cancelling during the retry delay stops at once, without another request", async () => {
    const provider = failFirst("openai", answer("openai"), [503, 503]);
    const s = await setup({ openai: provider, env: { PROVIDER_RETRY_BASE_MS: "10000", PROVIDER_TIMEOUT_MS: "60000" } });
    const address = await s.app.listen({ port: 0, host: "127.0.0.1" });
    const body = chatBody({ modelChoice: "openai" });
    const res = await fetch(`${address}/v1/chat/stream`, {
      method: "POST", headers: { ...s.user.auth, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const streamId = res.headers.get("x-stream-id")!;
    await waitFor(() => s.metrics.providerRetries.get({ provider: "openai", code: "provider_error" }) === 1);
    const cancelledAt = Date.now();
    await fetch(`${address}/v1/chat/streams/${streamId}/cancel`, { method: "POST", headers: s.user.auth });
    const events = sse(await res.text());
    expect(Date.now() - cancelledAt).toBeLessThan(2_000);
    expect(byEvent(events, "message.end")[0]!.data.finishReason).toBe("cancelled");
    expect(provider.attempts()).toBe(1);
    await waitFor(async () => (await s.context.store.listMessages(body.conversationId as string)).some((m) => m.role === "assistant" && m.status === "stopped"));
  });

  it("after a failure the user can explicitly switch provider; the conversation stays one ordered thread", async () => {
    const openai = failFirst("openai", answer("openai"), [503, 503, 503]);
    const anthropic = answer("anthropic");
    const s = await setup({ openai, anthropic });
    const first = await s.chat();
    expect(byEvent(first.events, "message.error")[0]!.data.recovery?.alternatives).toEqual(["anthropic"]);
    expect(anthropic.requests).toHaveLength(0);
    // The user picks Claude for the same message (the app's "retry with the other provider").
    const retry = await s.chat({ conversationId: first.body.conversationId, message: first.body.message, modelChoice: "claude" });
    expect(text(retry.events)).toBe("Recovered answer from anthropic.");
    const messages = await s.stored(first.body.conversationId as string);
    expect(messages.map((m) => [m.role, m.origin, m.status])).toEqual([["user", null, "complete"], ["assistant", "anthropic", "complete"]]);
  });

  it("Dash Smart never silently fails over to the provider the user did not get", async () => {
    const openai = failFirst("openai", answer("openai"), [503, 503, 503]);
    const anthropic = answer("anthropic");
    const s = await setup({ openai, anthropic });
    // General mode routes to OpenAI.
    const { events } = await s.chat({ modelChoice: "smart", mode: "general" });
    const start = byEvent(events, "stream.start")[0]!;
    expect(start.data.targets.map((t) => t.provider)).toEqual(["openai"]);
    expect(byEvent(events, "message.error")).toHaveLength(1);
    expect(anthropic.requests).toHaveLength(0);
  });

  it("Compare keeps the healthy answer when the other provider fails after retries", async () => {
    const openai = failFirst("openai", answer("openai"), [503, 503, 503]);
    const anthropic = answer("anthropic");
    const s = await setup({ openai, anthropic });
    const { events, body } = await s.chat({ modelChoice: "compare" });
    expect(byEvent(events, "message.error")).toHaveLength(1);
    expect(byEvent(events, "message.end")).toHaveLength(1);
    const statuses = (await s.stored(body.conversationId as string)).filter((m) => m.role === "assistant").map((m) => [m.origin, m.status]).sort();
    expect(statuses).toEqual([["anthropic", "complete"], ["openai", "failed"]]);
  });

  it("failure metadata in logs and metrics carries codes and counts only", async () => {
    const logs = new LogCapture();
    const provider = failFirst("openai", answer("openai"), [503, 503, 503]);
    const s = await setup({ openai: provider, logs });
    await s.chat({ message: { id: testId("msg"), content: "PROMPT-CANARY-77 please", attachmentIds: [] } });
    for (const out of [logs.text, s.metrics.render()]) {
      expect(out).not.toContain("PROMPT-CANARY-77");
      expect(out).not.toContain("SECRET-PROVIDER-TEXT");
    }
    expect(logs.text).toContain('"attempts":3');
    expect(s.metrics.providerFailures.get({ provider: "openai", code: "provider_error", retryable: true })).toBe(3);
  });
});
