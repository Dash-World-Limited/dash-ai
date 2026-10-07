import { z } from "zod";
import type { ProviderId, StreamEvent } from "@dash-ai/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { isToolResultTurn, type ProviderAdapter, type ProviderChunk, type ProviderRequest, type ProviderToolResult } from "../src/providers/types.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import type { Store } from "../src/store/store.js";
import { DUPLICATE_TEXT, executionKey } from "../src/tools/executor.js";
import { builtinPlugin } from "../src/tools/builtin.js";
import { PluginRegistrationError, PluginRegistry } from "../src/tools/registry.js";
import { defineTool, type ModelToolCall } from "../src/tools/types.js";
import { chatBody, register, sse, testConfig, testId, USING_POSTGRES } from "./helpers.js";
import { makeMockGithubPlugin, type MockPluginProbe } from "./mockPlugin.js";
import { createTestPgStore } from "./pgTestStore.js";

/**
 * Exactly-once behaviour of tool execution under transport problems. Read-only tools may be
 * repeated on purpose; tools that change things ("per-message" idempotency) must never run twice
 * for the same user message, whatever the call ids, retries, re-sends or restarts.
 */

type Step = ModelToolCall[] | "fail" | "stall" | "text";

/** A provider whose requests follow a script, one step per request. */
class Script implements ProviderAdapter {
  readonly displayName = "OpenAI";
  readonly model = "script";
  readonly demo = false;
  readonly requests: ProviderRequest[] = [];
  constructor(readonly id: ProviderId, private readonly steps: Step[]) {}

  async *stream(request: ProviderRequest): AsyncIterable<ProviderChunk> {
    this.requests.push(request);
    const step = this.steps[this.requests.length - 1] ?? "text";
    if (step === "fail") throw Object.assign(new Error("upstream"), { status: 503 });
    if (step === "stall") {
      await new Promise<void>((_resolve, reject) => request.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true }));
      return;
    }
    if (step !== "text" && request.toolChoice !== "none") {
      yield { type: "tool_calls", calls: step };
    } else {
      yield { type: "text", text: "Done." };
    }
    yield { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
  }

  /** The tool results the backend sent back in a given request. */
  resultsIn(index: number): ProviderToolResult[] {
    return this.requests[index]!.messages.filter(isToolResultTurn).flatMap((t) => t.results);
  }
}

const label = (id: string, issue = 7, text = "bug"): ModelToolCall => ({ id, name: "mock-github__add_label", argumentsJson: JSON.stringify({ issue, label: text }) });
const list = (id: string): ModelToolCall => ({ id, name: "mock-github__list_issues", argumentsJson: JSON.stringify({ repo: "dash/dash-ai" }) });

const apps: FastifyInstance[] = [];
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
  while (disposers.length) await disposers.pop()!();
});

async function sharedStore(): Promise<Store> {
  if (!USING_POSTGRES) return new MemoryStore();
  const pg = await createTestPgStore();
  disposers.push(() => pg.dispose());
  return pg.store;
}

/** One API instance. Several can share a store (a restart, or a second server). */
async function instance(store: Store, adapter: Script, probe?: { mock: ReturnType<typeof makeMockGithubPlugin> }, env: Record<string, string> = {}) {
  const mock = probe?.mock ?? makeMockGithubPlugin();
  const { app, context } = await buildApp({
    config: testConfig({ PROVIDER_RETRY_BASE_MS: "5", PROVIDER_IDLE_TIMEOUT_MS: "500", ...env }),
    providers: new ProviderRegistry({ [adapter.id]: adapter }),
    plugins: new PluginRegistry().register(builtinPlugin).register(mock.plugin),
    store,
  });
  await app.ready();
  apps.push(app);
  return { app, context, mock };
}

async function signIn(app: FastifyInstance) {
  const user = await register(app);
  await app.inject({ method: "PUT", url: "/v1/plugins/mock-github", headers: user.auth, payload: { enabled: true } });
  return user;
}

const send = async (app: FastifyInstance, auth: Record<string, string>, body = chatBody({ modelChoice: "openai" })) => {
  const res = await app.inject({ method: "POST", url: "/v1/chat/stream", headers: auth, payload: body });
  expect(res.statusCode).toBe(200);
  return { body, events: sse(res.body) };
};
const statuses = (events: StreamEvent[]) =>
  events.filter((e): e is Extract<StreamEvent, { event: "tool.result" }> => e.event === "tool.result").map((e) => e.data.status);
