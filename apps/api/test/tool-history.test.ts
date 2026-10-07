import { ConversationDetailResponse, DataExportResponse, SyncConversationsResponse, type StreamEvent } from "@dash-ai/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { FakeAdapter } from "../src/providers/fake.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { builtinPlugin } from "../src/tools/builtin.js";
import { PluginRegistry } from "../src/tools/registry.js";
import { chatBody, register, sse, testConfig, USING_POSTGRES } from "./helpers.js";
import { createTestPgStore } from "./pgTestStore.js";

// Reopening a conversation shows the tool calls that were recorded for its messages, and only those.

const apps: FastifyInstance[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

async function setup() {
  const pg = USING_POSTGRES ? await createTestPgStore() : undefined;
  const providers = new ProviderRegistry({ openai: new FakeAdapter("openai", 0), anthropic: new FakeAdapter("anthropic", 0) });
  const plugins = new PluginRegistry().register(builtinPlugin);
  const { app } = await buildApp({ config: testConfig(), providers, plugins, store: pg?.store });
  if (pg) app.addHook("onClose", async () => pg.dispose());
  await app.ready();
  apps.push(app);
  return app;
}

const TOOL_PROMPT = '[[fake:tool dash-demo__text_stats {"text":"secret argument text"}]]';

async function chat(app: FastifyInstance, auth: Record<string, string>, body: ReturnType<typeof chatBody>) {
  const res = await app.inject({ method: "POST", url: "/v1/chat/stream", headers: auth, payload: body });
  expect(res.statusCode).toBe(200);
  return sse(res.body);
}

const endOf = (events: StreamEvent[]) => events.find((e): e is Extract<StreamEvent, { event: "message.end" }> => e.event === "message.end")!;

async function detail(app: FastifyInstance, auth: Record<string, string>, id: string) {
  const res = await app.inject({ method: "GET", url: `/v1/conversations/${id}`, headers: auth });
  return { status: res.statusCode, body: res.statusCode === 200 ? ConversationDetailResponse.parse(res.json()) : undefined };
}

describe("historical tool activity", () => {
  it("is returned with the conversation, by sync and in the export, without arguments or results", async () => {
    const app = await setup();
    const user = await register(app);
    expect((await app.inject({ method: "PUT", url: "/v1/plugins/dash-demo", headers: user.auth, payload: { enabled: true } })).statusCode).toBe(200);

    const body = chatBody({ message: { id: "11111111-1111-4111-8111-111111111111", content: TOOL_PROMPT, attachmentIds: [] } });
    const events = await chat(app, user.auth, body);
    const messageId = endOf(events).data.messageId;
    const live = events.filter((e) => e.event === "tool.result");
    expect(live).toHaveLength(1);

    const loaded = (await detail(app, user.auth, body.conversationId)).body!;
    expect(loaded.toolActivity).toEqual([
      expect.objectContaining({ messageId, plugin: "dash-demo", tool: "text_stats", status: "ok", callId: expect.any(String) }),
    ]);
    // The stored record matches what the stream showed at the time.
    const shown = live[0]!.data as { callId: string; durationMs: number };
    expect(loaded.toolActivity[0]).toMatchObject({ callId: shown.callId, durationMs: shown.durationMs });
    expect(JSON.stringify(loaded.toolActivity)).not.toContain("secret argument text");

    const pulled = SyncConversationsResponse.parse((await app.inject({ method: "GET", url: "/v1/sync/conversations", headers: user.auth })).json());
    expect(pulled.changes.find((c) => c.conversation.id === body.conversationId)?.toolActivity).toEqual(loaded.toolActivity);

    const exported = DataExportResponse.parse((await app.inject({ method: "GET", url: "/v1/me/export", headers: user.auth })).json());
    expect(exported.conversations.find((c) => c.conversation.id === body.conversationId)?.toolActivity).toEqual(loaded.toolActivity);
  });

  it("is empty for conversations without tool calls: nothing is invented", async () => {
    const app = await setup();
    const user = await register(app);
    const body = chatBody();
    await chat(app, user.auth, body);
    expect((await detail(app, user.auth, body.conversationId)).body!.toolActivity).toEqual([]);
  });

  it("goes away with the answer it belonged to (regenerate) and with the conversation (delete)", async () => {
    const app = await setup();
    const user = await register(app);
    await app.inject({ method: "PUT", url: "/v1/plugins/dash-demo", headers: user.auth, payload: { enabled: true } });
    const message = { id: "22222222-2222-4222-8222-222222222222", content: TOOL_PROMPT, attachmentIds: [] };
    const body = chatBody({ message });
    await chat(app, user.auth, body);
    expect((await detail(app, user.auth, body.conversationId)).body!.toolActivity).toHaveLength(1);

    // Regenerating the same user message with tools off replaces the answer: its tool call is gone.
    await app.inject({ method: "PUT", url: "/v1/plugins/dash-demo", headers: user.auth, payload: { enabled: false } });
    await chat(app, user.auth, { ...body, message: { ...message, content: "Plain answer please" } });
    const after = (await detail(app, user.auth, body.conversationId)).body!;
    expect(after.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(after.toolActivity).toEqual([]);

    // Deleting the conversation removes its tool records too.
    await app.inject({ method: "PUT", url: "/v1/plugins/dash-demo", headers: user.auth, payload: { enabled: true } });
    const second = chatBody({ message: { ...message, id: "33333333-3333-4333-8333-333333333333" } });
    await chat(app, user.auth, second);
    expect((await app.inject({ method: "DELETE", url: `/v1/conversations/${second.conversationId}`, headers: user.auth })).statusCode).toBe(204);
    const activity = (await app.inject({ method: "GET", url: "/v1/tools/activity", headers: user.auth })).json() as { activity: { conversationId: string }[] };
    expect(activity.activity.some((a) => a.conversationId === second.conversationId)).toBe(false);
  });

  it("is never visible to another account", async () => {
    const app = await setup();
    const owner = await register(app);
    const other = await register(app);
    await app.inject({ method: "PUT", url: "/v1/plugins/dash-demo", headers: owner.auth, payload: { enabled: true } });
    const body = chatBody({ message: { id: "44444444-4444-4444-8444-444444444444", content: TOOL_PROMPT, attachmentIds: [] } });
    await chat(app, owner.auth, body);
    expect((await detail(app, other.auth, body.conversationId)).status).toBe(404);
    const pulled = SyncConversationsResponse.parse((await app.inject({ method: "GET", url: "/v1/sync/conversations", headers: other.auth })).json());
    expect(pulled.changes.flatMap((c) => c.toolActivity)).toEqual([]);
  });
});
