/**
 * Load, spike and soak scenarios against the local multi-instance harness (real PostgreSQL, real
 * Redis, several API processes behind the round-robin load balancer, fake providers only: no paid
 * inference). Prints one JSON report.
 *
 *   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/dash_test npx tsx test/load/scenarios.ts [names...]
 *
 * Names: steady spike soak abusive many-streams uploads slow-provider (default: all). SOAK_MS sets the
 * soak length (default 120000). INSTANCES sets the instance count (default 3).
 *
 * These are laptop numbers for one shared machine (the load generator, every API process,
 * PostgreSQL and Redis compete for the same CPUs). They show behaviour under pressure (bounded
 * rejections, no leaks, no hangs) and relative costs; they are not a capacity claim for any
 * deployment.
 */
import { readFileSync } from "node:fs";
import { Redis } from "ioredis";
import { decodeStream, type StreamEvent } from "@dash-ai/contracts";
import { FAKE_TRIGGERS } from "../../src/providers/fake.js";
import { Cluster, chatPayload, metricValue, signUp, type Account } from "../cluster/cluster.js";
import { multipartBody, smallPdf } from "../cluster/documents.js";

const INSTANCES = Number(process.env.INSTANCES ?? 3);
const SOAK_MS = Number(process.env.SOAK_MS ?? 120_000);
const wanted = process.argv.slice(2);
const run = (name: string) => wanted.length === 0 || wanted.includes(name);

interface Outcome {
  status: number;
  ttfbMs: number;
  totalMs: number;
  final: string;
  broken: boolean;
}

/** One chat request through the load balancer: time to first text and to the end of the stream. */
async function chat(base: string, account: Account, content: string): Promise<Outcome> {
  const started = performance.now();
  let res: Response;
  try {
    res = await fetch(`${base}/v1/chat/stream`, {
      method: "POST",
      headers: { ...account.auth, "content-type": "application/json" },
      body: JSON.stringify(chatPayload(content)),
    });
  } catch {
    return { status: 0, ttfbMs: 0, totalMs: performance.now() - started, final: "network", broken: true };
  }
  if (res.status !== 200) {
    await res.arrayBuffer().catch(() => undefined);
    return { status: res.status, ttfbMs: 0, totalMs: performance.now() - started, final: `http_${res.status}`, broken: false };
  }
  let ttfb = 0;
  let final = "none";
  let broken = false;
  let buffer = "";
  const decoder = new TextDecoder();
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      const cut = buffer.lastIndexOf("\n\n");
      if (cut < 0) continue;
      const events: StreamEvent[] = decodeStream(buffer.slice(0, cut + 2));
      buffer = buffer.slice(cut + 2);
      for (const e of events) {
        if (e.event === "message.delta" && ttfb === 0) ttfb = performance.now() - started;
        if (e.event === "message.end") final = "complete";
        if (e.event === "message.error") final = `error:${(e.data as { error: { code: string } }).error.code}`;
      }
    }
  } catch {
    broken = true;
  }
  return { status: 200, ttfbMs: ttfb, totalMs: performance.now() - started, final, broken };
}

const pct = (values: number[], p: number) => {
  const s = [...values].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0);
};

function summarise(outcomes: Outcome[], wallMs: number) {
  const ok = outcomes.filter((o) => o.final === "complete");
  const byFinal: Record<string, number> = {};
  for (const o of outcomes) byFinal[o.final] = (byFinal[o.final] ?? 0) + 1;
  return {
    requests: outcomes.length,
    completed: ok.length,
    outcomes: byFinal,
    brokenConnections: outcomes.filter((o) => o.broken).length,
    errorRate: Number(((outcomes.length - ok.length) / Math.max(1, outcomes.length)).toFixed(3)),
    throughputPerSecond: Number((ok.length / (wallMs / 1000)).toFixed(1)),
    ttfbMs: ok.length ? { p50: pct(ok.map((o) => o.ttfbMs), 50), p95: pct(ok.map((o) => o.ttfbMs), 95), p99: pct(ok.map((o) => o.ttfbMs), 99) } : null,
    totalMs: ok.length ? { p50: pct(ok.map((o) => o.totalMs), 50), p95: pct(ok.map((o) => o.totalMs), 95), p99: pct(ok.map((o) => o.totalMs), 99) } : null,
  };
}

