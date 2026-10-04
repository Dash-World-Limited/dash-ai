import { randomBytes } from "node:crypto";
import { ConversationDetailResponse, ToolActivityResponse, type StreamEvent } from "@dash-ai/contracts";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { scrubErrorMessage } from "../src/logging.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import type { ProviderAdapter, ProviderRequest } from "../src/providers/types.js";
import { DataCipher, DataKeyError } from "../src/security/dataCrypto.js";
import { startupErrorText } from "../src/startupError.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import { PostgresStore } from "../src/store/postgresStore.js";
import type { MessageRecord } from "../src/store/store.js";
import { LogCapture, chatBody, makeApp, register, sse, testConfig, testId } from "./helpers.js";
import { TEST_DATABASE_URL } from "./pgTestStore.js";

const apps: FastifyInstance[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});
async function setup(options: Parameters<typeof makeApp>[0] = {}) {
  const made = await makeApp(options);
  apps.push(made.app);
  return made;
}
const byEvent = <N extends StreamEvent["event"]>(events: StreamEvent[], name: N) =>
  events.filter((e): e is Extract<StreamEvent, { event: N }> => e.event === name);

describe("logs never carry user content or connection secrets", () => {
  it("scrubs quoted values and key/value details from error messages", () => {
    expect(scrubErrorMessage('invalid input syntax for type timestamp with time zone: "my secret plan"')).toBe(
      'invalid input syntax for type timestamp with time zone: "[…]"',
    );
    expect(scrubErrorMessage(`Unexpected token 'h', "hello world" is not valid JSON`)).not.toMatch(/hello world|'h'/);
    expect(scrubErrorMessage("Key (email)=(ada@example.com) already exists.")).toBe("Key ([…])=([…]) already exists.");
    expect(scrubErrorMessage("password: hunter2-long")).not.toContain("hunter2");
  });

  it("start-up errors never print the database URL or its password", () => {
    // Built at runtime so no credential-shaped literal is committed (the secret scanner would flag it).
    const pw = ["Sup3r", "S3cret"].join("");
    const otherPw = ["An0ther", "Secret"].join("");
    const url = `postgres://dash:${pw}@db.internal:5432/dash`;
    expect(startupErrorText(new Error(`could not connect to ${url}`), url)).toBe("could not connect to [DATABASE_URL]");
    const other = startupErrorText(new Error(`bad url postgres://admin:${otherPw}@x/y`), url);
    expect(other).not.toContain("An0therSecret");
    expect(other).toContain("postgres://[credentials]@x/y");
  });

  it("a server error whose message quotes user content is logged without that content", async () => {
    // Real PostgreSQL errors quote offending values like this; the store below imitates one.
    class EchoingStore extends MemoryStore {
      override async saveMessage(message: MessageRecord): Promise<void> {
        if (message.role === "user") throw new Error(`invalid input syntax for type json: "${message.content}"`);
        return super.saveMessage(message);
      }
    }
    const logs = new LogCapture();
    const { app } = await buildApp({ config: testConfig({ LOG_LEVEL: "debug" }), store: new EchoingStore(), logStream: logs });
    await app.ready();
    apps.push(app);
    const { auth } = await register(app);
    const res = await app.inject({ method: "POST", url: "/v1/chat/stream", headers: auth, payload: chatBody({ message: { id: testId("msg"), content: "PRIVATE-CANARY-1d9e", attachmentIds: [] } }) });
    expect(byEvent(sse(res.body), "stream.error")).toHaveLength(1);
    expect(logs.text).toContain("chat stream failed");
    expect(logs.text).not.toContain("PRIVATE-CANARY");
  });

  it("sync pushes and pulls log only metadata", async () => {
    const logs = new LogCapture();
    const { app } = await setup({ logs });
    const { auth } = await register(app);
    const id = testId("conv");
    await app.inject({
      method: "POST", url: "/v1/sync/push", headers: auth,
      payload: { operations: [
        { opId: testId("op"), type: "upload", conversation: { id, title: "TITLE-CANARY-55", titleIsCustom: true, mode: "general", createdAt: new Date().toISOString() }, messages: [{ id: testId("msg"), content: "SYNC-CANARY-77", createdAt: new Date().toISOString() }] },
        { opId: testId("op"), type: "rename", conversationId: id, title: "RENAME-CANARY-99", baseTitleRev: 0 },
      ] },
    });
    await app.inject({ method: "GET", url: "/v1/sync/conversations", headers: auth });
    expect(logs.text).toContain("sync push");
    for (const canary of ["TITLE-CANARY", "SYNC-CANARY", "RENAME-CANARY"]) expect(logs.text).not.toContain(canary);
  });
});

