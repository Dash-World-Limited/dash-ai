import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { ConversationDetailResponse, type StreamEvent } from "@dash-ai/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import type { ConversationRecord } from "../src/store/store.js";
import { chatBody, multipart, register, SpyAdapter, sse, testConfig, testId, waitFor } from "./helpers.js";

/** Regressions for the product completion audit (docs/product-completion-audit.md). */

const apps: FastifyInstance[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

async function setup(providers: ProviderRegistry, store = new MemoryStore(), env: Record<string, string> = {}) {
  const { app } = await buildApp({ config: testConfig({ PROVIDER_RETRY_BASE_MS: "0", PROVIDER_MAX_RETRIES: "0", ...env }), providers, store });
  await app.ready();
  apps.push(app);
  const user = await register(app);
  return { app, auth: user.auth };
}

const ofType = <N extends StreamEvent["event"]>(events: StreamEvent[], name: N) =>
  events.filter((e): e is Extract<StreamEvent, { event: N }> => e.event === name);

describe("an answer with no text is never a complete reply", () => {
  const empty = () => new SpyAdapter("openai", [{ type: "finish", finishReason: "stop", usage: { inputTokens: 4, outputTokens: 0 } }]);

  it("ends as a retryable failure in neutral words, and is stored as failed", async () => {
    const { app, auth } = await setup(new ProviderRegistry({ openai: empty() }), new MemoryStore(), { PROVIDER_DETAILS: "hidden" });
    const body = chatBody({ modelChoice: "smart" });
    const res = await app.inject({ method: "POST", url: "/v1/chat/stream", headers: auth, payload: body });
    const events = sse(res.body);
    expect(ofType(events, "message.end")).toEqual([]);
    const [error] = ofType(events, "message.error");
    expect(error!.data.error).toEqual({ code: "provider_error", message: "DASH AI couldn't complete that response. Please try again.", retryable: true });
    const detail = ConversationDetailResponse.parse((await app.inject({ method: "GET", url: `/v1/conversations/${body.conversationId}`, headers: auth })).json());
    expect(detail.messages.find((m) => m.role === "assistant")!.status).toBe("failed");
  });

  it("is handed to the next provider on DASH AI's route, since nothing reached the person", async () => {
    const second = new SpyAdapter("anthropic");
    const { app, auth } = await setup(new ProviderRegistry({ openai: empty(), anthropic: second }), new MemoryStore(), { PROVIDER_DETAILS: "hidden" });
    const res = await app.inject({ method: "POST", url: "/v1/chat/stream", headers: auth, payload: chatBody({ modelChoice: "smart" }) });
    const events = sse(res.body);
    expect(ofType(events, "message.error")).toEqual([]);
    expect(ofType(events, "message.delta").map((e) => e.data.text).join("")).toBe("Hello from spy");
    expect(second.requests).toHaveLength(1);
  });

  it("a refusal with no text keeps its own status", async () => {
    const refusing = new SpyAdapter("openai", [{ type: "finish", finishReason: "refusal", usage: { inputTokens: 4, outputTokens: 0 } }]);
    const { app, auth } = await setup(new ProviderRegistry({ openai: refusing }));
    const res = await app.inject({ method: "POST", url: "/v1/chat/stream", headers: auth, payload: chatBody() });
    expect(ofType(sse(res.body), "message.end")[0]!.data.finishReason).toBe("refusal");
  });
});

describe("a reopened conversation keeps which documents each question was asked with", () => {
  it("lists them on the user message, so Regenerate can send them again", async () => {
    const { app, auth } = await setup(new ProviderRegistry({ openai: new SpyAdapter("openai") }));
    const file = multipart("notes.txt", "text/plain", Buffer.from("Quarterly notes"));
    const upload = await app.inject({ method: "POST", url: "/v1/documents", headers: { ...auth, ...file.headers }, payload: file.payload });
    expect(upload.statusCode).toBe(201);
    const documentId = upload.json().id as string;
    const body = chatBody({ message: { id: testId("msg"), content: "Summarise this", attachmentIds: [documentId] } });
    await app.inject({ method: "POST", url: "/v1/chat/stream", headers: auth, payload: body });
    const detail = ConversationDetailResponse.parse((await app.inject({ method: "GET", url: `/v1/conversations/${body.conversationId}`, headers: auth })).json());
    expect(detail.messages.map((m) => [m.role, m.attachmentIds])).toEqual([["user", [documentId]], ["assistant", []]]);
  });
});

/** A store whose conversation lookups are slow, so a client can leave while the request is prepared. */
class SlowStore extends MemoryStore {
  override async getConversation(userId: string, id: string): Promise<ConversationRecord | undefined> {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return super.getConversation(userId, id);
  }
}

describe("Stop before the answer starts", () => {
  it("a client that leaves while the request is being prepared starts no provider request", async () => {
    const spy = new SpyAdapter("openai");
    const store = new SlowStore();
    const { app, auth } = await setup(new ProviderRegistry({ openai: spy }), store);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const body = chatBody();
    await new Promise<void>((resolve) => {
      const req = httpRequest({ host: "127.0.0.1", port, method: "POST", path: "/v1/chat/stream", headers: { ...auth, "content-type": "application/json" } });
      req.on("error", () => resolve());
      req.end(JSON.stringify(body));
      // Gone before the server finishes preparing (the store takes 300 ms).
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 100);
    });
    // The server records the stopped answer once it notices.
    await waitFor(async () => (await store.listMessages(body.conversationId)).some((m) => m.role === "assistant"), 5_000);
    const answer = (await store.listMessages(body.conversationId)).find((m) => m.role === "assistant")!;
    expect(answer.status).toBe("stopped");
    expect(spy.requests).toHaveLength(0);
  });
});