/** RSS (MB) and CPU seconds of an API process, from /proc. */
function proc(pid: number | undefined): { rssMb: number; cpuS: number } {
  if (!pid) return { rssMb: 0, cpuS: 0 };
  try {
    const rss = /VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1];
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ");
    return { rssMb: Math.round(Number(rss) / 1024), cpuS: (Number(stat[11]) + Number(stat[12])) / 100 };
  } catch {
    return { rssMb: 0, cpuS: 0 };
  }
}

async function snapshot(cluster: Cluster) {
  const nodes = [];
  for (const n of cluster.nodes) {
    const m = await cluster.metrics(n);
    nodes.push({
      node: n.name,
      ...proc(n.pid),
      activeStreams: metricValue(m, "dash_active_streams"),
      eventLoopP99Ms: Math.round(metricValue(m, "dash_event_loop_delay_seconds", { stat: "p99" }) * 1000),
      eventLoopMaxMs: Math.round(metricValue(m, "dash_event_loop_delay_seconds", { stat: "max" }) * 1000),
      poolWaiting: metricValue(m, "dash_database_pool_connections", { state: "waiting" }),
      poolTotal: metricValue(m, "dash_database_pool_connections", { state: "total" }),
      streamRejections: {
        tooMany: metricValue(m, "dash_stream_admissions_total", { outcome: "full" }),
        unavailable: metricValue(m, "dash_stream_admissions_total", { outcome: "unavailable" }),
      },
      busyRejections: metricValue(m, "dash_busy_rejections_total"),
      databaseErrors: metricValue(m, "dash_database_errors_total"),
      redisErrors: metricValue(m, "dash_stream_control_errors_total") + metricValue(m, "dash_rate_limit_backend_errors_total"),
      extraction: { active: metricValue(m, "dash_document_extraction_active"), waiting: metricValue(m, "dash_document_extraction_waiting"), rejected: metricValue(m, "dash_document_extraction_rejections_total") },
    });
  }
  return nodes;
}

/** Stream slots left in Redis after a scenario (must be 0: none leaked). */
async function leakedSlots(cluster: Cluster): Promise<number> {
  const redis = new Redis(cluster.directRedisUrl!, { lazyConnect: true, maxRetriesPerRequest: 1 });
  await redis.connect();
  let total = 0;
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", `${cluster.sharedPrefix}streams:u:*`, "COUNT", 500);
    cursor = next;
    for (const k of keys) total += await redis.zcard(k);
  } while (cursor !== "0");
  redis.disconnect();
  return total;
}

async function redisLatencyMs(cluster: Cluster): Promise<number> {
  const redis = new Redis(cluster.directRedisUrl!, { lazyConnect: true, maxRetriesPerRequest: 1 });
  await redis.connect();
  const samples: number[] = [];
  for (let i = 0; i < 20; i++) {
    const t = performance.now();
    await redis.ping();
    samples.push(performance.now() - t);
  }
  redis.disconnect();
  return Number(pct(samples, 95).toFixed(2));
}

/** Closed loop: every account sends one request after another until `ms` has passed. */
async function closedLoop(base: string, accounts: Account[], ms: number, content: string): Promise<Outcome[]> {
  const until = Date.now() + ms;
  const out: Outcome[] = [];
  await Promise.all(accounts.map(async (a) => {
    while (Date.now() < until) out.push(await chat(base, a, content));
  }));
  return out;
}

const cluster = await Cluster.start({
  instances: INSTANCES,
  env: {
    LOG_LEVEL: "warn",
    // About 1 s per answer (≈40 words × 25 ms): long enough to overlap, short enough to finish.
    FAKE_STREAM_DELAY_MS: "25",
    MAX_CONCURRENT_STREAMS_PER_USER: "3",
    RATE_LIMIT_API_PER_MINUTE: "10000",
    RATE_LIMIT_AUTH_PER_MINUTE: "10000",
    RATE_LIMIT_CHAT_PER_MINUTE: "10000",
    RATE_LIMIT_UPLOAD_PER_MINUTE: "10000",
    PROVIDER_IDLE_TIMEOUT_MS: "15000",
  },
});
const base = `http://127.0.0.1:${cluster.lb.port}`;
const report: Record<string, unknown> = { instances: INSTANCES, machine: { cpus: (await import("node:os")).cpus().length } };
const scenario = async (name: string, fn: () => Promise<Record<string, unknown>>) => {
  if (!run(name)) return;
  const cpuBefore = cluster.nodes.map((n) => proc(n.pid).cpuS);
  await snapshot(cluster); // resets the event-loop window
  const started = Date.now();
  const result = await fn();
  const wallMs = Date.now() - started;
  await new Promise((r) => setTimeout(r, 1_500)); // let releases land
  const nodes = await snapshot(cluster);
  report[name] = {
    wallMs,
    ...result,
    nodes: nodes.map((n, i) => ({ ...n, cpuPercent: Math.round(((n.cpuS - cpuBefore[i]!) / (wallMs / 1000)) * 100) })),
    redisPingP95Ms: await redisLatencyMs(cluster),
    leakedStreamSlots: await leakedSlots(cluster),
  };
  process.stderr.write(`${name} done\n`);
};

