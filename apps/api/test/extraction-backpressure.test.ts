import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { ExtractionGate, GateBusy } from "../src/documents/gate.js";
import { activeExtractionProcesses, ExtractionAborted, extractIsolated } from "../src/documents/isolate.js";
import type { RouteContext } from "../src/routes/context.js";
import { malformedPdf, slowPdf, smallPdf, upload } from "./cluster/documents.js";
import { makeApp, register, USING_POSTGRES } from "./helpers.js";
import { createTestPgStore } from "./pgTestStore.js";

/**
 * Document upload backpressure on one instance (gate.ts). Before: every upload's body was read into
 * memory and then waited for one of two extraction processes with no bound: 40 concurrent 9 MB slow
 * PDFs all waited (the last for 65 s) and the API's resident memory went from 180 to 656 MB.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const deferred = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe("extraction gate", () => {
  const options = { maxActive: 1, maxWaiting: 2, maxPerAccount: 2, maxWaitMs: 500 };

  it("bounds the uploads held at once and per account, and refuses at once instead of waiting", () => {
    const gate = new ExtractionGate(options);
    const a1 = gate.enter("a");
    gate.enter("a");
    expect(() => gate.enter("a")).toThrow(GateBusy);
    gate.enter("b");
    let err: unknown;
    try {
      gate.enter("c");
    } catch (e) {
      err = e;
    }
    expect((err as GateBusy).reason).toBe("saturated");
    a1.release();
    a1.release(); // idempotent
    expect(gate.state.held).toBe(2);
    gate.enter("c");
  });

  it("runs one at a time, hands slots over in order, gives up after maxWaitMs, and never leaks", async () => {
    const gate = new ExtractionGate(options);
    const first = deferred();
    const t1 = gate.enter("a");
    const t2 = gate.enter("b");
    const t3 = gate.enter("c");
    const order: string[] = [];
    const r1 = t1.run(async () => {
      order.push("1");
      await first.promise;
    });
    const r2 = t2.run(async () => void order.push("2"));
    const r3 = t3.run(async () => void order.push("3"));
    expect(gate.state).toEqual({ active: 1, waiting: 2, held: 3 });
    await expect(r2).rejects.toMatchObject({ reason: "wait_timeout" });
    await expect(r3).rejects.toMatchObject({ reason: "wait_timeout" });
    first.resolve();
    await r1;
    for (const t of [t1, t2, t3]) t.release();
    expect(order).toEqual(["1"]);
    expect(gate.state).toEqual({ active: 0, waiting: 0, held: 0 });
  });

  it("a waiting upload whose client disconnects leaves the queue at once; close() fails every waiter", async () => {
    const gate = new ExtractionGate({ ...options, maxWaitMs: 10_000 });
    const hold = deferred();
    const t1 = gate.enter("a");
    const running = t1.run(() => hold.promise);
    const t2 = gate.enter("b");
    const client = new AbortController();
    const waiting = t2.run(async () => "never", client.signal);
    client.abort();
    await expect(waiting).rejects.toBeInstanceOf(GateBusy);
    t2.release();
    expect(gate.state).toEqual({ active: 1, waiting: 0, held: 1 });
    const t3 = gate.enter("c");
    const queued = t3.run(async () => "never");
    gate.close();
    await expect(queued).rejects.toMatchObject({ reason: "closed" });
    expect(() => gate.enter("d")).toThrow(GateBusy);
    hold.resolve();
    await running;
    t1.release();
    t3.release();
    expect(gate.state).toEqual({ active: 0, waiting: 0, held: 0 });
  });

  it("a crash inside the slot frees it for the next upload", async () => {
    const gate = new ExtractionGate(options);
    const t1 = gate.enter("a");
    await expect(t1.run(async () => Promise.reject(new Error("parser crashed")))).rejects.toThrow("parser crashed");
    t1.release();
    const t2 = gate.enter("b");
    expect(await t2.run(async () => "ok")).toBe("ok");
    t2.release();
    expect(gate.state).toEqual({ active: 0, waiting: 0, held: 0 });
  });
});

describe("isolated extraction", () => {
  it("an external abort kills the process and rejects as aborted (not an unreadable-file verdict); a timeout is still a verdict", async () => {
    const controller = new AbortController();
    const running = extractIsolated("pdf", slowPdf(512 * 1024), 20_000, controller.signal);
    for (let i = 0; i < 40 && activeExtractionProcesses() === 0; i++) await sleep(25);
    expect(activeExtractionProcesses()).toBe(1);
    controller.abort();
    await expect(running).rejects.toBeInstanceOf(ExtractionAborted);
    expect(activeExtractionProcesses()).toBe(0);
    const already = new AbortController();
    already.abort();
    await expect(extractIsolated("pdf", smallPdf("x"), 20_000, already.signal)).rejects.toBeInstanceOf(ExtractionAborted);
    expect(await extractIsolated("pdf", slowPdf(512 * 1024), 300)).toMatchObject({ status: "unsupported", reason: "timeout" });
    expect(activeExtractionProcesses()).toBe(0);
  }, 30_000);
});

describe("uploads through the API under pressure", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    while (apps.length) await apps.pop()!.close();
  });

  async function start(env: Record<string, string>) {
    const { app, context } = await makeApp({
      env: { RATE_LIMIT_UPLOAD_PER_MINUTE: "1000", RATE_LIMIT_API_PER_MINUTE: "10000", RATE_LIMIT_AUTH_PER_MINUTE: "1000", ...env },
    });
    apps.push(app);
    const url = await app.listen({ port: 0, host: "127.0.0.1" });
    return { app, context: context as RouteContext, url };
  }

  const idle = async (context: RouteContext) => {
    for (let i = 0; i < 100 && (context.extraction.state.held > 0 || activeExtractionProcesses() > 0); i++) await sleep(50);
    expect(context.extraction.state).toEqual({ active: 0, waiting: 0, held: 0 });
    expect(activeExtractionProcesses()).toBe(0);
  };

  it("saturated: the overflow is refused at once with a neutral busy answer; the rest complete; nothing leaks", async () => {
    const { context, url } = await start({ DOCUMENT_EXTRACTION_CONCURRENCY: "1", DOCUMENT_EXTRACTION_QUEUE: "1", DOCUMENT_EXTRACTION_TIMEOUT_MS: "1500" });
    const users = await Promise.all(Array.from({ length: 6 }, () => register({ inject: (o: never) => fetchInject(url, o) } as never)));
    const file = slowPdf(2 * 1024 * 1024);
    const results = await Promise.all(users.map((u, i) => upload(url, u.auth, `f${i}.pdf`, "application/pdf", file)));
    const ok = results.filter((r) => r.status === 201);
    const busy = results.filter((r) => r.status === 503);
    expect(ok).toHaveLength(2);
    expect(busy).toHaveLength(4);
    for (const b of busy) {
      expect(b.body).toEqual({ error: { code: "rate_limited", message: "DASH AI is busy right now. Please try again in a moment.", retryable: true } });
      expect(b.ms).toBeLessThan(1_000);
    }
    expect(context.metrics.extractionRejections.get({ reason: "saturated" })).toBe(4);
    await idle(context);
  }, 30_000);

  it("one abusive account cannot take every place; other accounts still upload", async () => {
    const { context, url } = await start({ DOCUMENT_EXTRACTION_CONCURRENCY: "1", DOCUMENT_EXTRACTION_QUEUE: "3", DOCUMENT_UPLOADS_PER_ACCOUNT: "2", DOCUMENT_EXTRACTION_TIMEOUT_MS: "1500" });
    const inject = { inject: (o: never) => fetchInject(url, o) } as never;
    const abuser = await register(inject);
    const normal = await register(inject);
    const file = slowPdf(1024 * 1024);
    const abuse = Promise.all(Array.from({ length: 8 }, (_, i) => upload(url, abuser.auth, `a${i}.pdf`, "application/pdf", file)));
    await sleep(100);
    const mine = await upload(url, normal.auth, "mine.pdf", "application/pdf", smallPdf("normal account"));
    expect(mine.status).toBe(201);
    const statuses = (await abuse).map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(2);
    expect(statuses.filter((s) => s === 503)).toHaveLength(6);
    expect(context.metrics.extractionRejections.get({ reason: "account" })).toBe(6);
    // No cross-account exposure: each account sees only its own documents.
    const list = async (auth: Record<string, string>) => ((await (await fetch(`${url}/v1/documents`, { headers: auth })).json()) as { documents: { name: string }[] }).documents.map((d) => d.name);
    expect(await list(normal.auth)).toEqual(["mine.pdf"]);
    expect((await list(abuser.auth)).every((n) => n.startsWith("a"))).toBe(true);
    await idle(context);
  }, 30_000);

  it("a malformed-document storm and parser timeouts end cleanly, every place released", async () => {
    const { context, url } = await start({ DOCUMENT_EXTRACTION_CONCURRENCY: "2", DOCUMENT_EXTRACTION_QUEUE: "4", DOCUMENT_EXTRACTION_TIMEOUT_MS: "1000" });
    const users = await Promise.all(Array.from({ length: 5 }, () => register({ inject: (o: never) => fetchInject(url, o) } as never)));
    const storm = await Promise.all(
      users.flatMap((u, i) => [
        upload(url, u.auth, `bad${i}.pdf`, "application/pdf", malformedPdf()),
        upload(url, u.auth, `slow${i}.pdf`, "application/pdf", slowPdf(512 * 1024)),
      ]),
    );
    expect(storm.every((r) => r.status === 201 || r.status === 503)).toBe(true);
    for (const r of storm.filter((x) => x.status === 201)) expect(r.body).toMatchObject({ status: "unsupported" });
    await idle(context);
  }, 30_000);

  it("a client that disconnects while queued or while its file is parsed frees its place and its extraction process, and saves nothing", async () => {
    const { context, url } = await start({ DOCUMENT_EXTRACTION_CONCURRENCY: "1", DOCUMENT_EXTRACTION_QUEUE: "2", DOCUMENT_EXTRACTION_TIMEOUT_MS: "20000", DOCUMENTS_MAX_PER_ACCOUNT: "1" });
    const inject = { inject: (o: never) => fetchInject(url, o) } as never;
    const [a, b] = [await register(inject), await register(inject)];
    const file = slowPdf(512 * 1024);
    const parsing = new AbortController();
    const queued = new AbortController();
    const p1 = upload(url, a.auth, "a.pdf", "application/pdf", file, parsing.signal);
    await sleep(300);
    const p2 = upload(url, b.auth, "b.pdf", "application/pdf", file, queued.signal);
    for (let i = 0; i < 40 && context.extraction.state.waiting === 0; i++) await sleep(25);
    expect(context.extraction.state).toMatchObject({ active: 1, waiting: 1 });
    expect(activeExtractionProcesses()).toBe(1);
    queued.abort();
    parsing.abort();
    await Promise.all([p1, p2]);
    await idle(context);
    await sleep(200);
    // Neither abandoned upload may leave a document behind or use up the account's ceiling (1 here).
    expect(await context.store.listDocuments(a.user.id)).toEqual([]);
    expect(await context.store.listDocuments(b.user.id)).toEqual([]);
    const after = await upload(url, a.auth, "ok.pdf", "application/pdf", smallPdf("after the abort"));
    expect(after.status).toBe(201);
    expect((await context.store.listDocuments(a.user.id)).map((d) => d.name)).toEqual(["ok.pdf"]);
    expect((await upload(url, b.auth, "ok.pdf", "application/pdf", smallPdf("after the abort"))).status).toBe(201);
    expect(context.metrics.extractionRejections.get({ reason: "aborted" })).toBe(2);
    await idle(context);
  }, 30_000);

  it("shutdown refuses the queue and kills extraction processes, saving nothing; close() does not wait for the parser", async () => {
    const { app, context, url } = await start({ DOCUMENT_EXTRACTION_CONCURRENCY: "1", DOCUMENT_EXTRACTION_QUEUE: "2", DOCUMENT_EXTRACTION_TIMEOUT_MS: "60000" });
    const inject = { inject: (o: never) => fetchInject(url, o) } as never;
    const [a, b] = [await register(inject), await register(inject)];
    const file = slowPdf(512 * 1024);
    const p1 = upload(url, a.auth, "a.pdf", "application/pdf", file);
    await sleep(300);
    const p2 = upload(url, b.auth, "b.pdf", "application/pdf", file);
    for (let i = 0; i < 40 && context.extraction.state.waiting === 0; i++) await sleep(25);
    const started = Date.now();
    await app.close();
    apps.pop();
    expect(Date.now() - started).toBeLessThan(5_000);
    await Promise.all([p1, p2]);
    expect(activeExtractionProcesses()).toBe(0);
    expect(context.extraction.state).toEqual({ active: 0, waiting: 0, held: 0 });
    await sleep(200);
    // The upload stopped by shutdown is not saved (as an "unreadable" document or otherwise).
    if (!USING_POSTGRES) {
      expect(await context.store.listDocuments(a.user.id)).toEqual([]);
      expect(await context.store.listDocuments(b.user.id)).toEqual([]);
    }
  }, 30_000);

  it("the per-account document ceiling holds, also for simultaneous uploads", async () => {
    const { context, url } = await start({ DOCUMENTS_MAX_PER_ACCOUNT: "3", DOCUMENT_UPLOADS_PER_ACCOUNT: "10", DOCUMENT_EXTRACTION_QUEUE: "20" });
    const inject = { inject: (o: never) => fetchInject(url, o) } as never;
    const user = await register(inject);
    const other = await register(inject);
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => upload(url, user.auth, `n${i}.txt`, "text/plain", Buffer.from(`note ${i}`))));
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    const refused = results.filter((r) => r.status === 409);
    expect(refused).toHaveLength(3);
    expect(refused[0]!.body).toMatchObject({ error: { code: "conflict", message: "You can keep up to 3 documents. Delete some to upload more." } });
    expect((await context.store.listDocuments(user.user.id)).length).toBe(3);
    // Another account is not affected.
    expect((await upload(url, other.auth, "o.txt", "text/plain", Buffer.from("other"))).status).toBe(201);
    await idle(context);
  }, 30_000);

  it.runIf(USING_POSTGRES)("the ceiling holds across two instances on one database; refused uploads do not count; deleting frees a place", async () => {
    const pg = await createTestPgStore();
    try {
      const env = { DOCUMENTS_MAX_PER_ACCOUNT: "5", DOCUMENT_UPLOADS_PER_ACCOUNT: "10", DOCUMENT_EXTRACTION_QUEUE: "20", RATE_LIMIT_UPLOAD_PER_MINUTE: "1000", RATE_LIMIT_API_PER_MINUTE: "10000", RATE_LIMIT_AUTH_PER_MINUTE: "1000" };
      const nodes = await Promise.all([0, 1].map(async () => {
        const { app, context } = await makeApp({ env, store: pg.store });
        apps.push(app);
        return { context: context as RouteContext, url: await app.listen({ port: 0, host: "127.0.0.1" }) };
      }));
      const inject = { inject: (o: never) => fetchInject(nodes[0]!.url, o) } as never;
      const user = await register(inject);
      // Refused before anything is stored: wrong type and too large. Neither may count.
      expect((await upload(nodes[0]!.url, user.auth, "x.exe", "application/x-msdownload", Buffer.from("MZ"))).status).toBeGreaterThanOrEqual(400);
      expect((await upload(nodes[1]!.url, user.auth, "big.txt", "text/plain", Buffer.alloc(11 * 1024 * 1024, 97))).status).toBe(413);
      expect(await pg.store.listDocuments(user.user.id)).toHaveLength(0);
      // 10 simultaneous uploads, alternating instances, against a ceiling of 5.
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => upload(nodes[i % 2]!.url, user.auth, `n${i}.txt`, "text/plain", Buffer.from(`note ${i}`))));
      expect(results.filter((r) => r.status === 201)).toHaveLength(5);
      expect(results.filter((r) => r.status === 409)).toHaveLength(5);
      const docs = await pg.store.listDocuments(user.user.id);
      expect(docs).toHaveLength(5);
      // Deleting one (on the other instance) frees exactly one place.
      expect((await fetch(`${nodes[1]!.url}/v1/documents/${docs[0]!.id}`, { method: "DELETE", headers: user.auth })).status).toBe(204);
      const again = await Promise.all([0, 1].map((i) => upload(nodes[i]!.url, user.auth, `again${i}.txt`, "text/plain", Buffer.from("again"))));
      expect(again.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(await pg.store.listDocuments(user.user.id)).toHaveLength(5);
      for (const n of nodes) await idle(n.context);
    } finally {
      while (apps.length) await apps.pop()!.close();
      await pg.dispose();
    }
  }, 60_000);
});

/** register() takes something with inject(); this adapts it to a real listening server. */
async function fetchInject(url: string, options: { method: string; url: string; payload?: unknown; headers?: Record<string, string> }) {
  const res = await fetch(`${url}${options.url}`, {
    method: options.method,
    headers: { "content-type": "application/json", ...options.headers },
    body: options.payload === undefined ? undefined : JSON.stringify(options.payload),
  });
  const text = await res.text();
  return { statusCode: res.status, body: text, json: () => JSON.parse(text) as unknown };
}