describe("cross-user access and sessions", () => {
  it("a chat aimed at another user's conversation id is refused and changes nothing", async () => {
    const { app } = await setup();
    const alice = await register(app);
    const bob = await register(app);
    const body = chatBody({ modelChoice: "openai" });
    await app.inject({ method: "POST", url: "/v1/chat/stream", headers: alice.auth, payload: body });
    const before = ConversationDetailResponse.parse((await app.inject({ method: "GET", url: `/v1/conversations/${body.conversationId}`, headers: alice.auth })).json());

    // Bob re-sends Alice's message id into Alice's conversation: this would truncate her history if allowed.
    const res = await app.inject({ method: "POST", url: "/v1/chat/stream", headers: bob.auth, payload: { ...body, message: { ...body.message, content: "overwrite" } } });
    expect(res.statusCode).toBe(404);
    const after = ConversationDetailResponse.parse((await app.inject({ method: "GET", url: `/v1/conversations/${body.conversationId}`, headers: alice.auth })).json());
    expect(after).toEqual(before);
  });

  it("deleting an account revokes every session, on every device", async () => {
    const { app } = await setup();
    const phone = await register(app, `revoke-${Date.now()}@example.com`);
    const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: phone.user.email, password: "correct horse battery" } });
    const laptop = { authorization: `Bearer ${(login.json() as { token: string }).token}` };
    expect((await app.inject({ method: "GET", url: "/v1/me", headers: laptop })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: "/v1/me", headers: phone.auth })).statusCode).toBe(204);
    for (const auth of [phone.auth, laptop]) {
      expect((await app.inject({ method: "GET", url: "/v1/me", headers: auth })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: "/v1/sync/conversations", headers: auth })).statusCode).toBe(401);
    }
  });

  it("signing out revokes only that session", async () => {
    const { app } = await setup();
    const phone = await register(app, `signout-${Date.now()}@example.com`);
    const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: phone.user.email, password: "correct horse battery" } });
    const laptop = { authorization: `Bearer ${(login.json() as { token: string }).token}` };
    expect((await app.inject({ method: "POST", url: "/v1/auth/logout", headers: phone.auth })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/v1/me", headers: phone.auth })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/v1/me", headers: laptop })).statusCode).toBe(200);
  });
});

describe("message content edge cases", () => {
  it("a display name with a NUL byte is a 400, not a server error (it was a 500 on PostgreSQL)", async () => {
    const { app } = await setup();
    const res = await app.inject({ method: "POST", url: "/v1/auth/register", payload: { email: `nul-${Date.now()}@example.com`, password: "correct horse battery", displayName: "Ada\u0000Lovelace" } });
    expect(res.statusCode).toBe(400);
  });

  it("stores and returns prompts containing NUL bytes and control characters exactly", async () => {
    const { app } = await setup();
    const { auth } = await register(app);
    const content = "before\u0000after\u0001\u001b[31m red";
    const body = chatBody({ message: { id: testId("msg"), content, attachmentIds: [] } });
    const res = await app.inject({ method: "POST", url: "/v1/chat/stream", headers: auth, payload: body });
    expect(byEvent(sse(res.body), "stream.end")).toHaveLength(1);
    const d = ConversationDetailResponse.parse((await app.inject({ method: "GET", url: `/v1/conversations/${body.conversationId}`, headers: auth })).json());
    expect(d.messages[0]!.content).toBe(content);
  });
});

