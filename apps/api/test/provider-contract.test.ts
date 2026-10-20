import type { StreamEvent } from "@dash-ai/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { AnthropicAdapter, toAnthropicMessages } from "../src/providers/anthropic.js";
import { OpenAIAdapter, toOpenAIInput } from "../src/providers/openai.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import type { ProviderAdapter, ProviderChunk, ProviderRequest, ProviderTurn } from "../src/providers/types.js";
import { builtinPlugin } from "../src/tools/builtin.js";
import { PluginRegistry } from "../src/tools/registry.js";
import { chatBody, register, sse, testConfig } from "./helpers.js";
import { hasToolResult, scriptedProvider, type ModelPlan, type RecordedRequest } from "./providerServer.js";

const apps: FastifyInstance[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});
const byEvent = <N extends StreamEvent["event"]>(events: StreamEvent[], name: N) =>
  events.filter((e): e is Extract<StreamEvent, { event: N }> => e.event === name);

async function appWith(providers: ProviderRegistry, env: Record<string, string> = {}) {
  const { app } = await buildApp({ config: testConfig(env), providers, plugins: new PluginRegistry().register(builtinPlugin) });
  await app.ready();
  apps.push(app);
  const user = await register(app);
  await app.inject({ method: "PUT", url: "/v1/plugins/dash-demo", headers: user.auth, payload: { enabled: true } });
  return { app, auth: user.auth };
}

async function chat(app: FastifyInstance, auth: Record<string, string>, over: Record<string, unknown>) {
  const res = await app.inject({ method: "POST", url: "/v1/chat/stream", headers: auth, payload: chatBody(over) });
  expect(res.statusCode).toBe(200);
  return sse(res.body);
}

const toolThenAnswer = (kind: "openai" | "anthropic") => (req: RecordedRequest): ModelPlan =>
  hasToolResult(kind, req)
    ? { kind: "text", text: `${kind} used the tool.` }
    : { kind: "tool", name: "dash-demo__text_stats", args: { text: "alpha beta gamma" }, preface: "Checking." };

async function collect(iter: AsyncIterable<ProviderChunk>) {
  const out: ProviderChunk[] = [];
  for await (const c of iter) out.push(c);
  return out;
}
const req = (messages: ProviderTurn[], extra: Partial<ProviderRequest> = {}): ProviderRequest => ({
  system: "s", messages, maxOutputTokens: 256, signal: new AbortController().signal, ...extra,
});

