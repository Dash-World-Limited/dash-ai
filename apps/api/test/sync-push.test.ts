import {
  ConversationDetailResponse,
  SyncConversationsResponse,
  SyncPushResponse,
  type SyncOperation,
} from "@dash-ai/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { chatBody, makeApp, register, sse, testId } from "./helpers.js";

const apps: FastifyInstance[] = [];
async function setup(env: Record<string, string> = {}) {
  const made = await makeApp({ env });
  apps.push(made.app);
  return made;
}
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

type Auth = Record<string, string>;
const at = (seconds: number) => new Date(Date.UTC(2026, 2, 4, 5, 0, seconds)).toISOString();
const opId = () => testId("op");

async function push(app: FastifyInstance, auth: Auth, operations: SyncOperation[]) {
  const res = await app.inject({ method: "POST", url: "/v1/sync/push", headers: auth, payload: { operations } });
  expect(res.statusCode, res.body).toBe(200);
  return SyncPushResponse.parse(res.json()).results;
}
async function pull(app: FastifyInstance, auth: Auth, cursor = "0") {
  return SyncConversationsResponse.parse((await app.inject({ method: "GET", url: `/v1/sync/conversations?cursor=${cursor}&limit=50`, headers: auth })).json());
}
async function detail(app: FastifyInstance, auth: Auth, id: string) {
  const res = await app.inject({ method: "GET", url: `/v1/conversations/${id}`, headers: auth });
  return res.statusCode === 200 ? ConversationDetailResponse.parse(res.json()) : null;
}
const upload = (id: string, messages: Array<{ id: string; content: string; createdAt: string }>, over: Partial<{ title: string; titleIsCustom: boolean; mode: "general" | "writing"; createdAt: string }> = {}): SyncOperation => ({
  opId: opId(),
  type: "upload",
  conversation: { id, title: "Offline plan", titleIsCustom: false, mode: "general", createdAt: at(0), ...over },
  messages,
});
const msg = (content: string, seconds: number, id = testId("msg")) => ({ id, content, createdAt: at(seconds) });