describe("tool-call ids from providers are untrusted", () => {
  it("only bounded, plain call ids reach clients and the audit log; the provider gets its own id back", async () => {
    const hostileId = `<script>alert(1)</script>${"x".repeat(5_000)}`;
    const seen: ProviderRequest[] = [];
    const adapter: ProviderAdapter = {
      id: "openai", displayName: "OpenAI", model: "m", demo: false,
      async *stream(request) {
        seen.push(request);
        if (request.messages.at(-1)?.role === "tool") {
          yield { type: "text", text: "done" };
        } else {
          yield { type: "tool_calls", calls: [{ id: hostileId, name: "dash-demo__text_stats", argumentsJson: '{"text":"a"}' }] };
        }
        yield { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const { app } = await setup({ providers: new ProviderRegistry({ openai: adapter }) });
    const { auth } = await register(app);
    await app.inject({ method: "PUT", url: "/v1/plugins/dash-demo", headers: auth, payload: { enabled: true } });
    const res = await app.inject({ method: "POST", url: "/v1/chat/stream", headers: auth, payload: chatBody({ modelChoice: "openai" }) });
    expect(res.body).not.toContain("<script>");
    const events = sse(res.body);
    expect(byEvent(events, "tool.call")[0]!.data.callId).toBe("call_1");
    expect(byEvent(events, "tool.result")[0]!.data).toMatchObject({ callId: "call_1", status: "ok" });
    const activity = ToolActivityResponse.parse((await app.inject({ method: "GET", url: "/v1/tools/activity", headers: auth })).json());
    expect(activity.activity[0]!.callId).toBe("call_1");
    const replay = seen[1]!.messages.at(-1)!;
    expect(replay.role === "tool" && replay.results[0]!.callId).toBe(hostileId);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("encryption key safety (PostgreSQL)", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterAll(async () => {
    for (const c of cleanups) await c();
  });

  it("refuses to start with a different key configured under an existing key id", async () => {
    const schema = `t_${randomBytes(6).toString("hex")}`;
    const original = randomBytes(32);
    const s1 = await PostgresStore.connect({ connectionString: TEST_DATABASE_URL!, schema, cipher: new DataCipher("k1", new Map([["k1", original]])) });
    cleanups.push(async () => {
      const admin = await PostgresStore.connect({ connectionString: TEST_DATABASE_URL!, schema, autoMigrate: false, cipher: new DataCipher("k1", new Map([["k1", original]])) });
      await admin.dropSchema(schema);
      await admin.close();
    });
    const now = new Date().toISOString();
    await s1.createUser({ id: "user-keys-0001", email: "keys@example.com", displayName: "K", passwordHash: "h", createdAt: now });
    await s1.saveConversation({ id: "conv-keys-0001", userId: "user-keys-0001", title: "t", titleIsCustom: false, mode: "general", createdAt: now, updatedAt: now });
    await s1.close();

    const wrong = randomBytes(32);
    const attempt = PostgresStore.connect({ connectionString: TEST_DATABASE_URL!, schema, cipher: new DataCipher("k1", new Map([["k1", wrong]])) });
    await expect(attempt).rejects.toThrow(DataKeyError);
    await expect(attempt).rejects.toThrow(/does not match the conversation titles already encrypted under key id "k1"/);
    const message = await attempt.catch((e: Error) => e.message);
    expect(message).not.toContain(wrong.toString("base64"));
    expect(message).not.toContain(original.toString("base64"));

    // The right key, or the new key under a new id with the old one retained, starts fine.
    const rotated = await PostgresStore.connect({
      connectionString: TEST_DATABASE_URL!, schema, autoMigrate: false,
      cipher: new DataCipher("k2", new Map([["k2", wrong], ["k1", original]])),
    });
    await rotated.close();
  });
});