const runs = (probe: MockPluginProbe, name: string) => probe.calls[name] ?? 0;

describe("repeated call ids", () => {
  it("a call id the provider repeats in a later round is not run again", async () => {
    const adapter = new Script("openai", [[label("call_1")], [label("call_1")]]);
    const { app, mock } = await instance(await sharedStore(), adapter);
    const user = await signIn(app);
    const { events } = await send(app, user.auth);
    expect(runs(mock.probe, "add_label")).toBe(1);
    expect(statuses(events)).toEqual(["ok", "duplicate"]);
    expect(adapter.resultsIn(2).at(-1)).toMatchObject({ callId: "call_1", content: DUPLICATE_TEXT.callId, isError: false });
  });

  it("the same call id twice in one round runs once, and read-only tools are covered too", async () => {
    const adapter = new Script("openai", [[list("dup"), list("dup")]]);
    const { app, mock } = await instance(await sharedStore(), adapter);
    const user = await signIn(app);
    const { events } = await send(app, user.auth);
    expect(runs(mock.probe, "list_issues")).toBe(1);
    expect(statuses(events)).toEqual(["ok", "duplicate"]);
  });
});

describe("equivalent calls with different ids", () => {
  it("read-only lookups repeated on purpose still run every time", async () => {
    const adapter = new Script("openai", [[list("a"), list("b")], [list("c")]]);
    const { app, mock } = await instance(await sharedStore(), adapter);
    const user = await signIn(app);
    const { events } = await send(app, user.auth);
    expect(runs(mock.probe, "list_issues")).toBe(3);
    expect(statuses(events)).toEqual(["ok", "ok", "ok"]);
  });

  it("an at-most-once action runs once per user message, whatever the call ids; different arguments are different actions", async () => {
    const adapter = new Script("openai", [[label("a"), label("b"), label("c", 8)], [label("d")]]);
    const { app, mock } = await instance(await sharedStore(), adapter);
    const user = await signIn(app);
    const { events } = await send(app, user.auth);
    expect(runs(mock.probe, "add_label")).toBe(2); // issue 7 once, issue 8 once
    expect(statuses(events)).toEqual(["ok", "duplicate", "ok", "duplicate"]);
    expect(adapter.resultsIn(1)[1]).toMatchObject({ content: DUPLICATE_TEXT.action, isError: false });
  });

  it("argument key order does not make an equivalent action look different", async () => {
    const reordered: ModelToolCall = { id: "b", name: "mock-github__add_label", argumentsJson: '{"label":"bug","issue":7}' };
    const adapter = new Script("openai", [[label("a"), reordered]]);
    const { app, mock } = await instance(await sharedStore(), adapter);
    const user = await signIn(app);
    await send(app, user.auth);
    expect(runs(mock.probe, "add_label")).toBe(1);
  });
});

