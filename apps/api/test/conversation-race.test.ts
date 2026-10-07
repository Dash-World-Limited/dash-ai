import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationRecord } from "../src/store/store.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import { chatBody, makeApp, register, sse } from "./helpers.js";

/**
 * A store where the first lookup of a conversation misses, as when another server is creating the
 * same new conversation for the same user at that moment (the row appears right after).
 */
class RacingStore extends MemoryStore {
  private missed = new Set<string>();
  override async getConversation(userId: string, id: string): Promise<ConversationRecord | undefined> {
    if (!this.missed.has(id) && (await super.conversationExists(id))) {
      this.missed.add(id);
      return undefined;
    }
    return super.getConversation(userId, id);
  }
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

describe("concurrent first requests for one new conversation", () => {
  it("the same user's request continues the conversation instead of failing with 404", async () => {
    const { app } = await makeApp({ store: new RacingStore() });
    apps.push(app);
    const { auth } = await register(app);
    const body = chatBody({ modelChoice: "openai" });
    const first = await app.inject({ method: "POST", url: "/v1/chat/stream", headers: auth, payload: body });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: "POST", url: "/v1/chat/stream", headers: auth, payload: { ...body, message: { ...(body.message as object), id: "msg-second-0001" } } });
    expect(second.statusCode).toBe(200);
    expect(sse(second.body).some((e) => e.event === "stream.end")).toBe(true);
  });

  it("another user's conversation id is still refused and reveals nothing", async () => {
    const { app } = await makeApp({ store: new RacingStore() });
    apps.push(app);
    const alice = await register(app);
    const bob = await register(app);
    const body = chatBody({ modelChoice: "openai" });
    expect((await app.inject({ method: "POST", url: "/v1/chat/stream", headers: alice.auth, payload: body })).statusCode).toBe(200);
    const stolen = await app.inject({ method: "POST", url: "/v1/chat/stream", headers: bob.auth, payload: body });
    expect(stolen.statusCode).toBe(404);
  });
});
