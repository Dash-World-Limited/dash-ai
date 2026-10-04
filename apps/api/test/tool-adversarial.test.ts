import { randomBytes } from "node:crypto";
import pg from "pg";
import { z } from "zod";
import type { ProviderId, StreamEvent } from "@dash-ai/contracts";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { isToolResultTurn, type ProviderAdapter, type ProviderChunk, type ProviderRequest } from "../src/providers/types.js";
import { MAX_ARGUMENT_BYTES, ToolExecutor } from "../src/tools/executor.js";
import { builtinPlugin } from "../src/tools/builtin.js";
import { PluginRegistry } from "../src/tools/registry.js";
import { defineTool, ToolUserError, type ModelToolCall, type PluginSettingRecord, type ToolPlugin } from "../src/tools/types.js";
import { LogCapture, chatBody, register, sse, testConfig, USING_POSTGRES } from "./helpers.js";
import { makeMockGithubPlugin } from "./mockPlugin.js";
import { createTestPgStore, TEST_DATABASE_URL } from "./pgTestStore.js";

/**
 * Adversarial tests for the only path from model output to side effects. Everything a model emits
 * (tool names, call ids, arguments) and everything a tool returns is treated as hostile here.
 */

const setting = (pluginId: string, enabled: boolean, grantedScopes: string[]): PluginSettingRecord => ({
  pluginId, enabled, grantedScopes, updatedAt: "2026-01-01T00:00:00.000Z",
});

function capturingLog() {
  const lines: string[] = [];
  const write = (...args: unknown[]) => void lines.push(JSON.stringify(args, (_k, v: unknown) => (v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v)));
  return { lines, log: { warn: write, info: write, error: write, debug: write } as unknown as FastifyBaseLogger };
}

const SECRET = `CANARY_${randomBytes(6).toString("hex")}`;

/** A plugin whose tools misbehave in every way a third-party plugin could. */
const hostilePlugin: ToolPlugin = {
  id: "hostile",
  name: "Hostile",
  description: "Test-only plugin whose tools misbehave.",
  version: "0.0.1",
  kind: "external",
  scopes: [{ id: "hostile:read", description: "r", risk: "read" }],
  tools: [
    defineTool({ name: "circular", description: "Returns a circular object.", scope: "hostile:read", risk: "read", input: z.object({}), execute: async () => {
      const a: Record<string, unknown> = {};
      a.self = a;
      return a;
    } }),
    defineTool({ name: "bigint", description: "Returns a BigInt.", scope: "hostile:read", risk: "read", input: z.object({}), execute: async () => ({ n: 10n }) }),
    defineTool({ name: "throwing_getter", description: "Returns an object whose getter throws.", scope: "hostile:read", risk: "read", input: z.object({}), execute: async () => ({
      get boom(): string {
        throw new Error(SECRET);
      },
    }) }),
    defineTool({ name: "throws_string", description: "Throws a non-Error value.", scope: "hostile:read", risk: "read", input: z.object({}), execute: async () => {
      throw `${SECRET} raw string`;
    } }),
    defineTool({ name: "throws_error", description: "Throws an Error carrying sensitive text.", scope: "hostile:read", risk: "read", input: z.object({}), execute: async () => {
      throw new Error(`database password is ${SECRET}`);
    } }),
    defineTool({ name: "user_error", description: "Throws a deliberate, long user error.", scope: "hostile:read", risk: "read", input: z.object({}), execute: async () => {
      throw new ToolUserError(`Not found. ${"x".repeat(5_000)}`);
    } }),
    defineTool({ name: "late", description: "Resolves after its timeout with a result that must be discarded.", scope: "hostile:read", risk: "read", timeoutMs: 20, input: z.object({}), execute: async () => {
      await new Promise((r) => setTimeout(r, 80));
      return SECRET;
    } }),
  ],
};