describe("Claude thinking models: tool-use turns are replayed with their thinking blocks", () => {
  it("the scripted API enforces the rule: a rebuilt turn without thinking blocks is a 400", async () => {
    const claude = scriptedProvider("anthropic", toolThenAnswer("anthropic"), "m", { thinking: true });
    const adapter = new AnthropicAdapter("sk-ant-test-not-real", "m", { fetch: claude.fetch, maxRetries: 0 });
    const first = await collect(adapter.stream(req([{ role: "user", content: "count" }])));
    const calls = first.find((c) => c.type === "tool_calls")!;
    expect(calls.type === "tool_calls" && calls.continuation).toBeTruthy();
    // What the adapter did before this fix: rebuild the turn from text + tool_use only.
    const rebuilt: ProviderTurn[] = [
      { role: "user", content: "count" },
      { role: "assistant", content: "Checking.", toolCalls: calls.type === "tool_calls" ? calls.calls : [] },
      { role: "tool", results: [{ callId: "toolu_1", name: "dash-demo__text_stats", content: "{}", isError: false }] },
    ];
    await expect(collect(adapter.stream(req(rebuilt)))).rejects.toMatchObject({ code: "provider_error", httpStatus: 400 });
  });

  it.each(["claude", "smart", "compare"] as const)("%s: the tool loop completes and the turn goes back byte-for-byte", async (choice) => {
    const claude = scriptedProvider("anthropic", toolThenAnswer("anthropic"), "claude-thinking", { thinking: true });
    const openai = scriptedProvider("openai", toolThenAnswer("openai"));
    const providers = new ProviderRegistry({
      openai: new OpenAIAdapter("sk-test-not-a-real-key", "cfg-openai", { fetch: openai.fetch, maxRetries: 0 }),
      anthropic: new AnthropicAdapter("sk-ant-test-not-real", "cfg-claude", { fetch: claude.fetch, maxRetries: 0 }),
    });
    const { app, auth } = await appWith(providers);
    const events = await chat(app, auth, { modelChoice: choice, mode: "writing" });
    expect(byEvent(events, "message.error")).toEqual([]);
    expect(byEvent(events, "tool.result").map((e) => e.data.status)).toEqual(choice === "compare" ? ["ok", "ok"] : ["ok"]);
    const text = byEvent(events, "message.delta").map((d) => d.data.text).join("");
    expect(text).toContain("anthropic used the tool.");

    const second = claude.requests[1]!.body.messages as Array<{ role: string; content: unknown }>;
    const assistant = second.find((m) => m.role === "assistant")!;
    expect(assistant.content).toEqual([
      { type: "thinking", thinking: "", signature: "sig_1_abc" },
      { type: "redacted_thinking", data: "redacted_1" },
      { type: "text", text: "Checking." },
      { type: "tool_use", id: "toolu_1", name: "dash-demo__text_stats", input: { text: "alpha beta gamma" } },
    ]);
    // Thinking is provider state: it never reaches the other provider, the client, or storage.
    expect(JSON.stringify(openai.requests)).not.toContain("sig_1_abc");
    expect(JSON.stringify(events)).not.toContain("sig_1_abc");
  });

  it("falls back to rebuilding the turn when the continuation does not match the tool calls", () => {
    const turn: ProviderTurn = {
      role: "assistant", content: "x",
      toolCalls: [{ id: "toolu_9", name: "a__b", argumentsJson: "{}" }],
      continuation: { provider: "anthropic", content: [{ type: "tool_use", id: "toolu_OTHER", name: "a__b", input: {} }] },
    };
    expect(toAnthropicMessages([turn])[0]).toEqual({ role: "assistant", content: [{ type: "text", text: "x" }, { type: "tool_use", id: "toolu_9", name: "a__b", input: {} }] });
    // And another provider's continuation is never used.
    const foreign: ProviderTurn = { ...turn, continuation: { provider: "openai", items: [] } };
    expect(JSON.stringify(toAnthropicMessages([foreign]))).not.toContain("openai");
  });

  it("the last tool round switches tool use off with tool_choice none and keeps the tool set, so thinking still verifies", async () => {
    // A model that keeps asking for the tool whenever it is allowed to.
    const claude = scriptedProvider(
      "anthropic",
      (r) => (r.body.tool_choice?.type === "none" ? { kind: "text", text: "Answering with what I have." } : { kind: "tool", name: "dash-demo__text_stats", args: { text: "again" } }),
      "claude-thinking",
      { thinking: true },
    );
    const providers = new ProviderRegistry({ anthropic: new AnthropicAdapter("sk-ant-test-not-real", "cfg-claude", { fetch: claude.fetch, maxRetries: 0 }) });
    const { app, auth } = await appWith(providers, { TOOL_MAX_ROUNDS: "2" });
    const events = await chat(app, auth, { modelChoice: "claude" });
    // Dropping `tools` on the last round (the old behaviour) changes the tool set the replayed thinking was
    // produced under, which the API rejects.
    expect(byEvent(events, "message.error")).toEqual([]);
    expect(claude.requests.map((r) => r.body.tool_choice?.type ?? "auto")).toEqual(["auto", "auto", "none"]);
    expect(new Set(claude.requests.map((r) => JSON.stringify(r.body.tools))).size).toBe(1);
    expect(byEvent(events, "message.delta").map((d) => d.data.text).join("")).toContain("Answering with what I have.");

    // And a tool set that changes mid-loop is what the scripted API refuses.
    const changed = scriptedProvider("anthropic", toolThenAnswer("anthropic"), "m", { thinking: true });
    const adapter = new AnthropicAdapter("sk-ant-test-not-real", "m", { fetch: changed.fetch, maxRetries: 0 });
    const tools = [{ name: "dash-demo__text_stats", description: "d", inputSchema: { type: "object", properties: {} } }];
    const first = await collect(adapter.stream(req([{ role: "user", content: "count" }], { tools })));
    const calls = first.find((c) => c.type === "tool_calls");
    if (calls?.type !== "tool_calls") throw new Error("expected tool calls");
    const turns: ProviderTurn[] = [
      { role: "user", content: "count" },
      { role: "assistant", content: "Checking.", toolCalls: calls.calls, continuation: calls.continuation },
      { role: "tool", results: [{ callId: calls.calls[0]!.id, name: "dash-demo__text_stats", content: "{}", isError: false }] },
    ];
    await expect(collect(adapter.stream(req(turns)))).rejects.toMatchObject({ code: "provider_error", httpStatus: 400 });
    await expect(collect(adapter.stream(req(turns, { tools, toolChoice: "none" })))).resolves.toBeDefined();
  });

  it("tool calls a model emits after tool use was switched off are ignored: nothing runs", async () => {
    const claude = scriptedProvider("anthropic", () => ({ kind: "tool", name: "dash-demo__text_stats", args: { text: "x" } }), "m", { thinking: true });
    const providers = new ProviderRegistry({ anthropic: new AnthropicAdapter("sk-ant-test-not-real", "cfg-claude", { fetch: claude.fetch, maxRetries: 0 }) });
    const { app, auth } = await appWith(providers, { TOOL_MAX_ROUNDS: "1" });
    const events = await chat(app, auth, { modelChoice: "claude" });
    expect(claude.requests).toHaveLength(2);
    expect(byEvent(events, "tool.result")).toHaveLength(1); // only the round where tool use was allowed
    // It never wrote an answer: that ends as a retryable failure, not as an empty "complete" reply.
    expect(byEvent(events, "message.end")).toHaveLength(0);
    expect(byEvent(events, "message.error").map((e) => [e.data.error.code, e.data.error.retryable])).toEqual([["provider_error", true]]);
  });

  it("counts prompt-cache reads and writes as input tokens", async () => {
    const body = [
      ["message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 } } }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }],
      ["message_stop", { type: "message_stop" }],
    ].map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
    const adapter = new AnthropicAdapter("k", "m", { maxRetries: 0, fetch: (async () => new Response(body, { headers: { "content-type": "text/event-stream" } })) as typeof fetch });
    expect((await collect(adapter.stream(req([{ role: "user", content: "x" }])))).at(-1)).toMatchObject({ usage: { inputTokens: 1110, outputTokens: 5 } });
  });
});

describe("OpenAI reasoning models: encrypted reasoning replay (opt-in)", () => {
  const run = async (encryptedReasoning: boolean) => {
    const openai = scriptedProvider("openai", toolThenAnswer("openai"), "o-reasoner", { reasoning: true });
    const providers = new ProviderRegistry({ openai: new OpenAIAdapter("sk-test-not-a-real-key", "cfg", { fetch: openai.fetch, maxRetries: 0, encryptedReasoning }) });
    const { app, auth } = await appWith(providers);
    const events = await chat(app, auth, { modelChoice: "openai" });
    return { openai, events };
  };

  it("off (default): no include, the turn is rebuilt without item ids, and the loop works", async () => {
    const { openai, events } = await run(false);
    expect(byEvent(events, "message.error")).toEqual([]);
    expect(openai.requests[0]!.body).not.toHaveProperty("include");
    const input = openai.requests[1]!.body.input as Array<Record<string, unknown>>;
    expect(input.some((i) => i.type === "reasoning")).toBe(false);
    expect(input.find((i) => i.type === "function_call")).not.toHaveProperty("id");
  });

  it("on: requests encrypted reasoning and replays it with the function call, in order", async () => {
    const { openai, events } = await run(true);
    expect(byEvent(events, "message.error")).toEqual([]);
    expect(openai.requests[0]!.body.include).toEqual(["reasoning.encrypted_content"]);
    const types = (openai.requests[1]!.body.input as Array<{ type?: string; role?: string }>).map((i) => i.type ?? i.role);
    expect(types).toEqual(["user", "reasoning", "function_call", "function_call_output"]);
    const reasoning = (openai.requests[1]!.body.input as Array<Record<string, unknown>>).find((i) => i.type === "reasoning");
    expect(reasoning).toMatchObject({ id: "rs_1", encrypted_content: "enc_1" });
  });

  it("an OpenAI continuation is never sent to Claude and a mismatched one is ignored", () => {
    const turn: ProviderTurn = {
      role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "a__b", argumentsJson: "{}" }],
      continuation: { provider: "openai", items: [{ type: "function_call", call_id: "call_OTHER", name: "a__b", arguments: "{}" }] },
    };
    expect(toOpenAIInput([turn])).toEqual([{ type: "function_call", call_id: "call_1", name: "a__b", arguments: "{}" }]);
  });
});

