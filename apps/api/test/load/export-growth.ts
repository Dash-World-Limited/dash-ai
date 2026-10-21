/**
 * /v1/me/export memory on three account shapes that grow separately (real PostgreSQL, one API in
 * process, real HTTP with the body dropped as it arrives, so the heap measured is the server's):
 *
 *   conversations   many conversations, 2 short messages each
 *   one-large       one conversation with many messages of about 1,500 characters
 *   usage           a long usage history (rows inserted directly)
 *
 *   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/dash_test npx tsx --expose-gc test/load/export-growth.ts [shape[:size]...]
 *
 * With NODE_OPTIONS=--max-old-space-size=N it shows whether the export completes under a heap cap
 * smaller than the data it writes.
 *
 * For each shape and size: peak heap growth and RSS growth while the export ran (sampled every 5 ms),
 * pool queries, response size, and whether the whole response parses as DataExportResponse (checked
 * in a separate request, outside the measurement). Laptop numbers: they show whether memory follows
 * the account's size, not what a production instance can hold.
 */
import { randomBytes } from "node:crypto";
import { DataExportResponse } from "@dash-ai/contracts";
import { buildApp } from "../../src/app.js";
import { createTestPgStore } from "../pgTestStore.js";
import { register, testConfig } from "../helpers.js";

const SHAPES: Record<string, number[]> = { conversations: [2_000, 10_000], "one-large": [2_000, 10_000], usage: [20_000, 200_000] };
const chosen = process.argv.slice(2).map((a) => a.split(":")).filter(([shape]) => shape! in SHAPES);
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
const config = testConfig({ PROVIDER_DETAILS: "hidden", RATE_LIMIT_API_PER_MINUTE: "10000", RATE_LIMIT_SYNC_PER_MINUTE: "10000", RATE_LIMIT_AUTH_PER_MINUTE: "1000" });
const { app } = await buildApp({ config, store });
await app.listen({ port: 0, host: "127.0.0.1" });
const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

async function seed(shape: string, size: number, userId: string): Promise<void> {
  const start = Date.UTC(2025, 0, 1);
  const at = (n: number) => new Date(start + n * 1_000).toISOString();
  const message = (conversationId: string, n: number, content: string) => ({
    id: id("msg"), conversationId, role: n % 2 ? ("assistant" as const) : ("user" as const), content, origin: null, model: null,
    demo: false, status: "complete" as const, compareGroupId: null, attachmentIds: [], createdAt: at(n),
  });
  if (shape === "conversations") {
    await pool([...Array(size).keys()], 16, async (c) => {
      const conversationId = id("conv");
      await store.saveConversation({ id: conversationId, userId, title: `Conversation ${c}`, titleIsCustom: false, mode: "general", createdAt: at(c), updatedAt: at(c) });
      for (let m = 0; m < 2; m++) await store.saveMessage(message(conversationId, c * 2 + m, "A short message."));
    });
  } else if (shape === "one-large") {
    const conversationId = id("conv");
    await store.saveConversation({ id: conversationId, userId, title: "Long thread", titleIsCustom: false, mode: "general", createdAt: at(0), updatedAt: at(0) });
    await pool([...Array(size).keys()], 16, (m) => store.saveMessage(message(conversationId, m, TEXT)));
  } else {
    await store.pool.query(
      `INSERT INTO usage_records (user_id, conversation_id, message_id, provider, model, demo, input_tokens, output_tokens, created_at)
       SELECT $1, 'conv-usage', 'message-' || lpad(g::text, 8, '0'), 'openai', 'fake-openai', true, 400, 375, now() - (g || ' seconds')::interval
       FROM generate_series(1, $2::int) g`,
      [userId, size],
    );
  }
}

async function measure(auth: Record<string, string>) {
  global.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const rssBefore = process.memoryUsage().rss;
  let heapPeak = heapBefore;
  let rssPeak = rssBefore;
  const sampler = setInterval(() => {
    const m = process.memoryUsage();
    heapPeak = Math.max(heapPeak, m.heapUsed);
    rssPeak = Math.max(rssPeak, m.rss);
  }, 5);
  let queries = 0;
  const original = store.pool.query.bind(store.pool);
  store.pool.query = ((...args: Parameters<typeof original>) => {
    queries++;
    return original(...args);
  }) as typeof store.pool.query;
  const started = performance.now();
  const res = await fetch(`${base}/v1/me/export`, { headers: auth });
  let bytes = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) bytes += chunk.length;
  const ms = Math.round(performance.now() - started);
  clearInterval(sampler);
  store.pool.query = original as typeof store.pool.query;
  return { status: res.status, ms, responseMb: +(bytes / 1048576).toFixed(1), heapDeltaMb: Math.round((heapPeak - heapBefore) / 1048576), rssDeltaMb: Math.round((rssPeak - rssBefore) / 1048576), queries };
}

const report: Record<string, unknown>[] = [];
try {
  const plan = chosen.length ? chosen.map(([shape, size]) => [shape!, size ? [Number(size)] : SHAPES[shape!]!] as const) : Object.entries(SHAPES);
  for (const [shape, sizes] of plan) {
    for (const size of sizes) {
      const account = await register(app, `export-${shape}-${size}-${Date.now()}@example.com`);
      const seedStarted = Date.now();
      await seed(shape, size, account.user.id);
      const seedMs = Date.now() - seedStarted;
      const runs = [await measure(account.auth), await measure(account.auth)];
      const run = runs.reduce((a, b) => (b.heapDeltaMb > a.heapDeltaMb ? b : a));
      // Under a heap cap the check would itself hold the whole document: EXPORT_VALIDATE=0 skips it.
      if (process.env.EXPORT_VALIDATE === "0") {
        report.push({ shape, size, seedMs, valid: "not checked", run });
      } else {
        const res = await fetch(`${base}/v1/me/export`, { headers: account.auth });
        const parsed = DataExportResponse.safeParse(JSON.parse(await res.text()));
        const counts = parsed.success
          ? { conversations: parsed.data.conversations.length, messages: parsed.data.conversations.reduce((n, c) => n + c.messages.length, 0), usage: parsed.data.usage.length }
          : null;
        report.push({ shape, size, seedMs, valid: parsed.success, counts, run });
      }
      process.stderr.write(`${shape} ${size} done\n`);
    }
  }
} finally {
  await app.close();
  await pg.dispose();
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