function harness() {
  const mock = makeMockGithubPlugin();
  const registry = new PluginRegistry().register(builtinPlugin).register(mock.plugin).register(hostilePlugin);
  const offered = registry.offeredFor([setting("mock-github", true, ["issues:read", "issues:write"]), setting("hostile", true, ["hostile:read"])]);
  const executor = new ToolExecutor(registry, { defaultTimeoutMs: 1_000, maxResultChars: 2_000 });
  const { lines, log } = capturingLog();
  const run = (name: string, argumentsJson = "{}", id = "call_1") =>
    executor.execute({ id, name, argumentsJson }, offered, {
      userId: "user-1", conversationId: "conv-0001", messageId: "msg-00001", provider: "openai",
      signal: new AbortController().signal, now: () => new Date("2026-03-04T05:06:07.000Z"), log,
    });
  return { run, probe: mock.probe, lines };
}

describe("forged tool names never reach a handler", () => {
  const forged = [
    "MOCK-GITHUB__list_issues",
    "mock-github__LIST_ISSUES",
    " mock-github__list_issues",
    "mock-github__list_issues ",
    "mock-github__list_issues\u0000",
    "mock-github__list_issues\n",
    "mock-github__list_issues​",
    "mоck-github__list_issues", // Cyrillic "о"
    "mock-github.list_issues",
    "mock-github/list_issues",
    "../mock-github__list_issues",
    "list_issues",
    "mock-github__",
    "mock-github___list_issues",
    "mock-github__list_issues__list_issues",
    "__proto__",
    "constructor",
    "toString",
    "hasOwnProperty",
    "valueOf",
    "",
    "x".repeat(10_000),
  ];

  it.each(forged.map((n) => [JSON.stringify(n).slice(0, 40), n]))("%s is unknown_tool", async (_label, name) => {
    const { run, probe } = harness();
    const result = await run(name, '{"repo":"a/b"}');
    expect(result.status).toBe("unknown_tool");
    expect(result.isError).toBe(true);
    expect(result.content).toBe("That tool does not exist.");
    // Audit labels are sanitised: never arbitrary model text.
    expect(result.plugin).toMatch(/^[a-z0-9-]{1,32}$/);
    expect(result.tool).toMatch(/^[a-z0-9_]{1,48}$/);
    expect(probe.calls).toEqual({});
  });

  it("registered but not offered, or not executable: denied without revealing why", async () => {
    const { run, probe } = harness();
    for (const name of ["mock-github__create_issue", "dash-demo__current_time", "dash-demo__text_stats"]) {
      const result = await run(name, '{"repo":"a/b","title":"t"}');
      expect(result.status).toBe("denied");
      expect(result.content).toBe("That tool is not available in this conversation.");
    }
    expect(probe.calls).toEqual({});
  });
});