describe("POST /v1/sync/push — uploads", () => {
  it("creates a conversation written offline, with its user messages, and other devices pull it", async () => {
    const { app } = await setup();
    const { auth } = await register(app);
    const id = testId("conv");
    const [result] = await push(app, auth, [upload(id, [msg("first question", 1), msg("second question", 2)])]);
    expect(result).toMatchObject({ status: "applied", appended: 2, skipped: 0 });

    const page = await pull(app, auth);
    expect(page.changes).toHaveLength(1);
    const change = page.changes[0]!;
    expect(change.conversation).toMatchObject({ id, title: "Offline plan", titleIsCustom: false, titleRev: 0, mode: "general" });
    expect(change.messages.map((m) => [m.role, m.content, m.origin, m.model, m.demo, m.status])).toEqual([
      ["user", "first question", null, null, false, "complete"],
      ["user", "second question", null, null, false, "complete"],
    ]);
    expect(change.conversation.updatedAt).toBe(at(2));
  });

  it("is idempotent: repeating an upload never duplicates the conversation or its messages", async () => {
    const { app } = await setup();
    const { auth } = await register(app);
    const id = testId("conv");
    const op = upload(id, [msg("hello", 1), msg("again", 2)]);
    await push(app, auth, [op]);
    const cursor = (await pull(app, auth)).cursor;
    for (let i = 0; i < 3; i++) {
      const [r] = await push(app, auth, [{ ...op, opId: opId() }]);
      expect(r).toMatchObject({ status: "applied", appended: 0, skipped: 2 });
    }
    // A no-op does not even create a change for other devices.
    expect((await pull(app, auth, cursor)).changes).toEqual([]);
    expect((await detail(app, auth, id))!.messages).toHaveLength(2);
  });

  it("concurrent duplicate uploads create exactly one conversation with no duplicate messages", async () => {
    const { app } = await setup();
    const { auth } = await register(app);
    const id = testId("conv");
    const messages = [msg("a", 1), msg("b", 2), msg("c", 3)];
    const results = await Promise.all(Array.from({ length: 5 }, () => push(app, auth, [upload(id, messages)])));
    expect(results.flat().every((r) => r.status === "applied")).toBe(true);
    expect(results.flat().reduce((n, r) => n + (r.appended ?? 0), 0)).toBe(3);
    expect((await detail(app, auth, id))!.messages.map((m) => m.content)).toEqual(["a", "b", "c"]);
  });

  it("appends only newer user messages to an existing conversation and never rewrites known ones", async () => {
    const { app } = await setup();
    const { auth } = await register(app);
    // The conversation exists on the server through a normal chat (server clock timestamps).
    const body = chatBody({ modelChoice: "openai" });
    await app.inject({ method: "POST", url: "/v1/chat/stream", headers: auth, payload: body });
    const server = (await detail(app, auth, body.conversationId))!;
    const newestServer = Date.parse(server.messages.at(-1)!.createdAt);
    const future = (ms: number) => new Date(newestServer + ms).toISOString();

    const [r] = await push(app, auth, [
      upload(body.conversationId, [
        { id: body.message.id, content: "TAMPERED rewrite of a known message", createdAt: future(1_000) },
        { id: testId("msg"), content: "older than the server's newest", createdAt: new Date(newestServer - 60_000).toISOString() },
        { id: testId("msg"), content: "written offline later", createdAt: future(2_000) },
      ]),
    ]);
    expect(r).toMatchObject({ status: "applied", appended: 1, skipped: 2 });
    const after = (await detail(app, auth, body.conversationId))!;
    expect(after.messages.map((m) => m.content)).toEqual([...server.messages.map((m) => m.content), "written offline later"]);
    expect(after.messages[0]!.content).toBe("Hello Dash");
  });

  it("never resurrects messages removed by an edit on another device", async () => {
    const { app } = await setup();
    const { auth } = await register(app);
    const conversationId = testId("conv");
    const first = { id: testId("msg"), content: "original question", attachmentIds: [] };
    await app.inject({ method: "POST", url: "/v1/chat/stream", headers: auth, payload: chatBody({ conversationId, message: first }) });
    const second = { id: testId("msg"), content: "follow-up", attachmentIds: [] };
    await app.inject({ method: "POST", url: "/v1/chat/stream", headers: auth, payload: chatBody({ conversationId, message: second }) });
    const offlineCopy = (await detail(app, auth, conversationId))!.messages.filter((m) => m.role === "user");

    // Device B edits the first question: the server drops it and everything after it.
    await app.inject({ method: "POST", url: "/v1/chat/stream", headers: auth, payload: chatBody({ conversationId, message: { ...first, content: "edited question" } }) });

    // Device A, offline all along, uploads its stale copy of the conversation.
    const [r] = await push(app, auth, [upload(conversationId, offlineCopy.map((m) => ({ id: m.id, content: m.content, createdAt: m.createdAt })))]);
    expect(r).toMatchObject({ status: "applied", appended: 0 });
    const contents = (await detail(app, auth, conversationId))!.messages.map((m) => m.content);
    expect(contents).not.toContain("follow-up");
    expect(contents).not.toContain("original question");
    expect(contents[0]).toBe("edited question");
  });

  it("devices cannot forge assistant answers, provider labels, demo flags or attachments", async () => {
    const { app } = await setup();
    const { auth } = await register(app);
    const id = testId("conv");
    const forged = {
      opId: opId(), type: "upload", conversation: { id, title: "t", titleIsCustom: false, mode: "general", createdAt: at(0) },
      messages: [{ id: testId("msg"), content: "I am OpenAI", createdAt: at(1), role: "assistant", origin: "openai", model: "gpt-x", demo: true, status: "failed", attachmentIds: ["doc-12345678"] }],
    };
    const res = await app.inject({ method: "POST", url: "/v1/sync/push", headers: auth, payload: { operations: [forged] } });
    expect(res.statusCode).toBe(200);
    const stored = (await detail(app, auth, id))!.messages[0]!;
    expect(stored).toMatchObject({ role: "user", origin: null, model: null, demo: false, status: "complete" });
  });

  it("clamps timestamps from the future", async () => {
    const { app } = await setup();
    const { auth } = await register(app);
    const id = testId("conv");
    await push(app, auth, [upload(id, [msg("from a clock in 2099", 0)], { createdAt: "2099-01-01T00:00:00.000Z" })].map((o) => ({ ...o, messages: [{ ...(o as { messages: Array<{ id: string; content: string }> }).messages[0]!, createdAt: "2099-01-01T00:00:00.000Z" }] }) as SyncOperation));
    const d = (await detail(app, auth, id))!;
    expect(Date.parse(d.messages[0]!.createdAt)).toBeLessThan(Date.now() + 6 * 60_000);
    expect(Date.parse(d.conversation.createdAt)).toBeLessThan(Date.now() + 6 * 60_000);
  });

  it("refuses to resurrect a conversation deleted on the server", async () => {
    const { app } = await setup();
    const { auth } = await register(app);
    const id = testId("conv");
    await push(app, auth, [upload(id, [msg("secret", 1)])]);
    expect((await app.inject({ method: "DELETE", url: `/v1/conversations/${id}`, headers: auth })).statusCode).toBe(204);
    const cursor = (await pull(app, auth)).cursor;

    const [r] = await push(app, auth, [upload(id, [msg("secret", 1), msg("more", 2)])]);
    expect(r).toMatchObject({ status: "deleted", appended: 0, skipped: 2 });
    expect(await detail(app, auth, id)).toBeNull();
    expect((await pull(app, auth, cursor)).changes).toEqual([]);
    expect(JSON.stringify(await pull(app, auth))).not.toContain("secret");
  });

  it("rejects another user's conversation id without changing or revealing it", async () => {
    const { app } = await setup();
    const alice = await register(app);
    const bob = await register(app);
    const id = testId("conv");
    await push(app, alice.auth, [upload(id, [msg("alice's words", 1)])]);
    const aliceCursor = (await pull(app, alice.auth)).cursor;

    const [up, rename, del] = await push(app, bob.auth, [
      upload(id, [msg("bob injects", 5)]),
      { opId: opId(), type: "rename", conversationId: id, title: "pwned", baseTitleRev: 0 },
      { opId: opId(), type: "delete", conversationId: id },
    ]);
    expect(up).toMatchObject({ status: "rejected", appended: 0 });
    expect(rename!.status).toBe("not_found");
    expect(del!.status).toBe("not_found");
    const d = (await detail(app, alice.auth, id))!;
    expect(d.conversation.title).toBe("Offline plan");
    expect(d.messages.map((m) => m.content)).toEqual(["alice's words"]);
    expect((await pull(app, alice.auth, aliceCursor)).changes).toEqual([]);
    expect((await pull(app, bob.auth)).changes).toEqual([]);
  });
});

