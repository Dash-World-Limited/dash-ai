import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { FAKE_TRIGGERS } from "../src/providers/fake.js";
import type { RouteContext } from "../src/routes/context.js";
import { chatBody, makeApp, register, sse, testId } from "./helpers.js";

/**
 * Provider slowdown and failure, with fake providers only (no paid inference). For every failure
 * shape: the stream slot is released, the SSE stream ends cleanly, the message is saved with an
 * honest status, and the client sees a neutral DASH AI error that names no provider.
 */

const PROVIDER_NAMES = /openai|anthropic|claude|bedrock|nova|fake/i;
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

async function setup(env: Record<string, string> = {}) {
  const { app, context } = await makeApp({
    env: {
      PROVIDER_DETAILS: "hidden",
      FAKE_STREAM_DELAY_MS: "5",
      PROVIDER_IDLE_TIMEOUT_MS: "600",
      PROVIDER_RETRY_BASE_MS: "10",
      ...env,
    },
  });
  apps.push(app);
  return { app, context };
}

async function ask(app: FastifyInstance, auth: { authorization: string }, content: string) {
  const body = chatBody({ modelChoice: "smart", message: { id: testId("msg"), content, attachmentIds: [] } });
  const started = Date.now();
  const res = await app.inject({ method: "POST", url: "/v1/chat/stream", headers: auth, payload: body });
  const events = sse(res.body);
  const detail = (await app.inject({ method: "GET", url: `/v1/conversations/${body.conversationId}`, headers: auth })).json() as {
    messages: { role: string; status: string; content: string }[];
  };
  return { res, events, ms: Date.now() - started, assistant: detail.messages.find((m) => m.role === "assistant") };
}

const final = (events: ReturnType<typeof sse>) => events.find((e) => e.event === "message.end" || e.event === "message.error");

function expectClean(context: RouteContext, events: ReturnType<typeof sse>) {
  expect(events.at(-1)?.event).toBe("stream.end");
  expect(context.streams.size).toBe(0);
  expect(JSON.stringify(events.filter((e) => e.event !== "message.delta" && e.event !== "conversation.title"))).not.toMatch(PROVIDER_NAMES);
}

describe("provider slowdown and failure (fake providers)", () => {
  it("slow time to first byte still answers, inside the timeouts", async () => {
    const { app, context } = await setup({ PROVIDER_IDLE_TIMEOUT_MS: "5000" });
    const { auth } = await register(app);
    const r = await ask(app, auth, `hi ${FAKE_TRIGGERS.ttfb}`);
    expect(final(r.events)?.event).toBe("message.end");
    expect(r.ms).toBeGreaterThanOrEqual(1_900);
    expect(r.assistant?.status).toBe("complete");
    expectClean(context, r.events);
  });

  it("slow time to first byte beyond the idle timeout is a neutral timeout, not a hang", async () => {
    const { app, context } = await setup({ PROVIDER_IDLE_TIMEOUT_MS: "600" });
    const { auth } = await register(app);
    const r = await ask(app, auth, `hi ${FAKE_TRIGGERS.ttfb}`);
    expect(final(r.events)?.event).toBe("message.error");
    expect(r.ms).toBeLessThan(10_000);
    expectClean(context, r.events);
  });

  it("a stream that stalls after its first words ends as a timeout and keeps what was sent", async () => {
    const { app, context } = await setup();
    const { auth } = await register(app);
    const r = await ask(app, auth, `hi ${FAKE_TRIGGERS.stall}`);
    const end = final(r.events)!;
    expect(end.event).toBe("message.error");
    expect((end.data as { error: { code: string } }).error.code).toBe("provider_timeout");
    expect(r.events.some((e) => e.event === "message.delta")).toBe(true);
    expect(r.assistant?.status).toBe("failed");
    expect(r.assistant?.content).toContain("Demonstration answer");
    expectClean(context, r.events);
  });

  it("a connection that breaks after partial output fails once, without a retry that would duplicate text", async () => {
    const { app, context } = await setup();
    const { auth } = await register(app);
    const r = await ask(app, auth, `hi ${FAKE_TRIGGERS.partial}`);
    expect(final(r.events)?.event).toBe("message.error");
    const deltas = r.events.filter((e) => e.event === "message.delta");
    expect(deltas).toHaveLength(1);
    expect(r.assistant?.status).toBe("failed");
    expectClean(context, r.events);
  });

  it("a failure before any output is retried and then answers", async () => {
    const { app, context } = await setup();
    const { auth } = await register(app);
    const r = await ask(app, auth, `hi ${FAKE_TRIGGERS.flaky} ${testId("p")}`);
    expect(final(r.events)?.event).toBe("message.end");
    expect(r.assistant?.status).toBe("complete");
    expectClean(context, r.events);
  });

  it("falls back to the next provider when the first is down, and the client never learns which", async () => {
    const { app, context } = await setup();
    const { auth } = await register(app);
    const r = await ask(app, auth, `hi [[fake:down-openai]]`);
    expect(final(r.events)?.event).toBe("message.end");
    expect(r.assistant?.status).toBe("complete");
    expectClean(context, r.events);
  });

  it("every provider down is one neutral error", async () => {
    const { app, context } = await setup();
    const { auth } = await register(app);
    const r = await ask(app, auth, `hi [[fake:down-openai]] [[fake:down-anthropic]]`);
    const end = final(r.events)!;
    expect(end.event).toBe("message.error");
    expect((end.data as { error: { message: string } }).error.message).not.toMatch(PROVIDER_NAMES);
    expect(r.assistant?.status).toBe("failed");
    expectClean(context, r.events);
  });

  it("cancelling a slow-start stream stops it promptly and frees the slot", async () => {
    const { app, context } = await setup({ PROVIDER_IDLE_TIMEOUT_MS: "30000" });
    const { auth } = await register(app);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address() as { port: number };
    const base = `http://127.0.0.1:${address.port}`;
    const body = chatBody({ modelChoice: "smart", message: { id: testId("msg"), content: `hi ${FAKE_TRIGGERS.hang}`, attachmentIds: [] } });
    const res = await fetch(`${base}/v1/chat/stream`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });
    const streamId = res.headers.get("x-stream-id")!;
    expect(context.streams.size).toBe(1);
    const started = Date.now();
    const cancel = await fetch(`${base}/v1/chat/streams/${streamId}/cancel`, { method: "POST", headers: auth });
    expect(((await cancel.json()) as { cancelled: boolean }).cancelled).toBe(true);
    const events = sse(await res.text());
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(events.at(-1)?.event).toBe("stream.end");
    expect(context.streams.size).toBe(0);
  });

  it("many concurrent failing streams across accounts all release their slots", async () => {
    const { app, context } = await setup();
    const accounts = await Promise.all(Array.from({ length: 10 }, () => register(app)));
    const triggers = [FAKE_TRIGGERS.partial, FAKE_TRIGGERS.stall, FAKE_TRIGGERS.error, "[[fake:down-openai]]", FAKE_TRIGGERS.ttfb];
    const results = await Promise.all(
      accounts.flatMap((a, i) => [0, 1, 2].map((k) => ask(app, a.auth, `hi ${triggers[(i + k) % triggers.length]} ${testId("p")}`))),
    );
    for (const r of results) {
      expect(r.res.statusCode).toBe(200);
      expect(r.events.at(-1)?.event).toBe("stream.end");
    }
    expect(context.streams.size).toBe(0);
  });
});
