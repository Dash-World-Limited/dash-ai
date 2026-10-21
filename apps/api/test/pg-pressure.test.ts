import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { buildApp } from "../src/app.js";
import { PostgresStore } from "../src/store/postgresStore.js";
import { FaultProxy } from "./cluster/cluster.js";
import { multipartBody, smallPdf } from "./cluster/documents.js";
import { chatBody, LogCapture, register, testConfig } from "./helpers.js";
import { TEST_DATABASE_URL, testCipher } from "./pgTestStore.js";

/**
 * PostgreSQL pressure on one instance: an exhausted pool, an interrupted database and a slow one.
 * Every request must fail in bounded time as "busy" (503, retryable), never wait without limit,
 * never report success it did not have, and never leak a stream slot; the instance recovers by
 * itself when the database does.
 */
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => undefined);
});

async function setup(options: { poolMax?: number; acquireMs?: number; viaProxy?: boolean; logs?: LogCapture } = {}) {
  const schema = `t_${randomBytes(6).toString("hex")}`;
  const proxy = options.viaProxy ? await FaultProxy.start(TEST_DATABASE_URL!) : undefined;
  if (proxy) cleanups.push(() => proxy.close());
  const store = await PostgresStore.connect({
    connectionString: proxy ? proxy.urlFor(TEST_DATABASE_URL!) : TEST_DATABASE_URL!,
    cipher: testCipher(),
    schema,
    poolMax: options.poolMax ?? 3,
    acquireTimeoutMs: options.acquireMs ?? 1_000,
  });
  cleanups.push(async () => {
    proxy?.up();
    await store.dropSchema(schema).catch(() => undefined);
    await store.close();
  });
  const { app, context } = await buildApp({
    config: testConfig({ PROVIDER_DETAILS: "hidden", ...(options.logs ? { LOG_LEVEL: "debug" } : {}) }),
    store,
    logStream: options.logs,
  });
  await app.ready();
  cleanups.push(() => app.close());
  return { app, context, store, proxy };
}

