import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ConversationDetailResponse, type ChatStreamRequest, type StreamEvent } from "@dash-ai/contracts";
import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import { DemoBackend } from "./backends";
import { buildHistory, ChatEngine } from "./engine";
import type { ChatBackend, ChatMsg } from "./types";

class Scripted implements ChatBackend {
  readonly demo = false;
  requests: ChatStreamRequest[] = [];
  cancelled: string[] = [];
  constructor(private script: (r: ChatStreamRequest, signal: AbortSignal) => AsyncGenerator<StreamEvent>) {}
  async list() { return []; }
  get: ChatBackend["get"] = async () => null;
  stream(r: ChatStreamRequest, s: AbortSignal) { this.requests.push(r); return this.script(r, s); }
  async cancel(id: string) { this.cancelled.push(id); }
  async rename() {}
  async remove() {}
}

const idle = (e: ChatEngine) => new Promise<void>((resolve) => {
  const check = () => (!e.value.generating ? resolve() : setTimeout(check, 1));
  setTimeout(check, 1);
});

function* answer(id: string, text: string): Generator<StreamEvent> {
  yield { event: "stream.start", data: { streamId: "stream0001", conversationId: "c", modelChoice: "smart", compareGroupId: null, targets: [{ messageId: id, demo: false }], routingReason: "r" } };
  yield { event: "message.delta", data: { messageId: id, text } };
  yield { event: "message.end", data: { messageId: id, finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } } };
  yield { event: "stream.end", data: { streamId: "stream0001" } };
}

const fixture = (name: string) => JSON.parse(readFileSync(resolve(process.cwd(), "../../packages/contracts/fixtures", name), "utf8"));