describe("malformed and failing provider responses", () => {
  type Raw = (signal?: AbortSignal | null) => Response;
  const adapters = (raw: Raw): Array<[string, ProviderAdapter]> => {
    const f = (async (_i: unknown, init?: RequestInit) => raw(init?.signal)) as typeof fetch;
    return [
      ["openai", new OpenAIAdapter("sk-test-not-a-real-key", "m", { fetch: f, maxRetries: 0 })],
      ["anthropic", new AnthropicAdapter("sk-ant-test-not-real", "m", { fetch: f, maxRetries: 0 })],
    ];
  };
  const sseRes = (text: string) => new Response(text, { headers: { "content-type": "text/event-stream" } });

  it("invalid JSON in an event is a retryable provider error that leaks nothing", async () => {
    for (const [name, adapter] of adapters(() => sseRes("event: message_start\ndata: {not json SECRET-PAYLOAD\n\n"))) {
      const error = await collect(adapter.stream(req([{ role: "user", content: "x" }]))).then(() => null, (e: unknown) => e as { code: string; message: string; retryable: boolean });
      expect(error, name).toMatchObject({ code: "provider_error", retryable: true });
      expect(error!.message).not.toContain("SECRET-PAYLOAD");
    }
  });

  it("an HTML page or empty body instead of a stream is an error, never an empty 'complete' answer", async () => {
    for (const body of ["<html>gateway</html>", ""]) {
      for (const [name, adapter] of adapters(() => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }))) {
        await expect(collect(adapter.stream(req([{ role: "user", content: "x" }]))), `${name}:${body}`).rejects.toMatchObject({ code: "provider_error" });
      }
    }
  });

  it("a connection reset mid-stream keeps the text already received and fails retryably", async () => {
    const enc = new TextEncoder();
    const resetting = (first: string) => () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(enc.encode(first));
            setTimeout(() => c.error(new TypeError("terminated")), 5);
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    const openaiFirst = `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "Partial", item_id: "i", output_index: 0, content_index: 0, sequence_number: 1, logprobs: [] })}\n\n`;
    const claudeFirst = [
      ["message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Partial" } }],
    ].map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
    for (const [name, adapter, first] of [
      ["openai", adapters(resetting(openaiFirst))[0]![1], openaiFirst],
      ["anthropic", adapters(resetting(claudeFirst))[1]![1], claudeFirst],
    ] as const) {
      const seen: string[] = [];
      const error = await (async () => {
        for await (const c of adapter.stream(req([{ role: "user", content: "x" }]))) if (c.type === "text") seen.push(c.text);
      })().then(() => null, (e: unknown) => e as { code: string; retryable: boolean });
      expect(seen, name).toEqual(["Partial"]);
      expect(error, name).toMatchObject({ code: "provider_error", retryable: true });
      expect(first.length).toBeGreaterThan(0);
    }
  });

  it("unknown event types are ignored and the stream still completes", async () => {
    const claude = [
      ["message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
      ["future_event", { type: "future_event", whatever: true }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }],
      ["message_stop", { type: "message_stop" }],
    ].map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
    const adapter = adapters(() => sseRes(claude))[1]![1];
    const chunks = await collect(adapter.stream(req([{ role: "user", content: "x" }])));
    expect(chunks.filter((c) => c.type === "text")).toEqual([{ type: "text", text: "ok" }]);
    expect(chunks.at(-1)).toMatchObject({ type: "finish", finishReason: "stop" });
  });

  it("tool calls with broken arguments or names are refused by the backend, and the loop still finishes", async () => {
    for (const kind of ["openai", "anthropic"] as const) {
      for (const bad of [{ name: "dash-demo__text_stats", args: "{not json" }, { name: "", args: "{}" }, { name: "dash-demo__text_stats ; rm -rf /", args: "{}" }]) {
        const provider = scriptedProvider(kind, (r) =>
          hasToolResult(kind, r) ? { kind: "text", text: "recovered" } : { kind: "tool", name: bad.name, args: "__RAW__" },
        );
        // Swap the serialized arguments for the raw broken text the model "emitted".
        const raw = provider.fetch;
        const patched = (async (input: string | URL | Request, init?: RequestInit) => {
          const res = await raw(input, init);
          const text = (await res.text()).split(JSON.stringify(JSON.stringify("__RAW__"))).join(JSON.stringify(bad.args)).split(JSON.stringify("__RAW__")).join(JSON.stringify(bad.args));
          return new Response(text, { status: res.status, headers: res.headers });
        }) as typeof fetch;
        const adapter = kind === "openai"
          ? new OpenAIAdapter("sk-test-not-a-real-key", "m", { fetch: patched, maxRetries: 0 })
          : new AnthropicAdapter("sk-ant-test-not-real", "m", { fetch: patched, maxRetries: 0 });
        const { app, auth } = await appWith(new ProviderRegistry({ [kind]: adapter }));
        const events = await chat(app, auth, { modelChoice: kind === "openai" ? "openai" : "claude" });
        const status = byEvent(events, "tool.result")[0]?.data.status;
        expect(["invalid_arguments", "unknown_tool"], `${kind} ${JSON.stringify(bad)}`).toContain(status);
        expect(byEvent(events, "message.end")[0]?.data.finishReason).toBe("stop");
      }
    }
  });

  it("a provider that stalls mid-stream is cut off by the idle timeout through the real SDK", async () => {
    const enc = new TextEncoder();
    const stall = () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(enc.encode(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "Start", item_id: "i", output_index: 0, content_index: 0, sequence_number: 1, logprobs: [] })}\n\n`));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    const adapter = new OpenAIAdapter("sk-test-not-a-real-key", "m", { fetch: (async () => stall()) as typeof fetch, maxRetries: 0 });
    const { app, auth } = await appWith(new ProviderRegistry({ openai: adapter }), { PROVIDER_IDLE_TIMEOUT_MS: "500" });
    const started = Date.now();
    const events = await chat(app, auth, { modelChoice: "openai" });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(byEvent(events, "message.error")[0]?.data.error).toMatchObject({ code: "provider_timeout", retryable: true });
  });

  it("provider outages surface as retryable errors per target, and Compare keeps the healthy answer", async () => {
    const down = (async () => new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), { status: 529, headers: { "content-type": "application/json" } })) as typeof fetch;
    const openai = scriptedProvider("openai", () => ({ kind: "text", text: "OpenAI is fine." }));
    const providers = new ProviderRegistry({
      openai: new OpenAIAdapter("sk-test-not-a-real-key", "m", { fetch: openai.fetch, maxRetries: 0 }),
      anthropic: new AnthropicAdapter("sk-ant-test-not-real", "m", { fetch: down, maxRetries: 0 }),
    });
    const { app, auth } = await appWith(providers);
    const events = await chat(app, auth, { modelChoice: "compare" });
    expect(byEvent(events, "message.error").map((e) => e.data.error)).toEqual([expect.objectContaining({ code: "provider_error", retryable: true })]);
    expect(byEvent(events, "message.end")).toHaveLength(1);
    expect(byEvent(events, "message.delta").map((d) => d.data.text).join("")).toContain("OpenAI is fine.");
  });
});
