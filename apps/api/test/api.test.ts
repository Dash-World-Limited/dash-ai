import {
  AuthResponse,
  ConversationDetailResponse,
  ConversationListResponse,
  DataExportResponse,
  DocumentListResponse,
  DocumentResponse,
  ErrorResponse,
  HealthResponse,
  MeResponse,
  ProvidersResponse,
  UsageSummaryResponse,
  type StreamEvent,
} from "@dash-ai/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { FAKE_TRIGGERS } from "../src/providers/fake.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { SpyAdapter } from "./helpers.js";
import {
  LogCapture,
  PNG_BYTES,
  chatBody,
  makeApp,
  makeDocx,
  makePdf,
  multipart,
  register,
  spyRegistry,
  sse,
  testId,
  waitFor,
} from "./helpers.js";

const apps: FastifyInstance[] = [];
async function setup(options: Parameters<typeof makeApp>[0] = {}) {
  const made = await makeApp(options);
  apps.push(made.app);
  return made;
}
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

const byEvent = <N extends StreamEvent["event"]>(events: StreamEvent[], name: N) =>
  events.filter((e): e is Extract<StreamEvent, { event: N }> => e.event === name);

describe("system endpoints", () => {
  it("health and provider status match the contracts", async () => {
    const { app } = await setup();
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(HealthResponse.parse(health.json())).toMatchObject({ status: "ok" });

    const providers = await app.inject({ method: "GET", url: "/v1/providers" });
    const body = ProvidersResponse.parse(providers.json());
    expect(body.providers.map((p) => [p.id, p.mode])).toEqual([
      ["openai", "fake"],
      ["anthropic", "fake"],
    ]);
    expect(body.compareAvailable).toBe(true);
    expect(body.research.liveSearchAvailable).toBe(false);
    expect(providers.headers["x-content-type-options"]).toBe("nosniff");
    expect(providers.headers["cache-control"]).toBe("no-store");
  });

  it("returns contract-shaped 404s", async () => {
    const { app } = await setup();
    const res = await app.inject({ method: "GET", url: "/v1/nope" });
    expect(res.statusCode).toBe(404);
    expect(ErrorResponse.parse(res.json()).error.code).toBe("not_found");
  });
});

describe("authentication", () => {
  it("registers, signs in, reads the profile and signs out", async () => {
    const { app } = await setup();
    const reg = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: "Ada@Example.com", password: "correct horse battery", displayName: "Ada" },
    });
    expect(reg.statusCode).toBe(201);
    const auth = AuthResponse.parse(reg.json());
    expect(auth.user.email).toBe("ada@example.com");

    const dup = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: "ada@example.com", password: "another password", displayName: "Ada" },
    });
    expect(dup.statusCode).toBe(409);

    const bad = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "ada@example.com", password: "wrong password" },
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.message).toBe("Email or password is incorrect.");

    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "ADA@example.com", password: "correct horse battery" },
    });
    expect(login.statusCode).toBe(200);
    const token = AuthResponse.parse(login.json()).token;

    const me = await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${token}` } });
    expect(MeResponse.parse(me.json()).user.displayName).toBe("Ada");

    const logout = await app.inject({ method: "POST", url: "/v1/auth/logout", headers: { authorization: `Bearer ${token}` } });
    expect(logout.statusCode).toBe(204);
    const after = await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${token}` } });
    expect(after.statusCode).toBe(401);
  });

  it("validates input and requires auth", async () => {
    const { app } = await setup();
    const weak = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: "not-an-email", password: "short", displayName: "" },
    });
    expect(weak.statusCode).toBe(400);
    expect(ErrorResponse.parse(weak.json()).error.code).toBe("bad_request");

    const noAuth = await app.inject({ method: "GET", url: "/v1/conversations" });
    expect(noAuth.statusCode).toBe(401);
    const badToken = await app.inject({ method: "GET", url: "/v1/conversations", headers: { authorization: "Bearer nope" } });
    expect(badToken.statusCode).toBe(401);
  });

  it("rate-limits sign-in attempts", async () => {
    const { app } = await setup({ env: { RATE_LIMIT_AUTH_PER_MINUTE: "3" } });
    const attempt = () =>
      app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: "x@example.com", password: "whatever1" } });
    for (let i = 0; i < 3; i++) expect((await attempt()).statusCode).toBe(401);
    const limited = await attempt();
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
    expect(limited.json().error).toMatchObject({ code: "rate_limited", retryable: true });
  });
});

