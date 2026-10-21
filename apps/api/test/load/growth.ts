/**
 * Growth-sensitive endpoints on a realistically enlarged account (real PostgreSQL, one API in process).
 * Seeds one account at each size, then times every account-wide read over real HTTP and records its
 * response size and the peak heap growth while it ran (sampled every 5 ms).
 *
 *   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/dash_test npx tsx test/load/growth.ts [sizes...]
 *
 * Sizes are conversation counts (default 100 1000 5000); each conversation gets 20 messages of about
 * 1,500 characters and one usage row per assistant message. Prints one JSON report.
 */
import { randomBytes } from "node:crypto";
import { buildApp } from "../../src/app.js";
import { newRun } from "../../src/automations/service.js";
import { createTestPgStore } from "../pgTestStore.js";
import { register, testConfig } from "../helpers.js";

const sizes = process.argv.slice(2).map(Number).filter((n) => n > 0);
const SIZES = sizes.length ? sizes : [100, 1_000, 5_000];
const MESSAGES_PER_CONVERSATION = 20;
const TEXT = "Quarterly planning notes and a detailed answer. ".repeat(31).slice(0, 1_500);
const id = (p: string) => `${p}-${randomBytes(8).toString("hex")}`;

async function pool<T>(items: T[], width: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: width }, async () => {
    while (next < items.length) await fn(items[next++]!);
  }));
}

const pg = await createTestPgStore();
const store = pg.store;
const config = testConfig({ PROVIDER_DETAILS: "hidden", RATE_LIMIT_API_PER_MINUTE: "100000", RATE_LIMIT_AUTH_PER_MINUTE: "1000", DOCUMENTS_MAX_PER_ACCOUNT: "200" });
const { app, context } = await buildApp({ config, store });
await app.listen({ port: 0, host: "127.0.0.1" });
const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

/** Real HTTP: the body is counted and dropped as it arrives, so the heap measured is the server's. */
async function fetchCounting(url: string, headers: Record<string, string>): Promise<{ status: number; bytes: number }> {
  const res = await fetch(`${base}${url}`, { headers });
  let bytes = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) bytes += chunk.length;
  return { status: res.status, bytes };
}

const report: Record<string, unknown>[] = [];
try {
  for (const conversations of SIZES) {
    const account = await register(app, `growth-${conversations}-${Date.now()}@example.com`);
    const userId = account.user.id;
    const seedStarted = Date.now();
    const base = Date.now() - conversations * 60_000;
    await pool([...Array(conversations).keys()], 16, async (c) => {
      const conversationId = id("conv");
      const at = (k: number) => new Date(base + c * 60_000 + k * 1_000).toISOString();
      await store.saveConversation({ id: conversationId, userId, title: `Conversation ${c}`, titleIsCustom: false, mode: "general", createdAt: at(0), updatedAt: at(MESSAGES_PER_CONVERSATION) });
      for (let m = 0; m < MESSAGES_PER_CONVERSATION; m++) {
        const assistant = m % 2 === 1;
        const messageId = id("msg");
        await store.saveMessage({ id: messageId, conversationId, role: assistant ? "assistant" : "user", content: TEXT, origin: assistant ? "openai" : null, model: assistant ? "fake-openai" : null, demo: assistant, status: "complete", compareGroupId: null, attachmentIds: [], createdAt: at(m) });
        if (assistant) await store.recordUsage({ userId, conversationId, messageId, provider: "openai", model: "fake-openai", demo: true, inputTokens: 400, outputTokens: 375, estimatedCostUsd: null, createdAt: at(m) });
      }
    });
    // Documents up to the ceiling and a full set of automations, each with failed runs (the notice
    // list then needs a run lookup per notice).
    const docs = Math.min(200, Math.ceil(conversations / 5));
    await pool([...Array(docs).keys()], 8, async (d) => {
      await store.addDocument({ id: id("doc"), userId, name: `doc-${d}.txt`, kind: "txt", mimeType: "text/plain", sizeBytes: 10_000, status: "ready", statusDetail: "Text extracted.", extractedText: TEXT.repeat(6), pageCount: null, createdAt: new Date(base + d).toISOString() }, 200);
    });
    const automations = Math.min(25, Math.ceil(conversations / 40));
    for (let a = 0; a < automations; a++) {
      const automation = { id: id("auto"), userId, name: `Brief ${a}`, prompt: "Write my brief.", mode: "general" as const, schedule: { kind: "daily" as const, time: "08:00" }, timeZone: "UTC", status: "active" as const, nextRunAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      await store.createAutomation(automation);
      for (let r = 0; r < 3; r++) {
        await store.enqueueRun(newRun(automation, "manual", new Date()));
        const run = (await store.claimQueuedRun(new Date().toISOString(), 60_000))!;
        await store.finishRun({ runId: run.id, status: "failed", content: "", errorCode: "unavailable", finishedAt: new Date().toISOString(), provider: null, model: null, demo: false, notification: { id: id("note"), userId, kind: "automation.failed", automationId: automation.id, runId: run.id, createdAt: new Date().toISOString(), readAt: null }, keep: 30, pushAt: null });
      }
    }
    const seedMs = Date.now() - seedStarted;

    const all = ["/v1/conversations", "/v1/documents", "/v1/usage", "/v1/notifications", "/v1/automations", "/v1/sync/conversations", "/v1/me/export"];
    // GROWTH_ENDPOINTS=/v1/me/export limits the run (e.g. with --max-old-space-size to prove a bound).
    const endpoints = process.env.GROWTH_ENDPOINTS ? process.env.GROWTH_ENDPOINTS.split(",") : all;
    const results: Record<string, unknown> = {};
    for (const url of endpoints) {
      const times: number[] = [];
      let bytes = 0;
      let heapMb = 0;
      let status = 0;
      let queries = 0;
      for (let i = 0; i < 3; i++) {
        global.gc?.();
        const heapBefore = process.memoryUsage().heapUsed;
        const counted = { n: 0 };
        const original = store.pool.query.bind(store.pool);
        store.pool.query = ((...args: Parameters<typeof original>) => {
          counted.n++;
          return original(...args);
        }) as typeof store.pool.query;
        let peak = heapBefore;
        const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage().heapUsed)), 5);
        const started = performance.now();
        const res = await fetchCounting(url, account.auth);
        times.push(performance.now() - started);
        clearInterval(sampler);
        store.pool.query = original as typeof store.pool.query;
        queries = counted.n;
        status = res.status;
        bytes = res.bytes;
        heapMb = Math.max(heapMb, (peak - heapBefore) / 1048576);
      }
      times.sort((a, b) => a - b);
      results[url] = { status, medianMs: Math.round(times[1]!), maxMs: Math.round(times[2]!), responseKb: Math.round(bytes / 1024), heapDeltaMb: Math.round(heapMb), poolQueries: queries };
    }
    report.push({ conversations, messages: conversations * MESSAGES_PER_CONVERSATION, usageRows: (conversations * MESSAGES_PER_CONVERSATION) / 2, documents: docs, automations, notifications: automations * 3, seedMs, endpoints: results });
    process.stderr.write(`size ${conversations} done\n`);
  }
} finally {
  await app.close();
  void context;
  await pg.dispose();
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
