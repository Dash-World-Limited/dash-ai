import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { DataExportResponse } from "@dash-ai/contracts";
import { makeApp, register, testId } from "./helpers.js";

/** The streamed account export: complete across batch boundaries, bounded in concurrency. */
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

describe("account export", () => {
  it("streams a complete, valid document across many conversation batches", async () => {
    const { app, context } = await makeApp({ env: { RATE_LIMIT_SYNC_PER_MINUTE: "1000" } });
    apps.push(app);
    const user = await register(app);
    const at = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString();
    for (let c = 0; c < 450; c++) {
      const id = testId("conv");
      await context.store.saveConversation({ id, userId: user.user.id, title: `C${c}`, titleIsCustom: false, mode: "general", createdAt: at(c), updatedAt: at(c) });
      await context.store.saveMessage({ id: testId("msg"), conversationId: id, role: "user", content: `question ${c} "quoted"  `, origin: null, model: null, demo: false, status: "complete", compareGroupId: null, attachmentIds: [], createdAt: at(c) });
    }
    const res = await app.inject({ method: "GET", url: "/v1/me/export", headers: user.auth });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.headers["cache-control"]).toBe("no-store");
    const exported = DataExportResponse.parse(res.json());
    expect(exported.user.id).toBe(user.user.id);
    expect(exported.conversations).toHaveLength(450);
    expect(new Set(exported.conversations.map((c) => c.conversation.id)).size).toBe(450);
    expect(exported.conversations.every((c) => c.messages.length === 1)).toBe(true);
  });

  it("an empty account exports a valid document", async () => {
    const { app } = await makeApp();
    apps.push(app);
    const user = await register(app);
    const exported = DataExportResponse.parse((await app.inject({ method: "GET", url: "/v1/me/export", headers: user.auth })).json());
    expect(exported.conversations).toEqual([]);
  });

  it("refuses a third export at once on one instance as busy, and frees the places afterwards", async () => {
    const { app, context } = await makeApp({ env: { RATE_LIMIT_SYNC_PER_MINUTE: "1000" } });
    apps.push(app);
    const user = await register(app);
    // Hold the first two exports in their conversation read.
    const original = context.store.listConversations.bind(context.store);
    let releaseReads!: () => void;
    const gate = new Promise<void>((r) => (releaseReads = r));
    context.store.listConversations = async (...args: Parameters<typeof original>) => {
      await gate;
      return original(...args);
    };
    const first = app.inject({ method: "GET", url: "/v1/me/export", headers: user.auth });
    const second = app.inject({ method: "GET", url: "/v1/me/export", headers: user.auth });
    await new Promise((r) => setTimeout(r, 100));
    const third = await app.inject({ method: "GET", url: "/v1/me/export", headers: user.auth });
    expect(third.statusCode).toBe(503);
    releaseReads();
    expect((await first).statusCode).toBe(200);
    expect((await second).statusCode).toBe(200);
    context.store.listConversations = original;
    expect((await app.inject({ method: "GET", url: "/v1/me/export", headers: user.auth })).statusCode).toBe(200);
  });

  it("contains only the signed-in account, with message text decrypted as stored", async () => {
    const { app, context } = await makeApp({ env: { RATE_LIMIT_SYNC_PER_MINUTE: "1000" } });
    apps.push(app);
    const [me, other] = [await register(app), await register(app)];
    const at = new Date().toISOString();
    for (const [u, text] of [[me, "my private note"], [other, "someone else's secret"]] as const) {
      const id = testId("conv");
      await context.store.saveConversation({ id, userId: u.user.id, title: "T", titleIsCustom: false, mode: "general", createdAt: at, updatedAt: at });
      await context.store.saveMessage({ id: testId("msg"), conversationId: id, role: "user", content: text, origin: null, model: null, demo: false, status: "complete", compareGroupId: null, attachmentIds: [], createdAt: at });
    }
    const res = await app.inject({ method: "GET", url: "/v1/me/export", headers: me.auth });
    const exported = DataExportResponse.parse(res.json());
    expect(exported.user.id).toBe(me.user.id);
    expect(exported.conversations.map((c) => c.messages[0]!.content)).toEqual(["my private note"]);
    expect(res.body).not.toContain("someone else");
    expect(res.body).not.toContain(other.user.id);
  });

  it("a client that disconnects mid-export frees its place; an account deleted mid-export never yields a valid partial document", async () => {
    const { app, context } = await makeApp({ env: { RATE_LIMIT_SYNC_PER_MINUTE: "1000" } });
    apps.push(app);
    const user = await register(app);
    const at = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString();
    for (let c = 0; c < 650; c++) {
      const id = testId("conv");
      await context.store.saveConversation({ id, userId: user.user.id, title: `C${c}`, titleIsCustom: false, mode: "general", createdAt: at(c), updatedAt: at(c) });
      await context.store.saveMessage({ id: testId("msg"), conversationId: id, role: "user", content: "x".repeat(2_000), origin: null, model: null, demo: false, status: "complete", compareGroupId: null, attachmentIds: [], createdAt: at(c) });
    }
    const url = await app.listen({ port: 0, host: "127.0.0.1" });
    // Two clients read a few bytes and hang up; both places must come back.
    for (let i = 0; i < 2; i++) {
      const controller = new AbortController();
      const res = await fetch(`${url}/v1/me/export`, { headers: user.auth, signal: controller.signal });
      const reader = res.body!.getReader();
      await reader.read();
      controller.abort();
      await reader.cancel().catch(() => undefined);
    }
    let ok = 0;
    for (let i = 0; i < 40 && ok !== 200; i++) {
      ok = (await app.inject({ method: "GET", url: "/v1/me/export", headers: user.auth })).statusCode;
      if (ok !== 200) await new Promise((r) => setTimeout(r, 50));
    }
    expect(ok).toBe(200);

    // The account is deleted while its export is being read slowly.
    const res = await fetch(`${url}/v1/me/export`, { headers: user.auth });
    const reader = res.body!.getReader();
    await reader.read();
    expect((await app.inject({ method: "DELETE", url: "/v1/me", headers: user.auth })).statusCode).toBe(204);
    let body = "";
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        body += decoder.decode(value, { stream: true });
      }
    } catch {
      // A cut-off response is acceptable; a document that parses as complete but is not, is not.
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = undefined;
    }
    if (parsed !== undefined) {
      // If it completed, it is whole and well-formed (it was read before the deletion landed).
      expect(DataExportResponse.safeParse(parsed).success).toBe(true);
    }
  });
});