describe.skipIf(!TEST_DATABASE_URL)("PostgreSQL pressure", () => {
  it("an exhausted pool refuses as busy within the acquisition timeout, then recovers", async () => {
    const { app, context, store } = await setup({ poolMax: 2, acquireMs: 800 });
    const user = await register(app);
    const held: pg.PoolClient[] = [await store.pool.connect(), await store.pool.connect()];

    const started = Date.now();
    const list = await app.inject({ method: "GET", url: "/v1/conversations", headers: user.auth });
    const waited = Date.now() - started;
    expect(list.statusCode).toBe(503);
    expect(list.json()).toMatchObject({ error: { code: "rate_limited", retryable: true } });
    expect(waited).toBeLessThan(3_000);

    const chat = await app.inject({ method: "POST", url: "/v1/chat/stream", headers: user.auth, payload: chatBody({ modelChoice: "smart" }) });
    expect(chat.statusCode).toBe(503);
    expect(context.streams.size).toBe(0);
    expect(context.metrics.render()).toMatch(/dash_database_errors_total\{kind="pool_timeout"\} [1-9]/);

    for (const c of held) c.release();
    expect((await app.inject({ method: "GET", url: "/v1/conversations", headers: user.auth })).statusCode).toBe(200);
  });

  it("many concurrent requests on a tiny pool all finish in bounded time: served or busy, none hang", async () => {
    const { app, store } = await setup({ poolMax: 2, acquireMs: 1_000 });
    const users = await Promise.all(Array.from({ length: 5 }, () => register(app)));
    const slow = await store.pool.connect();
    const started = Date.now();
    const results = await Promise.all(
      Array.from({ length: 60 }, (_, i) => app.inject({ method: "GET", url: "/v1/conversations", headers: users[i % 5]!.auth })),
    );
    slow.release();
    const statuses = results.map((r) => r.statusCode);
    expect(statuses.every((s) => s === 200 || s === 503)).toBe(true);
    expect(statuses.filter((s) => s === 200).length).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it("a database that goes away fails fast as busy, is reported not ready, and is used again when it is back", async () => {
    const { app, context, proxy } = await setup({ viaProxy: true, acquireMs: 1_000 });
    const user = await register(app);
    proxy!.down();
    const started = Date.now();
    const res = await app.inject({ method: "GET", url: "/v1/conversations", headers: user.auth });
    expect(res.statusCode).toBe(503);
    expect(Date.now() - started).toBeLessThan(3_000);
    const chat = await app.inject({ method: "POST", url: "/v1/chat/stream", headers: user.auth, payload: chatBody({ modelChoice: "smart" }) });
    expect(chat.statusCode).toBe(503);
    expect(context.streams.size).toBe(0);
    expect((await app.inject({ method: "GET", url: "/ready" })).statusCode).toBe(503);

    proxy!.up();
    let back = 0;
    for (let i = 0; i < 20 && back !== 200; i++) {
      back = (await app.inject({ method: "GET", url: "/v1/conversations", headers: user.auth })).statusCode;
      if (back !== 200) await new Promise((r) => setTimeout(r, 200));
    }
    expect(back).toBe(200);
  });

  it("every pooled connection carries the statement timeout, and a statement that hits it is busy, not success", async () => {
    const { store } = await setup();
    const { rows } = await store.pool.query<{ statement_timeout: string }>("SHOW statement_timeout");
    expect(rows[0]!.statement_timeout).toBe("30s");
    const client = await store.pool.connect();
    try {
      await client.query("SET statement_timeout = 200");
      await expect(client.query("SELECT pg_sleep(2)")).rejects.toMatchObject({ code: "57014" });
    } finally {
      await client.query("RESET statement_timeout").catch(() => undefined);
      client.release();
    }
  });

  it("chat, uploads and Run now at once on an exhausted pool: all busy and retryable, nothing leaked, no private text logged", async () => {
    const logs = new LogCapture();
    const { app, context, store } = await setup({ poolMax: 3, acquireMs: 800, logs });
    const user = await register(app);
    const created = await app.inject({
      method: "POST",
      url: "/v1/automations",
      headers: user.auth,
      payload: { name: "Brief", prompt: "secret automation prompt", mode: "business", schedule: { kind: "daily", time: "08:00" }, timeZone: "Africa/Lagos" },
    });
    expect(created.statusCode).toBe(201);
    const automationId = (created.json() as { id: string }).id;
    const held: pg.PoolClient[] = [await store.pool.connect(), await store.pool.connect(), await store.pool.connect()];
    const file = multipartBody("p.pdf", "application/pdf", smallPdf("secret document text"));
    const started = Date.now();
    const results = await Promise.all([
      ...Array.from({ length: 4 }, () =>
        app.inject({ method: "POST", url: "/v1/chat/stream", headers: user.auth, payload: chatBody({ modelChoice: "smart", message: { id: `m${Math.random()}`, content: "secret chat prompt", attachmentIds: [] } }) }),
      ),
      ...Array.from({ length: 4 }, () =>
        app.inject({ method: "POST", url: "/v1/documents", headers: { ...user.auth, "content-type": file.contentType }, payload: file.body }),
      ),
      ...Array.from({ length: 2 }, () => app.inject({ method: "POST", url: `/v1/automations/${automationId}/run`, headers: user.auth })),
    ]);
    expect(Date.now() - started).toBeLessThan(10_000);
    for (const r of results) {
      expect(r.statusCode).toBe(503);
      expect(r.json()).toMatchObject({ error: { retryable: true } });
    }
    expect(context.streams.size).toBe(0);
    expect(context.extraction.state).toEqual({ active: 0, waiting: 0, held: 0 });
    expect(context.metrics.render()).toMatch(/dash_database_errors_total\{kind="pool_timeout"\} [1-9]/);
    expect(logs.text).not.toMatch(/secret (chat prompt|document text|automation prompt)/);

    for (const c of held) c.release();
    const chat = await app.inject({ method: "POST", url: "/v1/chat/stream", headers: user.auth, payload: chatBody({ modelChoice: "smart" }) });
    expect(chat.statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/v1/documents", headers: { ...user.auth, "content-type": file.contentType }, payload: file.body })).statusCode).toBe(201);
    expect(context.streams.size).toBe(0);
  });
});