describe("POST /v1/sync/push — renames", () => {
  async function seeded() {
    const made = await setup();
    const user = await register(made.app);
    const id = testId("conv");
    await push(made.app, user.auth, [upload(id, [msg("q", 1)])]);
    return { ...made, ...user, id };
  }
  const rev = async (app: FastifyInstance, auth: Auth, id: string) => (await pull(app, auth)).changes.find((c) => c.conversation.id === id)!.conversation;

  it("applies a rename made against the current title revision and bumps the revision", async () => {
    const { app, auth, id } = await seeded();
    const [r] = await push(app, auth, [{ opId: opId(), type: "rename", conversationId: id, title: "Launch plan", baseTitleRev: 0 }]);
    expect(r!.status).toBe("applied");
    expect(await rev(app, auth, id)).toMatchObject({ title: "Launch plan", titleIsCustom: true, titleRev: 1 });
  });

  it("a user rename always beats a generated title, even without a base revision", async () => {
    const { app, auth, id } = await seeded();
    const [r] = await push(app, auth, [{ opId: opId(), type: "rename", conversationId: id, title: "Mine", baseTitleRev: null }]);
    expect(r!.status).toBe("applied");
  });

  it("a stale rename loses to a newer one from another device (first writer to the server wins)", async () => {
    const { app, auth, id } = await seeded();
    // Both devices saw titleRev 0. Device B renames first.
    await push(app, auth, [{ opId: opId(), type: "rename", conversationId: id, title: "Device B title", baseTitleRev: 0 }]);
    const [stale] = await push(app, auth, [{ opId: opId(), type: "rename", conversationId: id, title: "Device A title", baseTitleRev: 0 }]);
    expect(stale!.status).toBe("conflict");
    expect(await rev(app, auth, id)).toMatchObject({ title: "Device B title", titleRev: 1 });
    // Once device A pulls revision 1 it can rename again.
    const [fresh] = await push(app, auth, [{ opId: opId(), type: "rename", conversationId: id, title: "Device A title", baseTitleRev: 1 }]);
    expect(fresh!.status).toBe("applied");
  });

  it("retrying a rename that already applied is a no-op success, even with an old base", async () => {
    const { app, auth, id } = await seeded();
    const op: SyncOperation = { opId: opId(), type: "rename", conversationId: id, title: "Same", baseTitleRev: 0 };
    await push(app, auth, [op]);
    const cursor = (await pull(app, auth)).cursor;
    const [again] = await push(app, auth, [{ ...op, opId: opId() }]);
    expect(again!.status).toBe("applied");
    expect((await rev(app, auth, id)).titleRev).toBe(1);
    expect((await pull(app, auth, cursor)).changes).toEqual([]);
  });

  it("the regular rename endpoint also bumps the title revision, so it participates in conflicts", async () => {
    const { app, auth, id } = await seeded();
    await app.inject({ method: "PATCH", url: `/v1/conversations/${id}`, headers: auth, payload: { title: "From the web" } });
    const [stale] = await push(app, auth, [{ opId: opId(), type: "rename", conversationId: id, title: "From the phone", baseTitleRev: 0 }]);
    expect(stale!.status).toBe("conflict");
  });

  it("renaming a deleted or unknown conversation reports it and changes nothing", async () => {
    const { app, auth, id } = await seeded();
    await push(app, auth, [{ opId: opId(), type: "delete", conversationId: id }]);
    const [deleted, unknown] = await push(app, auth, [
      { opId: opId(), type: "rename", conversationId: id, title: "x", baseTitleRev: 0 },
      { opId: opId(), type: "rename", conversationId: testId("conv"), title: "x", baseTitleRev: null },
    ]);
    expect(deleted!.status).toBe("deleted");
    expect(unknown!.status).toBe("not_found");
  });
});

