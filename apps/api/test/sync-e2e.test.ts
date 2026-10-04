import { ConversationDetailResponse, SyncConversationsResponse, SyncPushResponse } from "@dash-ai/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { FAKE_TRIGGERS } from "../src/providers/fake.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import type { PushConversationInput, PushConversationResult } from "../src/store/store.js";
import { chatBody, makeApp, register, sse, testConfig, testId, waitFor } from "./helpers.js";

const apps: FastifyInstance[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});
async function setup() {
  const made = await makeApp();
  apps.push(made.app);
  return made;
}
type Auth = Record<string, string>;

async function send(app: FastifyInstance, auth: Auth, conversationId: string, message: { id: string; content: string }, modelChoice: string) {
  const res = await app.inject({ method: "POST", url: "/v1/chat/stream", headers: auth, payload: chatBody({ conversationId, modelChoice, message: { ...message, attachmentIds: [] } }) });
  expect(res.statusCode).toBe(200);
  return sse(res.body);
}
const pull = async (app: FastifyInstance, auth: Auth, cursor = "0") =>
  SyncConversationsResponse.parse((await app.inject({ method: "GET", url: `/v1/sync/conversations?cursor=${cursor}`, headers: auth })).json());

describe("switching AI provider inside one conversation", () => {
  it("keeps one conversation, in order, with no duplicate or orphaned messages", async () => {
    const { app } = await setup();
    const { auth } = await register(app);
    const conversationId = testId("conv");
    const m1 = { id: testId("msg"), content: "first, to OpenAI" };
    const m2 = { id: testId("msg"), content: "second, to Claude" };
    const m3 = { id: testId("msg"), content: "third, compare both" };
    await send(app, auth, conversationId, m1, "openai");
    await send(app, auth, conversationId, m2, "claude");
    await send(app, auth, conversationId, m3, "compare");
    // "Retry with the other provider" re-sends the same user message id to a different provider.
    await send(app, auth, conversationId, m2, "openai");
    await send(app, auth, conversationId, m3, "smart");

    const detail = ConversationDetailResponse.parse((await app.inject({ method: "GET", url: `/v1/conversations/${conversationId}`, headers: auth })).json());
    const shape = detail.messages.map((m) => (m.role === "user" ? `user:${m.content}` : `assistant:${m.origin}`));
    expect(shape).toEqual([`user:${m1.content}`, "assistant:openai", `user:${m2.content}`, "assistant:openai", `user:${m3.content}`, "assistant:openai"]);
    expect(new Set(detail.messages.map((m) => m.id)).size).toBe(detail.messages.length);

    // Sync shows exactly the same single conversation.
    const page = await pull(app, auth);
    expect(page.changes.map((c) => c.conversation.id)).toEqual([conversationId]);
    expect(page.changes[0]!.messages).toEqual(detail.messages);
    const conversations = (await app.inject({ method: "GET", url: "/v1/conversations", headers: auth })).json() as { conversations: unknown[] };
    expect(conversations.conversations).toHaveLength(1);
  });
});

