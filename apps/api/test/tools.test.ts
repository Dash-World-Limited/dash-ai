import { z } from "zod";
import { describe, expect, it } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import { OpenAIAdapter, toOpenAIInput, toOpenAITools } from "../src/providers/openai.js";
import { AnthropicAdapter, toAnthropicMessages, toAnthropicTools } from "../src/providers/anthropic.js";
import type { ProviderChunk, ProviderTurn } from "../src/providers/types.js";
import { ToolExecutor } from "../src/tools/executor.js";
import { builtinPlugin } from "../src/tools/builtin.js";
import { OfferedTools, PluginRegistrationError, PluginRegistry } from "../src/tools/registry.js";
import { defineTool, type PluginSettingRecord, type ToolPlugin } from "../src/tools/types.js";
import { makeMockGithubPlugin } from "./mockPlugin.js";
import { scriptedProvider } from "./providerServer.js";

const silentLog = { warn: () => undefined, info: () => undefined, error: () => undefined } as unknown as FastifyBaseLogger;
const setting = (pluginId: string, enabled: boolean, grantedScopes: string[]): PluginSettingRecord => ({
  pluginId, enabled, grantedScopes, updatedAt: "2026-01-01T00:00:00.000Z",
});
const ctxFor = (signal = new AbortController().signal) => ({
  userId: "user-1", conversationId: "conv-0001", messageId: "msg-00001", provider: "openai" as const,
  signal, now: () => new Date("2026-03-04T05:06:07.000Z"), log: silentLog,
});

function registry() {
  const mock = makeMockGithubPlugin();
  const reg = new PluginRegistry().register(builtinPlugin).register(mock.plugin);
  return { reg, ...mock };
}

describe("PluginRegistry registration", () => {
  const base = (over: Partial<ToolPlugin> = {}): ToolPlugin => ({
    id: "sample", name: "Sample", description: "d", version: "1", kind: "builtin",
    scopes: [{ id: "sample:read", description: "r", risk: "read" }],
    tools: [defineTool({ name: "ping", description: "Ping", scope: "sample:read", risk: "read", input: z.object({}), execute: async () => "pong" })],
    ...over,
  });

  it("rejects malformed or conflicting plugins", () => {
    expect(() => new PluginRegistry().register(base({ id: "Bad Id" }))).toThrow(PluginRegistrationError);
    expect(() => new PluginRegistry().register(base()).register(base())).toThrow(/already registered/);
    expect(() => new PluginRegistry().register(base({ scopes: [] }))).toThrow(/undeclared scope/);
    const tool = (name: string) => defineTool({ name, description: "x", scope: "sample:read", risk: "read", input: z.object({}), execute: async () => "" });
    expect(() => new PluginRegistry().register(base({ tools: [tool("a_tool"), tool("a_tool")] }))).toThrow(/Duplicate tool/);
    expect(() => new PluginRegistry().register(base({ tools: [tool("Bad-Name")] }))).toThrow(/Invalid tool name/);
    expect(() => new PluginRegistry().register(base({ id: "p".repeat(32), tools: [tool("t".repeat(48))] }))).toThrow(/valid provider function name/);
    const writer = defineTool({ name: "writer", description: "x", scope: "sample:read", risk: "write", input: z.object({}), execute: async () => "" });
    expect(() => new PluginRegistry().register(base({ tools: [writer] }))).toThrow(/read-only/);
  });

  it("derives a provider-neutral JSON Schema from the zod input", () => {
    const { reg } = registry();
    const tool = reg.findTool("mock-github__list_issues")!;
    expect(tool.normalized.name).toBe("mock-github__list_issues");
    expect(tool.normalized.inputSchema).toMatchObject({
      type: "object",
      properties: { repo: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 5 } },
      required: ["repo"],
    });
    expect(tool.normalized.inputSchema).not.toHaveProperty("$schema");
  });
});