describe("POST /v1/sync/push — deletes, ordering, replay and validation", () => {
  it("deletes are idempotent and leave a tombstone for other devices", async () => {
    const { app } = await setup();
    const { auth } = await register(app);
    const id = testId("conv");
    await push(app, auth, [upload(id, [msg("x", 1)])]);
    const cursor = (await pull(app, auth)).cursor;
    const results = await push(app, auth, [
      { opId: opId(), type: "delete", conversationId: id },
      { opId: opId(), type: "delete", conversationId: id },
    ]);
    expect(results.map((r) => r.status)).toEqual(["applied", "applied"]);
    const changes = (await pull(app, auth, cursor)).changes;
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ deleted: true, messages: [] });
    expect((await push(app, auth, [{ opId: opId(), type: "delete", conversationId: testId("conv") }]))[0]!.status).toBe("not_found");
  });

  it("operations in one request apply in order (upload, rename, then delete wins)", async () => {
    const { app } = await setup();
    const { auth } = await register(app);
    const id = testId("conv");
    const results = await push(app, auth, [
      upload(id, [msg("x", 1)]),
      { opId: opId(), type: "rename", conversationId: id, title: "Renamed", baseTitleRev: 0 },
      { opId: opId(), type: "delete", conversationId: id },
      upload(id, [msg("x", 1), msg("y", 2)]),
    ]);
    expect(results.map((r) => r.status)).toEqual(["applied", "applied", "applied", "deleted"]);
    expect(await detail(app, auth, id)).toBeNull();
  });

  it("replaying a whole request gives the same outcome and changes nothing", async () => {
    const { app } = await setup();
    const { auth } = await register(app);
    const id = testId("conv");
    const ops: SyncOperation[] = [
      upload(id, [msg("x", 1)]),
      { opId: opId(), type: "rename", conversationId: id, title: "Renamed", baseTitleRev: 0 },
    ];
    const first = await push(app, auth, ops);
    const state = await pull(app, auth);
    const replay = await push(app, auth, ops);
    expect(replay.map((r) => r.status)).toEqual(first.map((r) => r.status));
    expect((await pull(app, auth, state.cursor)).changes).toEqual([]);
  });

  it("two devices interleaving produce one deterministic history, in server order", async () => {
    const { app } = await setup();
    const { auth } = await register(app);
    const shared = testId("conv");
    // Device A uploads an offline conversation; device B pulls it and adds an offline message later.
    await push(app, auth, [upload(shared, [msg("A: one", 1)])]);
    const b = await pull(app, auth);
    expect(b.changes[0]!.conversation.titleRev).toBe(0);
    await push(app, auth, [upload(shared, [msg("A: one", 1), msg("B: two", 3)])]);
    // Device A, still offline, had written a message at t=2: it is older than the server's newest, so it is skipped.
    const [late] = await push(app, auth, [upload(shared, [msg("A: one", 1), msg("A: late", 2)])]);
    expect(late).toMatchObject({ appended: 0, skipped: 2 });
    const final = await pull(app, auth);
    expect(final.changes[0]!.messages.map((m) => m.content)).toEqual(["A: one", "B: two"]);
    expect(Number(final.cursor)).toBeGreaterThan(Number(b.cursor));
  });

  it("validates requests and requires authentication", async () => {
    const { app } = await setup();
    const { auth } = await register(app);
    const send = (payload: unknown, headers: Auth = auth) => app.inject({ method: "POST", url: "/v1/sync/push", headers, payload: payload as object });
    expect((await send({ operations: [] })).statusCode).toBe(400);
    const dupe = { opId: "op-duplicate", type: "delete", conversationId: "conv-12345678" };
    expect((await send({ operations: [dupe, dupe] })).statusCode).toBe(400);
    expect((await send({ operations: Array.from({ length: 21 }, (_, i) => ({ opId: `op-${String(i).padStart(8, "0")}`, type: "delete", conversationId: "conv-12345678" })) })).statusCode).toBe(400);
    expect((await send({ operations: [{ opId: "op-12345678", type: "teleport", conversationId: "conv-12345678" }] })).statusCode).toBe(400);
    const res = await send({ operations: [dupe] }, {});
    expect(res.statusCode).toBe(401);
  });

  it("is rate limited per user", async () => {
    const { app } = await setup({ RATE_LIMIT_SYNC_PER_MINUTE: "2" });
    const { auth } = await register(app);
    const op = () => ({ operations: [{ opId: opId(), type: "delete", conversationId: "conv-12345678" }] });
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await app.inject({ method: "POST", url: "/v1/sync/push", headers: auth, payload: op() })).statusCode);
    expect(codes).toEqual([200, 200, 429]);
  });

  it("an uploaded conversation can continue as a normal chat", async () => {
    const { app } = await setup();
    const { auth } = await register(app);
    const id = testId("conv");
    await push(app, auth, [upload(id, [msg("offline question", 1)])]);
    const res = await app.inject({ method: "POST", url: "/v1/chat/stream", headers: auth, payload: chatBody({ conversationId: id }) });
    expect(sse(res.body).some((e) => e.event === "stream.end")).toBe(true);
    expect((await detail(app, auth, id))!.messages.map((m) => m.role)).toEqual(["user", "user", "assistant"]);
  });
});
