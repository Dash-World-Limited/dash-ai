import {
  SyncConversationsResponse,
  type StreamEvent,
} from "@dash-ai/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { chatBody, makeApp, register, sse, testId } from "./helpers.js";

const apps: FastifyInstance[] = [];
async function setup() {
  const made = await makeApp();
  apps.push(made.app);
  return made;
}
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

async function pull(app: FastifyInstance, auth: Record<string, string>, query = "") {
  const res = await app.inject({ method: "GET", url: `/v1/sync/conversations${query}`, headers: auth });
  expect(res.statusCode).toBe(200);
  return SyncConversationsResponse.parse(res.json());
}

async function say(app: FastifyInstance, auth: Record<string, string>, over: Record<string, unknown> = {}) {
  const body = chatBody({ modelChoice: "openai", ...over });
  const res = await app.inject({ method: "POST", url: "/v1/chat/stream", headers: auth, payload: body });
  expect(res.statusCode).toBe(200);
  return { body, events: sse(res.body) as StreamEvent[] };
}

describe("GET /v1/sync/conversations", () => {
  it("is empty for a new account and requires sign-in", async () => {
    const { app } = await setup();
    const { auth } = await register(app);
    expect(await pull(app, auth)).toEqual({ changes: [], cursor: "0", latest: "0", hasMore: false });
    expect((await app.inject({ method: "GET", url: "/v1/sync/conversations" })).statusCode).toBe(401);
  });

  it("delivers a chat as one change holding the whole conversation", async () => {
    const { app } = await setup();
    const { auth } = await register(app);
    const { body } = await say(app, auth);
    const page = await pull(app, auth);
    expect(page.changes).toHaveLength(1);
    const change = page.changes[0]!;
    expect(change.deleted).toBe(false);
    expect(change.conversation).toMatchObject({ id: body.conversationId, mode: "general", titleIsCustom: false });
    expect(change.messages.map((m) => [m.role, m.origin, m.status])).toEqual([["user", null, "complete"], ["assistant", "openai", "complete"]]);
    expect(change.messages[1]!.model).toBe("fake-openai");
    expect(page.cursor).toBe(String(change.seq));
    expect(page.latest).toBe(page.cursor);
    expect(await pull(app, auth, `?cursor=${page.cursor}`)).toMatchObject({ changes: [], cursor: page.cursor, hasMore: false });
  });

  it("pages in change order and every page applies on its own", async () => {
    const { app } = await setup();
    const { auth } = await register(app);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await say(app, auth)).body.conversationId);

    const seen: string[] = [];
    let cursor = "0";
    let pages = 0;
    for (;;) {
      const page = await pull(app, auth, `?cursor=${cursor}&limit=1`);
      pages += 1;
      seen.push(...page.changes.map((c) => c.conversation.id));
      cursor = page.cursor;
      if (!page.hasMore) break;
    }
    expect(pages).toBe(3);
    expect(seen).toEqual(ids);
  });

  it("re-delivers a conversation when it changes: new messages, renames, regenerate", async () => {
    const { app } = await setup();
    const { auth } = await register(app);
    const first = await say(app, auth);
    const cursor1 = (await pull(app, auth)).cursor;

    await say(app, auth, { conversationId: first.body.conversationId, message: { id: testId("msg"), content: "And a follow-up", attachmentIds: [] } });
    const afterFollowUp = await pull(app, auth, `?cursor=${cursor1}`);
    expect(afterFollowUp.changes).toHaveLength(1);
    expect(afterFollowUp.changes[0]!.messages).toHaveLength(4);

    const rename = await app.inject({ method: "PATCH", url: `/v1/conversations/${first.body.conversationId}`, headers: auth, payload: { title: "My own title" } });
    expect(rename.statusCode).toBe(200);
    const afterRename = await pull(app, auth, `?cursor=${afterFollowUp.cursor}`);
    expect(afterRename.changes[0]!.conversation).toMatchObject({ title: "My own title", titleIsCustom: true });

    // Regenerating (re-sending the same message id) replaces the answer: the list shrinks and regrows.
    const lastUser = afterRename.changes[0]!.messages.filter((m) => m.role === "user").at(-1)!;
    await say(app, auth, { conversationId: first.body.conversationId, message: { id: lastUser.id, content: "And a follow-up", attachmentIds: [] } });
    const afterRegen = await pull(app, auth, `?cursor=${afterRename.cursor}`);
    expect(afterRegen.changes).toHaveLength(1);
    expect(afterRegen.changes[0]!.messages).toHaveLength(4);
    expect(afterRegen.changes[0]!.seq).toBeGreaterThan(afterRename.changes[0]!.seq);
  });

  it("delivers deletions as tombstones with no title or messages", async () => {
    const { app } = await setup();
    const { auth } = await register(app);
    const { body } = await say(app, auth);
    const before = await pull(app, auth);
    expect((await app.inject({ method: "DELETE", url: `/v1/conversations/${body.conversationId}`, headers: auth })).statusCode).toBe(204);
    const after = await pull(app, auth, `?cursor=${before.cursor}`);
    expect(after.changes).toHaveLength(1);
    expect(after.changes[0]).toMatchObject({ deleted: true, messages: [], conversation: { id: body.conversationId, title: "" } });
    // From scratch, the conversation appears only as a tombstone: its content is gone.
    const scratch = await pull(app, auth);
    expect(scratch.changes.map((c) => [c.conversation.id, c.deleted])).toEqual([[body.conversationId, true]]);
    expect(JSON.stringify(scratch)).not.toContain("Hello Dash");
  });

  it("never mixes users", async () => {
    const { app } = await setup();
    const alice = await register(app);
    const bob = await register(app);
    await say(app, alice.auth);
    expect((await pull(app, bob.auth)).changes).toEqual([]);
    expect((await pull(app, alice.auth)).changes).toHaveLength(1);
  });

  it("reports the latest change so a client can detect restored server data", async () => {
    const { app } = await setup();
    const { auth } = await register(app);
    await say(app, auth);
    const page = await pull(app, auth, "?cursor=999999");
    expect(page.changes).toEqual([]);
    expect(page.cursor).toBe("999999");
    expect(Number(page.latest)).toBeLessThan(999999); // cursor beyond latest ⇒ client resets to 0
  });

  it("validates the query", async () => {
    const { app } = await setup();
    const { auth } = await register(app);
    for (const q of ["?cursor=abc", "?cursor=-1", "?cursor=1.5", "?limit=0", "?limit=51", "?limit=x"]) {
      expect((await app.inject({ method: "GET", url: `/v1/sync/conversations${q}`, headers: auth })).statusCode, q).toBe(400);
    }
  });
});