describe("permission model (offeredFor)", () => {
  it("offers nothing by default", () => {
    const { reg } = registry();
    expect(reg.offeredFor([]).size).toBe(0);
  });

  it("offers only enabled plugins' tools whose scope the user granted", () => {
    const { reg } = registry();
    const names = (s: PluginSettingRecord[]) => reg.offeredFor(s).list().map((t) => t.name).sort();
    expect(names([setting("mock-github", false, ["issues:read"])])).toEqual([]);
    expect(names([setting("mock-github", true, [])])).toEqual([]);
    expect(names([setting("dash-demo", true, ["demo:read"])])).toEqual(["dash-demo__current_time", "dash-demo__text_stats"]);
    const github = names([setting("mock-github", true, ["issues:read"])]);
    expect(github).toContain("mock-github__list_issues");
    expect(github).not.toContain("mock-github__create_issue");
  });

  it("never offers write tools, even when the user granted the write scope", () => {
    const { reg } = registry();
    const offered = reg.offeredFor([setting("mock-github", true, ["issues:read", "issues:write"])]);
    expect(offered.get("mock-github__create_issue")).toBeUndefined();
    const info = reg.describe([setting("mock-github", true, ["issues:read", "issues:write"])]).find((p) => p.id === "mock-github")!;
    expect(info.tools.find((t) => t.name === "create_issue")).toMatchObject({ risk: "write", executable: false });
  });

  it("ignores settings for plugins this server does not have", () => {
    const { reg } = registry();
    expect(reg.offeredFor([setting("uninstalled", true, ["x:read"])]).size).toBe(0);
  });
});

describe("ToolExecutor", () => {
  const setup = (maxResultChars = 20_000, defaultTimeoutMs = 5_000) => {
    const r = registry();
    const executor = new ToolExecutor(r.reg, { defaultTimeoutMs, maxResultChars });
    const offered = r.reg.offeredFor([setting("mock-github", true, ["issues:read"]), setting("dash-demo", true, ["demo:read"])]);
    const run = (name: string, argumentsJson: string, over: { offered?: OfferedTools; signal?: AbortSignal } = {}) =>
      executor.execute({ id: "call_1", name, argumentsJson }, over.offered ?? offered, ctxFor(over.signal));
    return { ...r, executor, offered, run };
  };

  it("runs a valid call and returns JSON text", async () => {
    const { run, probe } = setup();
    const result = await run("mock-github__list_issues", '{"repo":"dash/dash-ai","limit":1}');
    expect(result).toMatchObject({ status: "ok", isError: false, plugin: "mock-github", tool: "list_issues" });
    expect(JSON.parse(result.content)).toEqual({ repo: "dash/dash-ai", issues: [{ number: 1, title: "Mocked issue one" }] });
    expect(probe.calls.list_issues).toBe(1);
  });

  it("runs the built-in demo tools", async () => {
    const { run } = setup();
    const time = await run("dash-demo__current_time", '{"timeZone":"Africa/Lagos"}');
    expect(JSON.parse(time.content)).toMatchObject({ utc: "2026-03-04T05:06:07.000Z", timeZone: "Africa/Lagos" });
    const stats = await run("dash-demo__text_stats", '{"text":"one two\\nthree"}');
    expect(JSON.parse(stats.content)).toEqual({ characters: 13, words: 3, lines: 2 });
    const bad = await run("dash-demo__current_time", '{"timeZone":"Mars/Olympus"}');
    expect(bad).toMatchObject({ status: "error", isError: true });
    expect(bad.content).toContain("not a valid IANA time zone");
  });

  it("refuses unknown tools without running anything", async () => {
    const { run, probe } = setup();
    const r = await run("mock-github__does_not_exist", "{}");
    expect(r.status).toBe("unknown_tool");
    expect(await run("totally made up; rm -rf /", "{}")).toMatchObject({ status: "unknown_tool", plugin: "unknown", tool: "unknown" });
    expect(Object.keys(probe.calls)).toEqual([]);
  });

  it("denies registered tools that were not offered to this request", async () => {
    const { run, probe } = setup();
    const none = await run("mock-github__list_issues", '{"repo":"a/b"}', { offered: OfferedTools.none });
    expect(none.status).toBe("denied");
    // The write tool is registered but not offered, and refusing it does not reveal that it exists.
    const write = await run("mock-github__create_issue", '{"repo":"a/b","title":"t"}');
    expect(write.status).toBe("denied");
    expect(write.content).toBe("That tool is not available in this conversation.");
    expect(probe.calls.list_issues).toBeUndefined();
    expect(probe.calls.create_issue).toBeUndefined();
  });

  it("refuses write tools even if something offered them (defence in depth)", async () => {
    const { reg, executor, probe } = setup();
    const forced = new OfferedTools(new Map([["mock-github__create_issue", reg.findTool("mock-github__create_issue")!]]));
    const r = await executor.execute({ id: "c", name: "mock-github__create_issue", argumentsJson: '{"repo":"a/b","title":"t"}' }, forced, ctxFor());
    expect(r.status).toBe("denied");
    expect(probe.calls.create_issue).toBeUndefined();
  });

  it("validates arguments strictly", async () => {
    const { run, probe } = setup();
    const cases: Array<[string, string]> = [
      ["not json", "{nope"],
      ["missing field", "{}"],
      ["wrong type", '{"repo":42}'],
      ["pattern", '{"repo":"../../etc/passwd"}'],
      ["out of range", '{"repo":"a/b","limit":99}'],
      ["unknown property", '{"repo":"a/b","admin":true}'],
      ["not an object", '"a/b"'],
      ["too large", JSON.stringify({ repo: "a/b", pad: "x".repeat(20_000) })],
    ];
    for (const [label, json] of cases) {
      const r = await run("mock-github__list_issues", json);
      expect(r.status, label).toBe("invalid_arguments");
      expect(r.isError).toBe(true);
    }
    expect(probe.calls.list_issues).toBeUndefined();
  });

  it("does not echo offending argument values back to the model", async () => {
    const { run } = setup();
    const r = await run("mock-github__list_issues", '{"repo":"SECRET-VALUE-123"}');
    expect(r.content).not.toContain("SECRET-VALUE-123");
  });

  it("times out handlers that ignore their abort signal", async () => {
    const { run, probe } = setup();
    const started = Date.now();
    const r = await run("mock-github__slow_lookup", "{}");
    expect(r.status).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(probe.aborted).toBe(1);
  });

  it("stops when the response is cancelled", async () => {
    const { run } = setup();
    const controller = new AbortController();
    const pending = run("mock-github__hang_until_aborted", "{}", { signal: controller.signal });
    setTimeout(() => controller.abort("cancelled"), 30);
    expect((await pending).status).toBe("cancelled");
    const already = new AbortController();
    already.abort("cancelled");
    expect((await run("mock-github__list_issues", '{"repo":"a/b"}', { signal: already.signal })).status).toBe("cancelled");
  });

  it("hides internal error details but passes through deliberate user errors", async () => {
    const { run } = setup();
    const boom = await run("mock-github__explode", "{}");
    expect(boom.status).toBe("error");
    expect(boom.content).not.toMatch(/hunter2|db\.internal|password/);
    const polite = await run("mock-github__polite_failure", "{}");
    expect(polite).toMatchObject({ status: "error" });
    expect(polite.content).toContain("Repository not found.");
  });

  it("bounds oversized results", async () => {
    const { run } = setup(1_000);
    const r = await run("mock-github__big_output", "{}");
    expect(r.status).toBe("ok");
    expect(r.content.length).toBeLessThan(1_100);
    expect(r.content).toContain("output truncated");
  });
});