describe("no lost or duplicated messages under concurrency and failures", () => {
  it("a device that pulls mid-stream gets the finished answer on its next pull", async () => {
    const { app } = await setup();
    const { auth } = await register(app);
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const body = chatBody({ message: { id: testId("msg"), content: `long ${FAKE_TRIGGERS.slow}`, attachmentIds: [] } });
    const streaming = fetch(`${address}/v1/chat/stream`, {
      method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body),
    }).then((r) => r.text());
    // Pull while the answer is still being generated.
    await waitFor(async () => (await pull(app, auth)).changes.length > 0);
    const during = await pull(app, auth);
    expect(during.changes[0]!.messages.map((m) => m.role)).toEqual(["user"]);
    await streaming;
    const after = await pull(app, auth, during.cursor);
    expect(after.changes).toHaveLength(1);
    const messages = after.changes[0]!.messages;
    expect(messages.map((m) => [m.role, m.status])).toEqual([["user", "complete"], ["assistant", "complete"]]);
    expect(messages[1]!.content.length).toBeGreaterThan(50);
  });

  it("a push batch that fails part-way can be retried in full without duplicates", async () => {
    let failNext = true;
    class FlakyStore extends MemoryStore {
      override async pushConversation(userId: string, input: PushConversationInput): Promise<PushConversationResult> {
        const result = await super.pushConversation(userId, input);
        if (failNext && result.status === "created") {
          failNext = false;
          throw new Error("database connection lost after commit"); // applied, but the request fails
        }
        return result;
      }
    }
    const { app } = await buildApp({ config: testConfig(), store: new FlakyStore() });
    await app.ready();
    apps.push(app);
    const { auth } = await register(app);
    const a = testId("conv");
    const b = testId("conv");
    const at = new Date().toISOString();
    const ops = [a, b].map((id) => ({
      opId: testId("op"), type: "upload", conversation: { id, title: "t", titleIsCustom: false, mode: "general", createdAt: at },
      messages: [{ id: testId("msg"), content: `in ${id}`, createdAt: at }],
    }));
    const failed = await app.inject({ method: "POST", url: "/v1/sync/push", headers: auth, payload: { operations: ops } });
    expect(failed.statusCode).toBe(500);
    const retried = await app.inject({ method: "POST", url: "/v1/sync/push", headers: auth, payload: { operations: ops } });
    expect(SyncPushResponse.parse(retried.json()).results.map((r) => [r.status, r.appended])).toEqual([["applied", 0], ["applied", 1]]);
    const page = await pull(app, auth);
    expect(page.changes.map((c) => [c.conversation.id, c.messages.length]).sort()).toEqual([[a, 1], [b, 1]].sort());
  });

  it("concurrent pushes, chats and renames from several devices converge without duplicates", async () => {
    const { app } = await setup();
    const { auth } = await register(app);
    const conversationId = testId("conv");
    await send(app, auth, conversationId, { id: testId("msg"), content: "seed" }, "openai");
    const later = new Date(Date.now() + 60_000).toISOString();
    const offline = { id: testId("msg"), content: "offline note", createdAt: later };
    const upload = () => ({
      opId: testId("op"), type: "upload",
      conversation: { id: conversationId, title: "t", titleIsCustom: false, mode: "general", createdAt: later },
      messages: [offline],
    });
    await Promise.all([
      ...Array.from({ length: 4 }, () => app.inject({ method: "POST", url: "/v1/sync/push", headers: auth, payload: { operations: [upload()] } })),
      app.inject({ method: "POST", url: "/v1/sync/push", headers: auth, payload: { operations: [{ opId: testId("op"), type: "rename", conversationId, title: "Renamed", baseTitleRev: null }] } }),
      pull(app, auth),
    ]);
    const detail = ConversationDetailResponse.parse((await app.inject({ method: "GET", url: `/v1/conversations/${conversationId}`, headers: auth })).json());
    expect(detail.messages.filter((m) => m.id === offline.id)).toHaveLength(1);
    expect(new Set(detail.messages.map((m) => m.id)).size).toBe(detail.messages.length);
    expect(detail.conversation.title).toBe("Renamed");
  });
});

describe("the same message sent twice at once (a reconnecting client)", () => {
  // Regression: on PostgreSQL this deadlocked (40P01) and one request failed with an internal
  // error, because two code paths took the conversation and user row locks in opposite orders.
  it("both requests succeed, nothing fails, and the conversation ends consistent", async () => {
    const { app } = await setup();
    const { auth } = await register(app);
    for (let round = 0; round < 8; round++) {
      const conversationId = testId("conv");
      const message = { id: testId("msg"), content: `round ${round}` };
      const results = await Promise.all([send(app, auth, conversationId, message, "openai"), send(app, auth, conversationId, message, "openai")]);
      for (const events of results) expect(events.filter((e) => e.event === "stream.error" || e.event === "message.error")).toEqual([]);
      const detail = ConversationDetailResponse.parse((await app.inject({ method: "GET", url: `/v1/conversations/${conversationId}`, headers: auth })).json());
      expect(detail.messages.filter((m) => m.role === "user").map((m) => m.id)).toEqual([message.id]);
    }
    // Sync still sees each conversation exactly once.
    const ids = (await pull(app, auth)).changes.map((c) => c.conversation.id);
    expect(ids).toHaveLength(8);
    expect(new Set(ids).size).toBe(8);
  });
});