describe("transport retries, reconnects and restarts", () => {
  it("a provider timeout after the action ran retries the follow-up only; the action ran once", async () => {
    const adapter = new Script("openai", [[label("a")], "stall", "text"]);
    const { app, mock } = await instance(await sharedStore(), adapter);
    const user = await signIn(app);
    const { events } = await send(app, user.auth);
    expect(adapter.requests).toHaveLength(3);
    expect(runs(mock.probe, "add_label")).toBe(1);
    expect(events.some((e) => e.event === "message.error")).toBe(false);
  });

  it("a client that re-sends the same message (reconnect / retried stream) cannot repeat the action; lookups may run again", async () => {
    const adapter = new Script("openai", [[label("a"), list("l1")], "text", [label("x"), list("l2")], "text"]);
    const { app, mock } = await instance(await sharedStore(), adapter);
    const user = await signIn(app);
    const body = chatBody({ modelChoice: "openai" });
    await send(app, user.auth, body);
    const again = await send(app, user.auth, body);
    expect(runs(mock.probe, "add_label")).toBe(1);
    expect(runs(mock.probe, "list_issues")).toBe(2);
    expect(statuses(again.events)).toEqual(["duplicate", "ok"]);
  });

  it("a new user message may perform the same action again (the scope is one user message)", async () => {
    const adapter = new Script("openai", [[label("a")], "text", [label("a")], "text"]);
    const { app, mock } = await instance(await sharedStore(), adapter);
    const user = await signIn(app);
    const conversationId = testId("conv");
    await send(app, user.auth, chatBody({ conversationId, modelChoice: "openai" }));
    await send(app, user.auth, chatBody({ conversationId, modelChoice: "openai", message: { id: testId("msg"), content: "Do it again", attachmentIds: [] } }));
    expect(runs(mock.probe, "add_label")).toBe(2);
  });

  it("a server restart between the action and the provider's continuation does not repeat it", async () => {
    const store = await sharedStore();
    const mock = makeMockGithubPlugin();
    // First server: the action runs, then the provider fails for good, as if the server died before finishing.
    const first = new Script("openai", [[label("a")], "fail", "fail", "fail"]);
    const one = await instance(store, first, { mock });
    const user = await signIn(one.app);
    const body = chatBody({ modelChoice: "openai" });
    const failed = await send(one.app, user.auth, body);
    expect(failed.events.some((e) => e.event === "message.error")).toBe(true);
    await one.app.close();
    apps.splice(apps.indexOf(one.app), 1);
    // A new server process on the same database; the app re-sends the message.
    const second = new Script("openai", [[label("b")], "text"]);
    const two = await instance(store, second, { mock });
    const retried = await send(two.app, user.auth, body);
    expect(runs(mock.probe, "add_label")).toBe(1);
    expect(statuses(retried.events)).toEqual(["duplicate"]);
  });

  it("an action whose outcome is unknown (claimed, never finished) is not run again", async () => {
    const store = await sharedStore();
    const adapter = new Script("openai", [[label("a")]]);
    const { app, mock } = await instance(store, adapter);
    const user = await signIn(app);
    const body = chatBody({ modelChoice: "openai" });
    // Simulate a crash while the handler was running on another server: the claim exists, nothing more.
    const key = executionKey({ userId: user.user.id, conversationId: body.conversationId as string, turnId: (body.message as { id: string }).id }, "mock-github__add_label", { issue: 7, label: "bug" });
    expect(await store.claimToolExecution({ keyHash: key, userId: user.user.id, createdAt: new Date().toISOString() })).toBe(true);
    const { events } = await send(app, user.auth, body);
    expect(runs(mock.probe, "add_label")).toBe(0);
    expect(statuses(events)).toEqual(["duplicate"]);
  });

  it("two servers racing on the same action: exactly one runs it", async () => {
    const store = await sharedStore();
    const mock = makeMockGithubPlugin();
    const a = await instance(store, new Script("openai", [[label("a")], "text"]), { mock });
    const b = await instance(store, new Script("openai", [[label("b")], "text"]), { mock });
    const user = await signIn(a.app);
    const body = chatBody({ modelChoice: "openai" });
    const [x, y] = await Promise.all([send(a.app, user.auth, body), send(b.app, user.auth, body)]);
    expect(runs(mock.probe, "add_label")).toBe(1);
    expect([...statuses(x.events), ...statuses(y.events)].sort()).toEqual(["duplicate", "ok"]);
  });

  it("different users performing the same action each get it once", async () => {
    const adapter = new Script("openai", [[label("a")], "text", [label("a")], "text"]);
    const { app, mock } = await instance(await sharedStore(), adapter);
    const alice = await signIn(app);
    const bob = await signIn(app);
    const body = chatBody({ modelChoice: "openai" });
    await send(app, alice.auth, body);
    await send(app, bob.auth, { ...body, conversationId: testId("conv") });
    expect(runs(mock.probe, "add_label")).toBe(2);
  });

  it("if the ledger cannot be written, the action is not run (fail closed)", async () => {
    const store = await sharedStore();
    const adapter = new Script("openai", [[label("a")]]);
    const { app, mock } = await instance(store, adapter);
    const user = await signIn(app);
    store.claimToolExecution = async () => {
      throw new Error("database unavailable");
    };
    const { events } = await send(app, user.auth);
    expect(runs(mock.probe, "add_label")).toBe(0);
    expect(statuses(events)).toEqual(["error"]);
  });
});

describe("plugin contract", () => {
  it("a tool that writes must declare per-message idempotency", () => {
    const writer = (idempotency?: "per-message") =>
      new PluginRegistry().register({
        id: "sample", name: "S", description: "d", version: "1", kind: "builtin",
        scopes: [{ id: "sample:write", description: "w", risk: "write" }],
        tools: [defineTool({ name: "send", description: "Sends.", scope: "sample:write", risk: "write", input: z.object({}), ...(idempotency ? { idempotency } : {}), execute: async () => "" })],
      });
    expect(() => writer()).toThrow(PluginRegistrationError);
    expect(() => writer("per-message")).not.toThrow();
  });
});