// ---- provider adapters: the same internal definitions in two wire formats -----------------------

describe("provider adapters translate the same tool definitions", () => {
  const { reg } = registry();
  const tools = [reg.findTool("mock-github__list_issues")!.normalized, reg.findTool("dash-demo__text_stats")!.normalized];

  it("OpenAI function tools", () => {
    expect(toOpenAITools(tools)[0]).toEqual({
      type: "function",
      name: "mock-github__list_issues",
      description: "Lists open issues of a repository.",
      parameters: tools[0]!.inputSchema,
      strict: false,
    });
  });

  it("Anthropic tools", () => {
    expect(toAnthropicTools(tools)[0]).toEqual({
      name: "mock-github__list_issues",
      description: "Lists open issues of a repository.",
      input_schema: tools[0]!.inputSchema,
    });
  });

  const turns: ProviderTurn[] = [
    { role: "user", content: "List issues" },
    { role: "assistant", content: "Checking.", toolCalls: [{ id: "call_1", name: "mock-github__list_issues", argumentsJson: '{"repo":"a/b"}' }] },
    { role: "tool", results: [{ callId: "call_1", name: "mock-github__list_issues", content: '{"issues":[]}', isError: false }] },
  ];

  it("OpenAI replays calls and results as function_call / function_call_output items", () => {
    expect(toOpenAIInput(turns)).toEqual([
      { role: "user", content: "List issues" },
      { role: "assistant", content: "Checking." },
      { type: "function_call", call_id: "call_1", name: "mock-github__list_issues", arguments: '{"repo":"a/b"}' },
      { type: "function_call_output", call_id: "call_1", output: '{"issues":[]}' },
    ]);
  });

  it("Anthropic replays calls as tool_use blocks and results as a user tool_result turn", () => {
    expect(toAnthropicMessages(turns)).toEqual([
      { role: "user", content: "List issues" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Checking." },
          { type: "tool_use", id: "call_1", name: "mock-github__list_issues", input: { repo: "a/b" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: '{"issues":[]}', is_error: false }] },
    ]);
  });

  it("Anthropic omits empty text blocks and survives unparseable argument text", () => {
    const out = toAnthropicMessages([{ role: "assistant", content: "", toolCalls: [{ id: "c", name: "x__y", argumentsJson: "{broken" }] }]);
    expect(out[0]).toEqual({ role: "assistant", content: [{ type: "tool_use", id: "c", name: "x__y", input: {} }] });
  });

  async function collect(iter: AsyncIterable<ProviderChunk>) {
    const out: ProviderChunk[] = [];
    for await (const c of iter) out.push(c);
    return out;
  }

  it("OpenAI: sends tools and parses structured function calls from the stream", async () => {
    const p = scriptedProvider("openai", () => ({ kind: "tool", name: "dash-demo__text_stats", args: { text: "a b c" }, preface: "One moment." }));
    const adapter = new OpenAIAdapter("sk-test-not-a-real-key", "cfg", { fetch: p.fetch, maxRetries: 0 });
    const chunks = await collect(adapter.stream({ system: "s", messages: [{ role: "user", content: "count" }], tools, maxOutputTokens: 64, signal: new AbortController().signal }));
    expect(p.requests[0]!.body.tools).toHaveLength(2);
    expect(p.requests[0]!.body.tool_choice).toBe("auto");
    expect(chunks.filter((c) => c.type === "text")).toEqual([{ type: "text", text: "One moment." }]);
    expect(chunks.find((c) => c.type === "tool_calls")).toEqual({
      type: "tool_calls",
      calls: [{ id: "call_oa_1", name: "dash-demo__text_stats", argumentsJson: '{"text":"a b c"}' }],
    });
    expect(chunks.at(-1)).toMatchObject({ type: "finish", finishReason: "stop", servedModel: "served-openai" });
  });

  it("OpenAI: sends no tools field when none are offered", async () => {
    const p = scriptedProvider("openai", () => ({ kind: "text", text: "hi" }));
    const adapter = new OpenAIAdapter("sk-test-not-a-real-key", "cfg", { fetch: p.fetch, maxRetries: 0 });
    await collect(adapter.stream({ system: "s", messages: [{ role: "user", content: "x" }], maxOutputTokens: 64, signal: new AbortController().signal }));
    expect(p.requests[0]!.body).not.toHaveProperty("tools");
  });

  it("Anthropic: sends tools and assembles tool_use input from partial JSON fragments", async () => {
    const p = scriptedProvider("anthropic", () => ({ kind: "tool", name: "mock-github__list_issues", args: { repo: "a/b", limit: 2 }, preface: "Looking." }));
    const adapter = new AnthropicAdapter("sk-ant-test-not-real", "cfg", { fetch: p.fetch, maxRetries: 0 });
    const chunks = await collect(adapter.stream({ system: "s", messages: [{ role: "user", content: "issues" }], tools, maxOutputTokens: 64, signal: new AbortController().signal }));
    expect(p.requests[0]!.body.tools).toHaveLength(2);
    expect(chunks.find((c) => c.type === "tool_calls")).toEqual({
      type: "tool_calls",
      calls: [{ id: "toolu_1", name: "mock-github__list_issues", argumentsJson: '{"repo":"a/b","limit":2}' }],
    });
    expect(chunks.at(-1)).toMatchObject({ type: "finish", finishReason: "stop", servedModel: "served-anthropic" });
  });

  it("neither adapter turns plain text into tool calls", async () => {
    const lookalike = '{"tool_call":{"name":"dash-demo__current_time","arguments":{}}}';
    for (const [kind, make] of [
      ["openai", (f: typeof fetch) => new OpenAIAdapter("sk-test-not-a-real-key", "c", { fetch: f, maxRetries: 0 })],
      ["anthropic", (f: typeof fetch) => new AnthropicAdapter("sk-ant-test-not-real", "c", { fetch: f, maxRetries: 0 })],
    ] as const) {
      const p = scriptedProvider(kind, () => ({ kind: "text", text: lookalike }));
      const chunks = await collect(make(p.fetch).stream({ system: "s", messages: [{ role: "user", content: "x" }], tools, maxOutputTokens: 64, signal: new AbortController().signal }));
      expect(chunks.some((c) => c.type === "tool_calls")).toBe(false);
      expect(chunks.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("")).toBe(lookalike);
    }
  });
});