describe("ChatEngine", () => {
  it("reopening a conversation shows the tools its answers used, from the server record only", async () => {
    const detail = ConversationDetailResponse.parse(fixture("conversation-detail.json"));
    const backend = new Scripted(async function* () {});
    backend.get = async () => detail;
    const engine = new ChatEngine(backend);
    await engine.open(detail.conversation.id);
    const [question, reply] = engine.value.messages;
    expect(question!.tools).toEqual([]);
    expect(reply!.tools).toEqual([{ callId: "call_1", plugin: "dash-demo", tool: "text_stats", status: "ok", durationMs: 3 }]);

    // An older server sends no toolActivity: nothing is shown, nothing invented.
    const { toolActivity: _none, ...older } = detail;
    backend.get = async () => older;
    await engine.open(detail.conversation.id);
    expect(engine.value.messages.every((m) => m.tools.length === 0)).toBe(true);
  });

  it("streams a labelled answer, records tool activity and applies the server title", async () => {
    const backend: Scripted = new Scripted(async function* (): AsyncGenerator<StreamEvent> {
      yield { event: "stream.start", data: { streamId: "stream0001", conversationId: "c", modelChoice: "smart", compareGroupId: null, targets: [{ messageId: "answer0001", demo: false }], routingReason: "r" } };
      yield { event: "tool.call", data: { messageId: "answer0001", callId: "call_1", plugin: "dash-demo", tool: "text_stats" } };
      yield { event: "tool.result", data: { messageId: "answer0001", callId: "call_1", plugin: "dash-demo", tool: "text_stats", status: "ok", durationMs: 3 } };
      yield { event: "message.delta", data: { messageId: "answer0001", text: "Hello" } };
      yield { event: "message.end", data: { messageId: "answer0001", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } } };
      yield { event: "conversation.title", data: { conversationId: backend.requests[0]!.conversationId, title: "Greeting" } };
      yield { event: "stream.end", data: { streamId: "stream0001" } };
    });
    const engine = new ChatEngine(backend);
    expect(engine.send("Hi", "general")).toBe(true);
    await idle(engine);
    const a = engine.value.messages[1]!;
    expect([a.content, a.status]).toEqual(["Hello", "complete"]);
    expect(backend.requests[0]!.modelChoice).toBe("smart");
    expect(a.tools).toEqual([{ callId: "call_1", plugin: "dash-demo", tool: "text_stats", status: "ok", durationMs: 3 }]);
    expect(engine.value.conversation?.title).toBe("Greeting");
  });

  it("keeps recovery on a failed answer and retries the same question through DASH AI", async () => {
    let fail = true;
    const backend = new Scripted(async function* (): AsyncGenerator<StreamEvent> {
      if (fail) {
        yield { event: "stream.start", data: { streamId: "stream0001", conversationId: "c", modelChoice: "smart", compareGroupId: null, targets: [{ messageId: "answer0001", demo: false }], routingReason: "r" } };
        yield { event: "message.error", data: { messageId: "answer0001", error: { code: "provider_error", message: "Busy.", retryable: true }, recovery: { attempts: 3, alternatives: [] } } };
        yield { event: "stream.end", data: { streamId: "stream0001" } };
      } else {
        yield* answer("answer0002", "Back");
      }
    });
    const engine = new ChatEngine(backend);
    engine.send("Hi", "general");
    await idle(engine);
    expect(engine.value.messages[1]!.recovery).toEqual({ attempts: 3 });
    expect(backend.requests).toHaveLength(1);
    fail = false;
    expect(engine.regenerate("answer0001")).toBe(true);
    await idle(engine);
    expect(backend.requests[1]!.modelChoice).toBe("smart");
    expect(backend.requests[1]!.message.id).toBe(backend.requests[0]!.message.id);
    expect(engine.value.messages.map((m) => m.content)).toEqual(["Hi", "Back"]);
  });

  it("stop keeps the partial answer, marks running tools stopped and cancels on the server", async () => {
    const backend = new Scripted(async function* (_r, signal) {
      yield { event: "stream.start", data: { streamId: "stream0001", conversationId: "c", modelChoice: "smart", compareGroupId: null, targets: [{ messageId: "answer0001", demo: false }], routingReason: "r" } };
      yield { event: "tool.call", data: { messageId: "answer0001", callId: "call_1", plugin: "p", tool: "t" } };
      yield { event: "message.delta", data: { messageId: "answer0001", text: "Partial" } };
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
    });
    const engine = new ChatEngine(backend);
    engine.send("Long", "general");
    await new Promise((r) => setTimeout(r, 5));
    engine.stop();
    await idle(engine);
    const a = engine.value.messages[1]!;
    expect([a.content, a.status, a.tools[0]!.status]).toEqual(["Partial", "stopped", "cancelled"]);
    expect(backend.cancelled).toEqual(["stream0001"]);
  });

  it("a lost connection ends a streaming answer at once as failed, keeping the text and offering Retry", async () => {
    const backend = new Scripted(async function* (_r, signal): AsyncGenerator<StreamEvent> {
      yield { event: "stream.start", data: { streamId: "stream0001", conversationId: "c", modelChoice: "smart", compareGroupId: null, targets: [{ messageId: "answer0001", demo: false }], routingReason: "r" } };
      yield { event: "message.delta", data: { messageId: "answer0001", text: "Part one" } };
      // A dropped connection: nothing more arrives, and the request would hang until the browser gives up.
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    });
    const engine = new ChatEngine(backend);
    engine.send("Tell me", "general");
    await new Promise((r) => setTimeout(r, 5));
    expect(engine.value.generating).toBe(true);
    engine.connectionLost();
    await idle(engine);
    const answer = engine.value.messages.at(-1)!;
    expect(answer).toMatchObject({ content: "Part one", status: "failed", retryable: true });
    expect(answer.errorMessage).toContain("connection was lost");
    expect(engine.value.error?.code).toBe("network");
    expect(backend.cancelled).toEqual([]); // nothing to tell a server we cannot reach
  });

  it("request failures keep the question and show the error", async () => {
    const backend = new Scripted(async function* () {
      throw new ApiError("network", "Offline.", true);
    });
    const engine = new ChatEngine(backend);
    engine.send("Hi", "general");
    await idle(engine);
    expect(engine.value.error?.message).toBe("Offline.");
    expect(engine.value.messages).toHaveLength(1);
  });

  it("history forwards DASH AI's earlier answers as plain text, never demo, failed or empty ones", () => {
    const m = (role: "user" | "assistant", content: string, extra: Partial<ChatMsg> = {}): ChatMsg => ({
      id: Math.random().toString(36), role, content, status: "complete", demo: false,
      replyToId: null, createdAt: "", attachments: [], errorMessage: null, retryable: false, tools: [], finishReason: null, ...extra,
    });
    const history = buildHistory([m("user", "a"), m("assistant", "b"), m("assistant", "demo", { demo: true }), m("assistant", "", {}), m("assistant", "x", { status: "failed" })]);
    expect(history).toEqual([{ role: "user", content: "a" }, { role: "assistant", content: "b" }]);
  });

  it("Demo Mode answers are labelled simulations and the chat is kept in this browser only", async () => {
    const storage = window.localStorage;
    storage.clear();
    const demo = new DemoBackend(storage, () => "none", 0);
    const engine = new ChatEngine(demo);
    engine.send("Plan my week", "general");
    await idle(engine);
    expect(engine.value.messages[1]!.content).toContain("Demo response · simulated by DASH AI");
    expect(engine.value.messages[1]!.content).not.toMatch(/openai|anthropic|claude|chatgpt|gpt|gemini/i);
    expect(engine.value.messages[1]!.demo).toBe(true);
    expect((await demo.list()).map((c) => c.title)).toEqual(["Plan my week"]);
  });
});

describe("Demo Mode failures", () => {
  it("a simulated failure is DASH AI's own, with retry and no other provider offered", async () => {
    window.localStorage.clear();
    const engine = new ChatEngine(new DemoBackend(window.localStorage, () => "service", 0));
    engine.send("Hi", "general");
    await idle(engine);
    const a = engine.value.messages[1]!;
    expect(a).toMatchObject({ status: "failed", retryable: true, recovery: { attempts: 1 } });
    expect(a.errorMessage).toContain("DASH AI");
    expect(a.errorMessage).not.toMatch(/openai|anthropic|claude|chatgpt|gpt|gemini/i);
  });
});