try {
  const accounts = await Promise.all(Array.from({ length: 200 }, (_, i) => signUp(base, `load${i}`)));

  await scenario("steady", async () => {
    const started = Date.now();
    const out = await closedLoop(base, accounts.slice(0, 40), 20_000, "hello steady");
    return { accounts: 40, ...summarise(out, Date.now() - started) };
  });

  await scenario("spike", async () => {
    const started = Date.now();
    const out = await Promise.all(accounts.map((a) => chat(base, a, "hello spike")));
    return { accounts: 200, simultaneous: 200, ...summarise(out, Date.now() - started) };
  });

  await scenario("abusive", async () => {
    // One account opens 60 streams at once while 20 normal accounts keep chatting.
    const started = Date.now();
    const [abuse, normal] = await Promise.all([
      Promise.all(Array.from({ length: 60 }, () => chat(base, accounts[0]!, "abuse"))),
      closedLoop(base, accounts.slice(1, 21), 8_000, "hello normal"),
    ]);
    return {
      abusiveAccount: { attempted: 60, admitted: abuse.filter((o) => o.status === 200).length, refused429: abuse.filter((o) => o.status === 429).length },
      normalAccounts: summarise(normal, Date.now() - started),
    };
  });

  await scenario("many-streams", async () => {
    // 150 accounts × 3 slow streams each, all open together (450 SSE streams across the instances).
    const started = Date.now();
    const out = await Promise.all(accounts.slice(0, 150).flatMap((a) => [0, 1, 2].map(() => chat(base, a, `long ${FAKE_TRIGGERS.slow}`))));
    return { accounts: 150, streams: 450, ...summarise(out, Date.now() - started) };
  });

  await scenario("slow-provider", async () => {
    // Slow first byte (2 s) on every answer, 100 accounts at once, plus a stalled stream per 10 accounts.
    const started = Date.now();
    const out = await Promise.all(accounts.slice(0, 100).map((a, i) => chat(base, a, i % 10 === 0 ? `x ${FAKE_TRIGGERS.stall}` : `x ${FAKE_TRIGGERS.ttfb}`)));
    return { accounts: 100, ...summarise(out, Date.now() - started) };
  });

  await scenario("uploads", async () => {
    // 60 accounts upload a small PDF at once, three rounds.
    const pdf = smallPdf("Quarterly planning notes. ".repeat(200));
    const started = Date.now();
    const statuses: Record<string, number> = {};
    const times: number[] = [];
    for (let round = 0; round < 3; round++) {
      await Promise.all(accounts.slice(0, 60).map(async (a) => {
        const { body, contentType } = multipartBody(`notes-${round}.pdf`, "application/pdf", pdf);
        const t = performance.now();
        const res = await fetch(`${base}/v1/documents`, { method: "POST", headers: { ...a.auth, "content-type": contentType }, body });
        await res.arrayBuffer();
        times.push(performance.now() - t);
        statuses[res.status] = (statuses[res.status] ?? 0) + 1;
      }));
    }
    return { uploads: 180, statuses, latencyMs: { p50: pct(times, 50), p95: pct(times, 95), p99: pct(times, 99) }, wall: Date.now() - started };
  });

  await scenario("soak", async () => {
    const rss: { atS: number; rssMb: number[] }[] = [];
    const started = Date.now();
    const sampler = setInterval(() => rss.push({ atS: Math.round((Date.now() - started) / 1000), rssMb: cluster.nodes.map((n) => proc(n.pid).rssMb) }), 10_000);
    const out = await closedLoop(base, accounts.slice(0, 30), SOAK_MS, "hello soak");
    clearInterval(sampler);
    return { accounts: 30, soakMs: SOAK_MS, ...summarise(out, Date.now() - started), rssMbOverTime: rss };
  });
} finally {
  await cluster.stop();
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
