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
});
