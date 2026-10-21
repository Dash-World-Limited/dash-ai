import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { DataExportResponse } from "@dash-ai/contracts";
import { LogCapture, makeApp, register, testId } from "./helpers.js";

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
    const original = context.store.exportConversations.bind(context.store);
    let releaseReads!: () => void;
    const gate = new Promise<void>((r) => (releaseReads = r));
    context.store.exportConversations = async (...args: Parameters<typeof original>) => {
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
    context.store.exportConversations = original;
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
      await context.store.saveMessage({ id: testId("msg"), conversationId: id, role: "user", content: "x".repeat(20_000), origin: null, model: null, demo: false, status: "complete", compareGroupId: null, attachmentIds: [], createdAt: at(c) });
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
    // About 13 MB were still to be read when the account went: the response is cut short and does not parse.
    expect(body.length).toBeGreaterThan(0);
    expect(() => JSON.parse(body)).toThrow();
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });

  it("pages cross every boundary without losing or repeating anything: many conversations, one long conversation, long tool and usage histories", async () => {
    const logs = new LogCapture();
    const { app, context } = await makeApp({ env: { RATE_LIMIT_SYNC_PER_MINUTE: "1000" }, logs });
    apps.push(app);
    const user = await register(app);
    const other = await register(app);
    const userId = user.user.id;
    const at = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString();
    const msg = (conversationId: string, n: number, content: string) => ({
      id: testId("msg"), conversationId, role: n % 2 ? ("assistant" as const) : ("user" as const), content, origin: null, model: null,
      demo: false, status: "complete" as const, compareGroupId: null, attachmentIds: [], createdAt: at(n),
    });
    // 130 small conversations (three pages of 50), some sharing an updated time; one with no messages.
    for (let c = 0; c < 130; c++) {
      const id = testId("conv");
      await context.store.saveConversation({ id, userId, title: `C${c}`, titleIsCustom: false, mode: "general", createdAt: at(c), updatedAt: at(Math.floor(c / 3)) });
      if (c !== 7) for (let m = 0; m < 2; m++) await context.store.saveMessage(msg(id, c * 2 + m, `private text ${c}.${m}`));
    }
    // One long conversation: 450 messages (three message pages) and 230 tool calls (two pages).
    const long = testId("conv");
    await context.store.saveConversation({ id: long, userId, title: "Long", titleIsCustom: false, mode: "general", createdAt: at(1), updatedAt: at(500) });
    const longIds: string[] = [];
    for (let m = 0; m < 450; m++) {
      const row = msg(long, m, `long message ${m}`);
      longIds.push(row.id);
      await context.store.saveMessage(row);
    }
    for (let t = 0; t < 230; t++) {
      await context.store.recordToolInvocation({
        userId, conversationId: long, messageId: longIds[t]!, callId: `call-${t}`, provider: "openai", plugin: "dash-demo",
        tool: "text_stats", status: "ok", durationMs: 1, argBytes: 1, resultChars: 1, createdAt: at(t),
      });
    }
    // A conversation of exactly one message page (200), so a page ends exactly where it does.
    const exact = testId("conv");
    await context.store.saveConversation({ id: exact, userId, title: "Exact", titleIsCustom: false, mode: "general", createdAt: at(2), updatedAt: at(400) });
    for (let m = 0; m < 200; m++) await context.store.saveMessage(msg(exact, m, `exact ${m}`));
    // 450 usage rows (three usage pages), and some for another account.
    for (let u = 0; u < 450; u++) {
      await context.store.recordUsage({ userId, conversationId: long, messageId: longIds[u]!, provider: "openai", model: "fake-openai", demo: true, inputTokens: u, outputTokens: 1, estimatedCostUsd: null, createdAt: at(u) });
    }
    for (let u = 0; u < 5; u++) {
      await context.store.recordUsage({ userId: other.user.id, conversationId: "conv-other00", messageId: `msg-other${u}00`, provider: "openai", model: "m", demo: true, inputTokens: 999_999, outputTokens: 1, estimatedCostUsd: null, createdAt: at(u) });
    }

    const res = await app.inject({ method: "GET", url: "/v1/me/export", headers: user.auth });
    expect(res.statusCode).toBe(200);
    const exported = DataExportResponse.parse(res.json());

    // Every conversation exactly once, pages of 100 in "most recently updated first" order, and the
    // same content as the unpaged reads.
    const expected = (await context.store.listConversations(userId)).map((c) => c.id);
    const got = exported.conversations.map((c) => c.conversation.id);
    expect(got).toHaveLength(132);
    expect(new Set(got).size).toBe(132);
    expect(new Set(got.slice(0, 100))).toEqual(new Set(expected.slice(0, 100)));
    expect(new Set(got.slice(100))).toEqual(new Set(expected.slice(100)));
    for (const c of exported.conversations) {
      const stored = await context.store.listMessages(c.conversation.id);
      expect(c.messages.map((m) => m.id)).toEqual(stored.map((m) => m.id));
      expect(c.messages.map((m) => m.content)).toEqual(stored.map((m) => m.content));
    }
    const longExport = exported.conversations.find((c) => c.conversation.id === long)!;
    expect(longExport.messages.map((m) => m.content)).toEqual(Array.from({ length: 450 }, (_, m) => `long message ${m}`));
    expect(longExport.toolActivity).toHaveLength(230);
    expect(new Set(longExport.toolActivity.map((t) => t.callId)).size).toBe(230);
    expect(longExport.toolActivity.map((t) => t.callId)).toEqual(Array.from({ length: 230 }, (_, t) => `call-${t}`));
    expect(exported.conversations.find((c) => c.conversation.title === "C7")!.messages).toEqual([]);
    expect(exported.conversations.find((c) => c.conversation.id === exact)!.messages.map((m) => m.content)).toEqual(Array.from({ length: 200 }, (_, m) => `exact ${m}`));
    expect(exported.usage).toHaveLength(450);
    expect(exported.usage.map((u) => u.inputTokens)).toEqual(Array.from({ length: 450 }, (_, u) => u));
    expect(res.body).not.toContain("999999");
    expect(res.body).not.toContain(other.user.id);
    // Message text never reaches the logs.
    expect(logs.text).not.toContain("private text");
    expect(logs.text).not.toContain("long message");
  }, 60_000);
});