describe("conversations", () => {
  it("creates, lists, renames and deletes", async () => {
    const { app } = await setup();
    const { auth } = await register(app);
    const id = testId("conv");
    const created = await app.inject({ method: "POST", url: "/v1/conversations", headers: auth, payload: { id, mode: "business" } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ id, title: "New chat", mode: "business" });

    const renamed = await app.inject({ method: "PATCH", url: `/v1/conversations/${id}`, headers: auth, payload: { title: "Kiosk plan" } });
    expect(renamed.json().title).toBe("Kiosk plan");

    const list = ConversationListResponse.parse((await app.inject({ method: "GET", url: "/v1/conversations", headers: auth })).json());
    expect(list.conversations.map((c) => c.id)).toEqual([id]);

    const del = await app.inject({ method: "DELETE", url: `/v1/conversations/${id}`, headers: auth });
    expect(del.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/v1/conversations/${id}`, headers: auth })).statusCode).toBe(404);
  });

  it("isolates users from each other", async () => {
    const { app } = await setup();
    const alice = await register(app);
    const bob = await register(app);
    const id = testId("conv");
    await app.inject({ method: "POST", url: "/v1/conversations", headers: alice.auth, payload: { id } });
    expect((await app.inject({ method: "GET", url: `/v1/conversations/${id}`, headers: bob.auth })).statusCode).toBe(404);
    const steal = await app.inject({ method: "POST", url: "/v1/chat/stream", headers: bob.auth, payload: chatBody({ conversationId: id }) });
    expect(steal.statusCode).toBe(404);
  });
});

describe("streaming chat", () => {
  it("streams a single-provider answer and persists it with its model label", async () => {
    const { app } = await setup();
    const { auth } = await register(app);
    const body = chatBody({ modelChoice: "claude", message: { id: testId("msg"), content: "Draft a launch email", attachmentIds: [] } });
    const res = await app.inject({ method: "POST", url: "/v1/chat/stream", headers: auth, payload: body });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");

    const events = sse(res.body);
    const start = byEvent(events, "stream.start")[0]!;
    expect(start.data.targets).toHaveLength(1);
    expect(start.data.targets[0]).toMatchObject({ provider: "anthropic", model: "fake-anthropic", demo: true });
    expect(byEvent(events, "conversation.title")[0]?.data.title).toBe("Draft a launch email");
    const text = byEvent(events, "message.delta").map((e) => e.data.text).join("");
    expect(text).toContain("Demonstration answer — fake Claude adapter");
    expect(byEvent(events, "message.end")[0]?.data.finishReason).toBe("stop");
    expect(events.at(-1)?.event).toBe("stream.end");

    const detail = ConversationDetailResponse.parse(
      (await app.inject({ method: "GET", url: `/v1/conversations/${body.conversationId}`, headers: auth })).json(),
    );
    expect(detail.conversation.title).toBe("Draft a launch email");
    expect(detail.messages.map((m) => [m.role, m.origin, m.model, m.status, m.demo])).toEqual([
      ["user", null, null, "complete", false],
      ["assistant", "anthropic", "fake-anthropic", "complete", true],
    ]);
    expect(detail.messages[1]?.content).toBe(text);
  });

  it("Dash Smart routes by mode and explains why", async () => {
    const { app } = await setup();
    const { auth } = await register(app);
    const writing = sse((await app.inject({ method: "POST", url: "/v1/chat/stream", headers: auth, payload: chatBody({ modelChoice: "smart", mode: "writing" }) })).body);
    expect(byEvent(writing, "stream.start")[0]?.data.targets[0]?.provider).toBe("anthropic");
    const business = sse((await app.inject({ method: "POST", url: "/v1/chat/stream", headers: auth, payload: chatBody({ modelChoice: "smart", mode: "business" }) })).body);
    const start = byEvent(business, "stream.start")[0]!;
    expect(start.data.targets[0]?.provider).toBe("openai");
    expect(start.data.routingReason).toMatch(/Business/);
  });

  it("Compare streams both providers side by side under one compare group", async () => {
    const { app } = await setup();
    const { auth } = await register(app);
    const body = chatBody({ modelChoice: "compare" });
    const events = sse((await app.inject({ method: "POST", url: "/v1/chat/stream", headers: auth, payload: body })).body);
    const start = byEvent(events, "stream.start")[0]!;
    expect(start.data.compareGroupId).toBe(body.message.id);
    expect(start.data.targets.map((t) => t.provider)).toEqual(["openai", "anthropic"]);
    const ends = byEvent(events, "message.end");
    expect(new Set(ends.map((e) => e.data.messageId))).toEqual(new Set(start.data.targets.map((t) => t.messageId)));

    const detail = ConversationDetailResponse.parse(
      (await app.inject({ method: "GET", url: `/v1/conversations/${body.conversationId}`, headers: auth })).json(),
    );
    const answers = detail.messages.filter((m) => m.role === "assistant");
    expect(answers.map((m) => m.origin).sort()).toEqual(["anthropic", "openai"]);
    expect(answers.every((m) => m.compareGroupId === body.message.id)).toBe(true);
  });

  it("refuses explicit or compare choices that are not configured instead of silently switching", async () => {
    const { registry } = spyRegistry(["openai"]);
    const { app } = await setup({ providers: registry });
    const { auth } = await register(app);
    for (const modelChoice of ["claude", "compare"]) {
      const res = await app.inject({ method: "POST", url: "/v1/chat/stream", headers: auth, payload: chatBody({ modelChoice }) });
      expect(res.statusCode).toBe(503);
      expect(ErrorResponse.parse(res.json()).error.code).toBe("provider_not_configured");
    }
    const smart = sse((await app.inject({ method: "POST", url: "/v1/chat/stream", headers: auth, payload: chatBody({ modelChoice: "smart", mode: "writing" }) })).body);
    expect(byEvent(smart, "stream.start")[0]?.data.routingReason).toMatch(/preferred provider is not configured/);
  });

  it("fails clearly when no provider is configured", async () => {
    const { app } = await setup({ providers: new ProviderRegistry({}) });
    const { auth } = await register(app);
    const res = await app.inject({ method: "POST", url: "/v1/chat/stream", headers: auth, payload: chatBody({ modelChoice: "smart" }) });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("no_provider_available");
  });

  it("never forwards one provider's answers to the other", async () => {
    const { registry, spies } = spyRegistry();
    const { app } = await setup({ providers: registry });
    const { auth } = await register(app);
    const history = [
      { role: "user", content: "first question", origin: null },
      { role: "assistant", content: "OPENAI-ONLY-ANSWER", origin: "openai" },
      { role: "assistant", content: "CLAUDE-ONLY-ANSWER", origin: "anthropic" },
    ];
    await app.inject({ method: "POST", url: "/v1/chat/stream", headers: auth, payload: chatBody({ modelChoice: "compare", history }) });
    const openaiSeen = JSON.stringify(spies.openai!.requests[0]!.messages);
    const claudeSeen = JSON.stringify(spies.anthropic!.requests[0]!.messages);
    expect(openaiSeen).toContain("OPENAI-ONLY-ANSWER");
    expect(openaiSeen).not.toContain("CLAUDE-ONLY-ANSWER");
    expect(claudeSeen).toContain("CLAUDE-ONLY-ANSWER");
    expect(claudeSeen).not.toContain("OPENAI-ONLY-ANSWER");
    expect(spies.openai!.requests[0]!.system).toContain("Mode: General");
  });

  it("applies mode instructions", async () => {
    const { registry, spies } = spyRegistry();
    const { app } = await setup({ providers: registry });
    const { auth } = await register(app);
    await app.inject({ method: "POST", url: "/v1/chat/stream", headers: auth, payload: chatBody({ modelChoice: "openai", mode: "research" }) });
    expect(spies.openai!.requests[0]!.system).toMatch(/no live web access/);
  });

  it("regenerating replaces the previous answer on the server", async () => {
    const { app } = await setup();
    const { auth } = await register(app);
    const body = chatBody();
    await app.inject({ method: "POST", url: "/v1/chat/stream", headers: auth, payload: body });
    await app.inject({ method: "POST", url: "/v1/chat/stream", headers: auth, payload: { ...body, modelChoice: "claude" } });
    const detail = ConversationDetailResponse.parse(
      (await app.inject({ method: "GET", url: `/v1/conversations/${body.conversationId}`, headers: auth })).json(),
    );
    expect(detail.messages.map((m) => m.origin)).toEqual([null, "anthropic"]);
  });

  it("reports provider failures as message errors and records usage", async () => {
    const { app } = await setup();
    const { auth } = await register(app);
    const failing = chatBody({ message: { id: testId("msg"), content: `please ${FAKE_TRIGGERS.error}`, attachmentIds: [] } });
    const events = sse((await app.inject({ method: "POST", url: "/v1/chat/stream", headers: auth, payload: failing })).body);
    const error = byEvent(events, "message.error")[0]!;
    expect(error.data.error).toMatchObject({ code: "provider_error", retryable: true });
    expect(events.at(-1)?.event).toBe("stream.end");

    await app.inject({ method: "POST", url: "/v1/chat/stream", headers: auth, payload: chatBody() });
    const usage = UsageSummaryResponse.parse((await app.inject({ method: "GET", url: "/v1/usage", headers: auth })).json());
    expect(usage.totals).toEqual([expect.objectContaining({ provider: "openai", requests: 2 })]);
    expect(usage.recent[0]?.outputTokens).toBeGreaterThan(0);
  });

  it("times out idle provider streams", async () => {
    const { app } = await setup({ env: { PROVIDER_IDLE_TIMEOUT_MS: "500" } });
    const { auth } = await register(app);
    const events = sse(
      (
        await app.inject({
          method: "POST",
          url: "/v1/chat/stream",
          headers: auth,
          payload: chatBody({ message: { id: testId("msg"), content: FAKE_TRIGGERS.hang, attachmentIds: [] } }),
        })
      ).body,
    );
    expect(byEvent(events, "message.error")[0]?.data.error).toMatchObject({ code: "provider_timeout", retryable: true });
  });

  it("validates chat requests", async () => {
    const { app } = await setup();
    const { auth } = await register(app);
    const blank = await app.inject({
      method: "POST",
      url: "/v1/chat/stream",
      headers: auth,
      payload: chatBody({ message: { id: testId("msg"), content: "  ", attachmentIds: [] } }),
    });
    expect(blank.statusCode).toBe(400);
    const badChoice = await app.inject({ method: "POST", url: "/v1/chat/stream", headers: auth, payload: chatBody({ modelChoice: "gpt" }) });
    expect(badChoice.statusCode).toBe(400);
    const badJson = await app.inject({
      method: "POST",
      url: "/v1/chat/stream",
      headers: { ...auth, "content-type": "application/json" },
      payload: "{not json",
    });
    expect(badJson.statusCode).toBe(400);
    const tooLong = await app.inject({
      method: "POST",
      url: "/v1/chat/stream",
      headers: auth,
      payload: chatBody({ history: Array.from({ length: 10 }, () => ({ role: "user", content: "x".repeat(25_000), origin: null })) }),
    });
    expect(tooLong.statusCode).toBe(413);
  });

  it("limits concurrent streams per user", async () => {
    const { app, context } = await setup({ env: { MAX_CONCURRENT_STREAMS_PER_USER: "1" } });
    const { auth, user } = await register(app);
    context.streams.register("existing-stream", user.id, new AbortController());
    const res = await app.inject({ method: "POST", url: "/v1/chat/stream", headers: auth, payload: chatBody() });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("too_many_streams");
  });
});

describe("cancellation over a real connection", () => {
  async function openStream(app: FastifyInstance, auth: Record<string, string>, body: unknown, signal?: AbortSignal) {
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const res = await fetch(`${address}/v1/chat/stream`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal,
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const readUntil = async (predicate: (text: string) => boolean) => {
      while (!predicate(buffer)) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
      return buffer;
    };
    return { address, readUntil };
  }

  it("the cancel endpoint stops generation and keeps the partial answer as stopped", async () => {
    const { app } = await setup();
    const { auth } = await register(app);
    const body = chatBody({ message: { id: testId("msg"), content: `go ${FAKE_TRIGGERS.slow}`, attachmentIds: [] } });
    const { address, readUntil } = await openStream(app, auth, body);
    const head = await readUntil((t) => t.includes("event: message.delta"));
    const streamId = (sse(head.slice(0, head.indexOf("\n\n") + 2))[0] as Extract<StreamEvent, { event: "stream.start" }>).data.streamId;

    const cancel = await fetch(`${address}/v1/chat/streams/${streamId}/cancel`, { method: "POST", headers: auth });
    expect(await cancel.json()).toEqual({ streamId, cancelled: true });

    const all = await readUntil((t) => t.includes("event: stream.end"));
    const end = byEvent(sse(all), "message.end")[0]!;
    expect(end.data.finishReason).toBe("cancelled");

    const detail = ConversationDetailResponse.parse(
      await (await fetch(`${address}/v1/conversations/${body.conversationId}`, { headers: auth })).json(),
    );
    const answer = detail.messages.find((m) => m.role === "assistant")!;
    expect(answer.status).toBe("stopped");
    expect(answer.content.length).toBeGreaterThan(0);
  });

  it("closing the connection aborts the provider request", async () => {
    const { app, context } = await setup();
    const { auth } = await register(app);
    const controller = new AbortController();
    const body = chatBody({ message: { id: testId("msg"), content: FAKE_TRIGGERS.slow, attachmentIds: [] } });
    const { readUntil } = await openStream(app, auth, body, controller.signal);
    await readUntil((t) => t.includes("event: message.delta"));
    expect(context.streams.size).toBe(1);
    controller.abort();
    await waitFor(() => context.streams.size === 0);
    await waitFor(async () => {
      const messages = await context.store.listMessages(body.conversationId);
      return messages.some((m) => m.role === "assistant" && m.status === "stopped");
    });
  });

  it("users cannot cancel other users' streams", async () => {
    const { app, context } = await setup();
    const alice = await register(app);
    const bob = await register(app);
    context.streams.register("alice-stream-1", alice.user.id, new AbortController());
    const res = await app.inject({ method: "POST", url: "/v1/chat/streams/alice-stream-1/cancel", headers: bob.auth });
    expect(res.json()).toEqual({ streamId: "alice-stream-1", cancelled: false });
  });
});

describe("documents", () => {
  async function upload(app: FastifyInstance, auth: Record<string, string>, name: string, type: string, bytes: Buffer) {
    const form = multipart(name, type, bytes);
    return app.inject({ method: "POST", url: "/v1/documents", headers: { ...auth, ...form.headers }, payload: form.payload });
  }

  it("extracts text from TXT, PDF and DOCX", async () => {
    const { app } = await setup();
    const { auth } = await register(app);
    const txt = await upload(app, auth, "notes.txt", "text/plain", Buffer.from("﻿Kiosk opening hours: 7am to 7pm."));
    expect(txt.statusCode).toBe(201);
    expect(DocumentResponse.parse(txt.json())).toMatchObject({ kind: "txt", status: "ready", extractedChars: 32 });

    const pdf = await upload(app, auth, "plan.pdf", "application/pdf", makePdf("Quarterly revenue grew"));
    expect(pdf.statusCode).toBe(201);
    const pdfBody = DocumentResponse.parse(pdf.json());
    expect(pdfBody).toMatchObject({ kind: "pdf", status: "ready", pageCount: 1 });
    expect(pdfBody.extractedChars).toBeGreaterThan(10);

    const docx = await upload(
      app,
      auth,
      "brief.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      await makeDocx("Brand brief for Dash World"),
    );
    expect(docx.statusCode).toBe(201);
    expect(DocumentResponse.parse(docx.json())).toMatchObject({ kind: "docx", status: "ready", extractedChars: 26 });

    const list = DocumentListResponse.parse((await app.inject({ method: "GET", url: "/v1/documents", headers: auth })).json());
    expect(list.documents).toHaveLength(3);
  });

  it("accepts images but never pretends to analyse them", async () => {
    const { app } = await setup();
    const { auth } = await register(app);
    const res = await upload(app, auth, "photo.png", "image/png", PNG_BYTES);
    expect(res.statusCode).toBe(201);
    const doc = DocumentResponse.parse(res.json());
    expect(doc.status).toBe("unsupported");
    expect(doc.statusDetail).toMatch(/not available yet/);

    const chat = await app.inject({
      method: "POST",
      url: "/v1/chat/stream",
      headers: auth,
      payload: chatBody({ message: { id: testId("msg"), content: "Describe it", attachmentIds: [doc.id] } }),
    });
    expect(chat.statusCode).toBe(422);
    expect(chat.json().error.code).toBe("document_unreadable");
  });

  it("rejects unsupported, disguised, empty and oversized files", async () => {
    const { app } = await setup();
    const { auth } = await register(app);
    expect((await upload(app, auth, "virus.exe", "application/octet-stream", Buffer.from("MZ..."))).statusCode).toBe(415);
    expect((await upload(app, auth, "fake.pdf", "application/pdf", PNG_BYTES)).statusCode).toBe(415);
    expect((await upload(app, auth, "binary.txt", "text/plain", Buffer.from([0x61, 0x00, 0x62]))).statusCode).toBe(415);
    expect((await upload(app, auth, "latin1.txt", "text/plain", Buffer.from([0x63, 0x61, 0x66, 0xe9]))).statusCode).toBe(415);
    expect((await upload(app, auth, "empty.txt", "text/plain", Buffer.alloc(0))).statusCode).toBe(400);
    const big = await upload(app, auth, "big.txt", "text/plain", Buffer.alloc(10 * 1024 * 1024 + 1, 0x61));
    expect(big.statusCode).toBe(413);
    expect(big.json().error.code).toBe("payload_too_large");
    const notMultipart = await app.inject({ method: "POST", url: "/v1/documents", headers: auth, payload: { file: "x" } });
    expect(notMultipart.statusCode).toBe(415);
  });

  it("sends extracted document text only to the chosen provider, delimited as a document", async () => {
    const { registry, spies } = spyRegistry();
    const { app } = await setup({ providers: registry });
    const { auth } = await register(app);
    const doc = DocumentResponse.parse((await upload(app, auth, "terms.txt", "text/plain", Buffer.from("Refunds within 30 days."))).json());
    await app.inject({
      method: "POST",
      url: "/v1/chat/stream",
      headers: auth,
      payload: chatBody({ modelChoice: "claude", mode: "documents", message: { id: testId("msg"), content: "Summarise", attachmentIds: [doc.id] } }),
    });
    expect(spies.openai!.requests).toHaveLength(0);
    const sent = spies.anthropic!.requests[0]!.messages.at(-1)!.content;
    expect(sent).toContain('<document name="terms.txt" type="txt">\nRefunds within 30 days.\n</document>');
    expect(sent.endsWith("Summarise")).toBe(true);

    const del = await app.inject({ method: "DELETE", url: `/v1/documents/${doc.id}`, headers: auth });
    expect(del.statusCode).toBe(204);
  });
});

describe("account data rights", () => {
  it("exports everything and deletes the account", async () => {
    const { app } = await setup();
    const { auth } = await register(app);
    const body = chatBody();
    await app.inject({ method: "POST", url: "/v1/chat/stream", headers: auth, payload: body });
    const exported = DataExportResponse.parse((await app.inject({ method: "GET", url: "/v1/me/export", headers: auth })).json());
    expect(exported.conversations[0]?.messages).toHaveLength(2);
    expect(exported.usage).toHaveLength(1);

    expect((await app.inject({ method: "DELETE", url: "/v1/me", headers: auth })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/v1/me", headers: auth })).statusCode).toBe(401);
  });
});

describe("privacy-safe logging", () => {
  it("never writes prompts, documents, answers or tokens to logs", async () => {
    const logs = new LogCapture();
    const { registry } = spyRegistry();
    const canaryAnswer = new SpyAdapter("openai", [
      { type: "text", text: "ANSWER-CANARY-9f2c" },
      { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const providers = new ProviderRegistry({ openai: canaryAnswer, anthropic: registry.get("anthropic")! });
    const { app } = await setup({ providers, logs });
    const { auth, token } = await register(app);
    const form = multipart("secret-plan.txt", "text/plain", Buffer.from("DOCUMENT-CANARY-51aa"));
    const doc = (await app.inject({ method: "POST", url: "/v1/documents", headers: { ...auth, ...form.headers }, payload: form.payload })).json() as { id: string };
    await app.inject({
      method: "POST",
      url: "/v1/chat/stream?q=QUERY-CANARY-77",
      headers: auth,
      payload: chatBody({ message: { id: testId("msg"), content: "PROMPT-CANARY-3b1d", attachmentIds: [doc.id] } }),
    });
    await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: "nobody@example.com", password: "PASSWORD-CANARY" } });

    const text = logs.text;
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("chat stream finished");
    for (const canary of ["PROMPT-CANARY", "DOCUMENT-CANARY", "ANSWER-CANARY", "QUERY-CANARY", "PASSWORD-CANARY", token]) {
      expect(text).not.toContain(canary);
    }
  });
});