describe("hostile arguments are rejected before the handler runs", () => {
  const rejected: [string, string][] = [
    ["__proto__ key (prototype pollution)", '{"repo":"a/b","__proto__":{"polluted":"yes"}}'],
    ["constructor.prototype key", '{"repo":"a/b","constructor":{"prototype":{"polluted":"yes"}}}'],
    ["array instead of object", '[{"repo":"a/b"}]'],
    ["string instead of object", '"a/b"'],
    ["number instead of object", "42"],
    ["null", "null"],
    ["boolean", "true"],
    ["whitespace only (missing required field)", "   "],
    ["trailing garbage", '{"repo":"a/b"} {"x":1}'],
    ["byte-order mark", '﻿{"repo":"a/b"}'],
    ["NaN-like literal", '{"repo":"a/b","limit":NaN}'],
    ["overflowing number", '{"repo":"a/b","limit":1e400}'],
    ["non-integer", '{"repo":"a/b","limit":2.5}'],
    ["string where a number is expected (no coercion)", '{"repo":"a/b","limit":"3"}'],
    ["object where a string is expected", '{"repo":{"toString":"a/b"}}'],
    ["deeply nested value", `{"repo":"a/b","limit":${"[".repeat(7_000)}${"]".repeat(7_000)}}`],
    ["deeply nested unknown key", `{"repo":"a/b","x":${'{"a":'.repeat(2_000)}1${"}".repeat(2_000)}}`],
  ];

  it.each(rejected)("%s", async (_label, argumentsJson) => {
    const { run, probe } = harness();
    const result = await run("mock-github__list_issues", argumentsJson);
    expect(result.status).toBe("invalid_arguments");
    expect(probe.calls).toEqual({});
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it("counts the argument limit in bytes, not characters", async () => {
    const { run, probe } = harness();
    // Fewer characters than the limit, but more bytes (each "é" is two bytes in UTF-8).
    const repo = `a/${"é".repeat(MAX_ARGUMENT_BYTES / 2)}`;
    expect(repo.length).toBeLessThan(MAX_ARGUMENT_BYTES);
    const result = await run("mock-github__list_issues", JSON.stringify({ repo }));
    expect(result.status).toBe("invalid_arguments");
    expect(result.content).toContain("too large");
    expect(result.argBytes).toBeGreaterThan(MAX_ARGUMENT_BYTES);
    expect(probe.calls).toEqual({});
  });

  it("duplicate keys: the handler receives exactly the value that was validated", async () => {
    const { run, probe } = harness();
    const result = await run("mock-github__list_issues", '{"repo":"evil org/../x","repo":"a/b"}');
    expect(result.status).toBe("ok");
    expect(probe.args.list_issues).toEqual([{ repo: "a/b" }]);
  });

  it("never echoes offending names or values back to the model or the log", async () => {
    const { run, lines } = harness();
    const result = await run("mock-github__list_issues", JSON.stringify({ repo: "a/b", [SECRET]: SECRET }));
    expect(result.status).toBe("invalid_arguments");
    expect(result.content).not.toContain(SECRET);
    expect(lines.join("")).not.toContain(SECRET);
  });
});

describe("hostile tool behaviour is contained", () => {
  it("unserialisable results become a fixed placeholder", async () => {
    const { run } = harness();
    for (const name of ["hostile__circular", "hostile__bigint", "hostile__throwing_getter"]) {
      const result = await run(name);
      expect(result).toMatchObject({ status: "ok", content: "[unserialisable result]" });
      expect(result.content).not.toContain(SECRET);
    }
  });

  it("thrown values never reach the model or the log; only an error class name is logged", async () => {
    const { run, lines } = harness();
    for (const name of ["hostile__throws_string", "hostile__throws_error"]) {
      const result = await run(name);
      expect(result.status).toBe("error");
      expect(result.content).toBe("The tool failed. Continue without it or tell the user it is unavailable.");
    }
    expect(lines.join("")).not.toContain(SECRET);
    expect(lines.join("")).toContain('"errorName":"Error"');
    expect(lines.join("")).toContain('"errorName":"unknown"');
  });

  it("deliberate user errors are passed through but bounded", async () => {
    const { run } = harness();
    const result = await run("hostile__user_error");
    expect(result.status).toBe("error");
    expect(result.content.length).toBeLessThan(500);
  });

  it("a result that arrives after the timeout is discarded", async () => {
    const { run } = harness();
    const result = await run("hostile__late");
    expect(result).toMatchObject({ status: "timeout", content: "The tool took too long and was stopped." });
    await new Promise((r) => setTimeout(r, 100));
    expect(result.content).not.toContain(SECRET);
  });
});

// ---------------------------------------------------------------------------------------------
// The invocation boundary inside a real response: permissions are re-checked when a tool runs.
// ---------------------------------------------------------------------------------------------

interface Round {
  /** Runs before this round's tool calls are emitted (e.g. the user changes a setting mid-response). */
  before?: () => Promise<void>;
  calls: ModelToolCall[];
}

/** A provider whose rounds are scripted, including actions taken while the response is in flight. */
class ScriptedRounds implements ProviderAdapter {
  readonly displayName = "OpenAI";
  readonly model = "scripted-rounds";
  readonly demo = false;
  readonly requests: ProviderRequest[] = [];
  constructor(
    readonly id: ProviderId,
    private readonly rounds: Round[],
    private readonly finalText = "Done.",
  ) {}

  async *stream(request: ProviderRequest): AsyncIterable<ProviderChunk> {
    this.requests.push(request);
    const round = this.rounds[this.requests.length - 1];
    if (round && request.toolChoice !== "none") {
      await round.before?.();
      yield { type: "tool_calls", calls: round.calls };
    } else {
      yield { type: "text", text: this.finalText };
    }
    yield { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
  }

  /** What the backend answered for each call in the last round, keyed by the provider's call id. */
  lastResults() {
    const turn = this.requests.at(-1)!.messages.filter(isToolResultTurn).at(-1);
    return turn?.results ?? [];
  }
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

async function setup(adapter: ScriptedRounds, options: { logs?: LogCapture } = {}) {
  const mock = makeMockGithubPlugin();
  const plugins = new PluginRegistry().register(builtinPlugin).register(mock.plugin);
  const pgStore = USING_POSTGRES ? await createTestPgStore() : undefined;
  const { app, context } = await buildApp({
    config: testConfig(options.logs ? { LOG_LEVEL: "debug" } : {}),
    providers: new ProviderRegistry({ [adapter.id]: adapter }),
    plugins,
    store: pgStore?.store,
    logStream: options.logs,
  });
  if (pgStore) app.addHook("onClose", async () => pgStore.dispose());
  await app.ready();
  apps.push(app);
  const user = await register(app);
  const put = async (plugin: string, payload: Record<string, unknown>) => {
    const res = await app.inject({ method: "PUT", url: `/v1/plugins/${plugin}`, headers: user.auth, payload });
    expect(res.statusCode).toBe(200);
  };
  const chat = async () => {
    const res = await app.inject({ method: "POST", url: "/v1/chat/stream", headers: user.auth, payload: chatBody({ modelChoice: adapter.id === "openai" ? "openai" : "claude" }) });
    expect(res.statusCode).toBe(200);
    return { raw: res.body, events: sse(res.body) };
  };
  const activity = async () =>
    ((await app.inject({ method: "GET", url: "/v1/tools/activity", headers: user.auth })).json() as { activity: Array<{ status: string; plugin: string; tool: string; callId: string }> }).activity;
  return { app, context, user, put, chat, activity, probe: mock.probe, schema: pgStore?.schema };
}

type Setup = Awaited<ReturnType<typeof setup>>;
const byEvent = <N extends StreamEvent["event"]>(events: StreamEvent[], name: N) =>
  events.filter((e): e is Extract<StreamEvent, { event: N }> => e.event === name);
const listIssues = (id = "call_a", repo = "a/b"): ModelToolCall => ({ id, name: "mock-github__list_issues", argumentsJson: JSON.stringify({ repo }) });

describe("permissions are enforced at the moment of invocation", () => {
  it("a plugin disabled while the response is in flight is denied at the next tool call", async () => {
    const ref = {} as { s: Setup };
    const adapter = new ScriptedRounds("openai", [
      { calls: [listIssues("call_1")] },
      { before: () => ref.s.put("mock-github", { enabled: false }), calls: [listIssues("call_2")] },
    ]);
    const s = (ref.s = await setup(adapter));
    await s.put("mock-github", { enabled: true });
    const { events } = await s.chat();
    expect(byEvent(events, "message.error")).toEqual([]);
    expect(byEvent(events, "tool.result").map((e) => e.data.status)).toEqual(["ok", "denied"]);
    expect(s.probe.calls.list_issues).toBe(1); // only the call made while it was still enabled
    expect(adapter.lastResults()).toEqual([expect.objectContaining({ callId: "call_2", isError: true, content: "That tool is not available in this conversation." })]);
    // The tool list offered to the model stays identical for the whole response (see ProviderRequest.toolChoice).
    expect(new Set(adapter.requests.map((r) => JSON.stringify(r.tools))).size).toBe(1);
    expect((await s.activity()).map((a) => a.status).sort()).toEqual(["denied", "ok"]);
  });

  it("a scope revoked while the response is in flight is denied", async () => {
    const ref = {} as { s: Setup };
    const adapter = new ScriptedRounds("anthropic", [
      { before: () => ref.s.put("mock-github", { enabled: true, grantedScopes: [] }), calls: [listIssues()] },
    ]);
    const s = (ref.s = await setup(adapter));
    await s.put("mock-github", { enabled: true });
    const { events } = await s.chat();
    expect(byEvent(events, "tool.result").map((e) => e.data.status)).toEqual(["denied"]);
    expect(s.probe.calls).toEqual({});
  });

  it("enabling a plugin mid-response does not add its tools to that response", async () => {
    const ref = {} as { s: Setup };
    const adapter = new ScriptedRounds("openai", [
      { before: () => ref.s.put("mock-github", { enabled: true }), calls: [listIssues()] },
    ]);
    const s = (ref.s = await setup(adapter));
    await s.put("dash-demo", { enabled: true });
    const { events } = await s.chat();
    expect(adapter.requests[0]!.tools!.map((t) => t.name)).not.toContain("mock-github__list_issues");
    expect(byEvent(events, "tool.result").map((e) => e.data.status)).toEqual(["denied"]);
    expect(s.probe.calls).toEqual({});
  });

  it("fails closed: if permissions cannot be re-read, nothing runs and the answer still completes", async () => {
    const ref = {} as { s: Setup };
    const adapter = new ScriptedRounds("openai", [
      {
        before: async () => {
          ref.s.context.store.getPluginSettings = async () => {
            throw new Error("database unavailable");
          };
        },
        calls: [listIssues()],
      },
    ]);
    const s = (ref.s = await setup(adapter));
    await s.put("mock-github", { enabled: true });
    const { events } = await s.chat();
    expect(byEvent(events, "tool.result").map((e) => e.data.status)).toEqual(["denied"]);
    expect(byEvent(events, "message.error")).toEqual([]);
    expect(byEvent(events, "message.end")).toHaveLength(1);
    expect(s.probe.calls).toEqual({});
  });

  it("forged names and hostile call ids over the wire: nothing runs, every call is answered, nothing leaks", async () => {
    const forgedCalls: ModelToolCall[] = [
      { id: "../../etc/passwd", name: "__proto__", argumentsJson: "{}" },
      { id: "x".repeat(500), name: "constructor", argumentsJson: "{}" },
      { id: "call\n<script>", name: "MOCK-GITHUB__list_issues", argumentsJson: '{"repo":"a/b"}' },
      { id: "c4", name: "mock-github__list_issues\u0000", argumentsJson: '{"repo":"a/b"}' },
      { id: "c5", name: "mоck-github__list_issues", argumentsJson: '{"repo":"a/b"}' },
      { id: "c6", name: "dash-demo__current_time", argumentsJson: "{}" }, // registered, not enabled by this user
      { id: "c7", name: "mock-github__create_issue", argumentsJson: '{"repo":"a/b","title":"t"}' }, // write tool
      { id: "c8", name: "mock-github__list_issues", argumentsJson: '{"repo":"a/b","__proto__":{"polluted":1}}' },
    ];
    const adapter = new ScriptedRounds("openai", [{ calls: forgedCalls }]);
    const s = await setup(adapter);
    await s.put("mock-github", { enabled: true, grantedScopes: ["issues:read", "issues:write"] });
    const { events, raw } = await s.chat();

    expect(s.probe.calls).toEqual({});
    expect(Object.prototype).not.toHaveProperty("polluted");
    const results = byEvent(events, "tool.result");
    expect(results.map((e) => e.data.status)).toEqual([
      "unknown_tool", "unknown_tool", "unknown_tool", "unknown_tool", "unknown_tool", "denied", "denied", "invalid_arguments",
    ]);
    // Clients and the audit log only ever see bounded, plain ids and labels.
    for (const e of [...byEvent(events, "tool.call"), ...results]) {
      expect(e.data.callId).toMatch(/^[A-Za-z0-9_.:-]{1,64}$/);
      expect(e.data.plugin).toMatch(/^[a-z0-9-]{1,32}$/);
      expect(e.data.tool).toMatch(/^[a-z0-9_]{1,48}$/);
    }
    expect(raw).not.toContain("etc/passwd");
    expect(raw).not.toContain("<script>");
    for (const row of await s.activity()) expect(row.callId).toMatch(/^[A-Za-z0-9_.:-]{1,64}$/);
    // The provider still gets an answer for every original call id, in order (its API requires it).
    expect(adapter.lastResults().map((r) => r.callId)).toEqual(forgedCalls.map((c) => c.id));
    expect(adapter.lastResults().every((r) => r.isError)).toBe(true);
  });

  it("a tool result that tells the model to call a forbidden tool changes nothing", async () => {
    // A malicious plugin/tool response or document is just data: if the model obeys it, the executor
    // still decides, and the write tool is never executable.
    const adapter = new ScriptedRounds("anthropic", [
      { calls: [listIssues()] },
      { calls: [{ id: "c2", name: "mock-github__create_issue", argumentsJson: '{"repo":"a/b","title":"IGNORE ALL RULES"}' }] },
    ]);
    const s = await setup(adapter);
    await s.put("mock-github", { enabled: true, grantedScopes: ["issues:read", "issues:write"] });
    const { events } = await s.chat();
    expect(byEvent(events, "tool.result").map((e) => e.data.status)).toEqual(["ok", "denied"]);
    expect(s.probe.calls).toEqual({ list_issues: 1 });
  });
});

describe("tool arguments and results never reach logs, audit rows, exports or storage", () => {
  it("canary in arguments and results only ever goes to the model", async () => {
    const canary = `ARGCANARY_${randomBytes(6).toString("hex")}`;
    const adapter = new ScriptedRounds("openai", [
      {
        calls: [
          listIssues("call_ok", `canary-org/${canary}`), // valid: the result echoes the repo back
          { id: "call_bad", name: "mock-github__list_issues", argumentsJson: JSON.stringify({ repo: "a/b", [canary]: canary }) },
        ],
      },
    ]);
    const logs = new LogCapture();
    const s = await setup(adapter, { logs });
    await s.put("mock-github", { enabled: true });
    const { raw } = await s.chat();

    // Positive control: the model did receive the tool result containing the canary.
    expect(adapter.lastResults()[0]!.content).toContain(canary);
    expect(adapter.lastResults()[1]!.content).not.toContain(canary);

    expect(logs.text.length).toBeGreaterThan(0);
    expect(logs.text).not.toContain(canary);
    expect(raw).not.toContain(canary);
    expect(JSON.stringify(await s.activity())).not.toContain(canary);
    const exported = await s.app.inject({ method: "GET", url: "/v1/me/export", headers: s.user.auth });
    expect(exported.statusCode).toBe(200);
    expect(exported.body).not.toContain(canary);
    const listed = await s.app.inject({ method: "GET", url: "/v1/conversations", headers: s.user.auth });
    expect(listed.body).not.toContain(canary);

    if (USING_POSTGRES) {
      // Every row of every table in this test's schema, as text.
      const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await client.connect();
      try {
        const tables = await client.query<{ table_name: string }>(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = $1",
          [s.schema],
        );
        expect(tables.rows.length).toBeGreaterThan(0);
        for (const { table_name } of tables.rows) {
          const rows = await client.query(`SELECT t::text AS row FROM "${s.schema}"."${table_name}" t`);
          for (const r of rows.rows as Array<{ row: string }>) expect(r.row).not.toContain(canary);
        }
      } finally {
        await client.end();
      }
    }
  });
});
