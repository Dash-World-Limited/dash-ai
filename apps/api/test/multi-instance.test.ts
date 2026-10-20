import { Redis } from "ioredis";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FAKE_TRIGGERS } from "../src/providers/fake.js";
import { Cluster, cancelStream, eventually, finalEvent, metricValue, openStream, signUp } from "./cluster/cluster.js";
import { TEST_DATABASE_URL } from "./pgTestStore.js";
import { REDIS_AVAILABLE } from "./redisTestServer.js";

/**
 * Several real API processes (src/index.ts) on one real PostgreSQL database and one real Redis,
 * fake providers only, with traffic sent to chosen instances or through a round-robin load balancer
 * (ADR 0017). These are the multi-instance invariants: one account's stream limit holds across
 * instances; a cancel or an account deletion reaches the instance that runs the stream; a crashed
 * instance's slots free themselves; Redis trouble refuses new answers rather than multiplying the
 * limit; a SIGTERM drains; proxy headers written by clients are not believed.
 */

const ENABLED = Boolean(TEST_DATABASE_URL) && REDIS_AVAILABLE;
if (process.env.REQUIRE_DB_TESTS === "1" && !ENABLED) throw new Error("REQUIRE_DB_TESTS=1 but the multi-instance tests cannot run (PostgreSQL or Redis missing)");

const SLOW = `please answer ${FAKE_TRIGGERS.slow}`;
const HANG = `please answer ${FAKE_TRIGGERS.hang}`;
const finishReason = (events: Awaited<ReturnType<typeof openStream>>["events"]) =>
  events.filter((e) => e.event === "message.end").map((e) => (e.data as { finishReason: string }).finishReason);

/** Live stream slots across the whole cluster (straight from Redis, behind the fault proxy). */
async function liveSlots(cluster: Cluster): Promise<number> {
  const redis = new Redis(cluster.directRedisUrl!);
  try {
    const keys = await redis.keys(`${cluster.sharedPrefix}streams:u:*`);
    let n = 0;
    const now = Date.now();
    for (const k of keys) n += await redis.zcount(k, String(now), "+inf");
    return n;
  } finally {
    redis.disconnect();
  }
}

/** Every Redis key and value this cluster wrote, to prove no content reaches Redis. */
async function redisDump(cluster: Cluster): Promise<string> {
  const redis = new Redis(cluster.directRedisUrl!);
  try {
    const out: string[] = [];
    for (const k of await redis.keys(`${cluster.sharedPrefix}*`)) {
      const type = await redis.type(k);
      out.push(k);
      if (type === "zset") out.push(...(await redis.zrange(k, "0", "-1")));
      else if (type === "hash") out.push(JSON.stringify(await redis.hgetall(k)));
      else if (type === "string") out.push(String(await redis.get(k)));
    }
    return out.join("\n");
  } finally {
    redis.disconnect();
  }
}

describe.skipIf(!ENABLED)("several API instances: shared stream limit and cancellation", () => {
  let cluster: Cluster;
  beforeAll(async () => {
    cluster = await Cluster.start({
      instances: 3,
      env: { FAKE_STREAM_DELAY_MS: "30", MAX_CONCURRENT_STREAMS_PER_USER: "3", STREAM_SLOT_TTL_MS: "3000", RATE_LIMIT_CHAT_PER_MINUTE: "1000" },
    });
  }, 60_000);
  afterAll(async () => cluster?.stop());

  it("one account gets exactly its limit across every instance; another account is unaffected", async () => {
    const alice = await signUp(cluster.lb.url, "alice");
    const bob = await signUp(cluster.lb.url, "bob");
    // Nine simultaneous requests, three to each instance.
    const attempts = await Promise.all(cluster.nodes.flatMap((n) => [1, 2, 3].map(() => openStream(n.url, alice, SLOW))));
    const admitted = attempts.filter((s) => s.status === 200);
    const refused = attempts.filter((s) => s.status !== 200);
    expect(admitted).toHaveLength(3);
    expect(refused.map((s) => [s.status, s.error?.code])).toEqual(Array(6).fill([429, "too_many_streams"]));
    // A different account is not blocked by alice's streams.
    const bobs = await Promise.all(cluster.nodes.map((n) => openStream(n.url, bob, SLOW)));
    expect(bobs.map((s) => s.status)).toEqual([200, 200, 200]);
    expect(await liveSlots(cluster)).toBe(6);
    // Finishing (here: the client going away) frees the slot for a new stream anywhere.
    admitted[0]!.abort();
    await eventually(async () => (await liveSlots(cluster)) === 5);
    const again = await openStream(cluster.node(2).url, alice, SLOW);
    expect(again.status).toBe(200);
    for (const s of [...admitted, ...bobs, again]) s.abort();
    await eventually(async () => (await liveSlots(cluster)) === 0);
  });

  it("a cancel sent to another instance stops the stream; repeating it is harmless; another account cannot cancel it", async () => {
    const owner = await signUp(cluster.lb.url, "owner");
    const other = await signUp(cluster.lb.url, "other");
    const stream = await openStream(cluster.node(0).url, owner, SLOW);
    expect(stream.status).toBe(200);
    await eventually(() => stream.events.some((e) => e.event === "message.delta"));
    // Someone else's cancel: refused as unknown, and the stream goes on.
    expect(await cancelStream(cluster.node(1).url, other, stream.streamId!)).toEqual({ status: 200, cancelled: false });
    await new Promise((r) => setTimeout(r, 200));
    expect(finalEvent(stream.events)).toEqual([]);
    const started = Date.now();
    expect(await cancelStream(cluster.node(1).url, owner, stream.streamId!)).toEqual({ status: 200, cancelled: true });
    const { events } = await stream.done;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(finishReason(events)).toEqual(["cancelled"]);
    expect(events.filter((e) => e.event === "stream.end")).toHaveLength(1);
    // Again, on a third instance: harmless (the stream is gone).
    expect(await cancelStream(cluster.node(2).url, owner, stream.streamId!)).toEqual({ status: 200, cancelled: false });
    // The partial answer is kept once, as stopped.
    const detail = await (await fetch(`${cluster.node(2).url}/v1/conversations`, { headers: owner.auth })).json() as { conversations: { id: string }[] };
    const conv = await (await fetch(`${cluster.node(1).url}/v1/conversations/${detail.conversations[0]!.id}`, { headers: owner.auth })).json() as { messages: { role: string; status: string }[] };
    expect(conv.messages.filter((m) => m.role === "assistant").map((m) => m.status)).toEqual(["stopped"]);
  });

  it("deleting the account on one instance stops its streams on the others, and nothing of it survives", async () => {
    const victim = await signUp(cluster.lb.url, "victim");
    const streams = await Promise.all([openStream(cluster.node(0).url, victim, SLOW), openStream(cluster.node(1).url, victim, SLOW)]);
    expect(streams.map((s) => s.status)).toEqual([200, 200]);
    await eventually(() => streams.every((s) => s.events.some((e) => e.event === "message.delta")));
    const started = Date.now();
    const del = await fetch(`${cluster.node(2).url}/v1/me`, { method: "DELETE", headers: victim.auth });
    expect(del.status).toBe(204);
    const results = await Promise.all(streams.map((s) => s.done));
    expect(Date.now() - started).toBeLessThan(3_000);
    for (const r of results) expect(r.events.filter((e) => e.event === "message.end" && (e.data as { finishReason: string }).finishReason === "stop")).toEqual([]);
    const db = new pg.Client({ connectionString: cluster.databaseUrl });
    await db.connect();
    try {
      for (const table of ["users", "conversations", "sessions", "usage_records"]) {
        const column = table === "users" ? "id" : "user_id";
        const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${column} = $1`, [victim.userId]);
        expect(rows[0].n, table).toBe(0);
      }
    } finally {
      await db.end();
    }
    expect(await liveSlots(cluster)).toBe(0);
  });

  it("a cancel and a deletion work through the load balancer too (whichever instance they land on)", async () => {
    const user = await signUp(cluster.lb.url, "lb");
    const streams = await Promise.all([1, 2, 3].map(() => openStream(cluster.lb.url, user, SLOW)));
    expect(new Set(streams.map((s) => s.node)).size).toBeGreaterThan(1);
    for (const s of streams) expect((await cancelStream(cluster.lb.url, user, s.streamId!)).cancelled).toBe(true);
    for (const s of streams) expect(finishReason((await s.done).events)).toEqual(["cancelled"]);
  });

  it("Redis keeps only hashed account keys and random stream ids: no prompt, email or token", async () => {
    const user = await signUp(cluster.lb.url, "privacy");
    const s = await openStream(cluster.node(0).url, user, `${SLOW} secret-prompt-marker`);
    await eventually(() => s.events.some((e) => e.event === "message.delta"));
    await cancelStream(cluster.node(1).url, user, s.streamId!);
    await s.done;
    const dump = await redisDump(cluster);
    for (const secret of ["secret-prompt-marker", user.email, user.token, user.userId]) expect(dump).not.toContain(secret);
  });
});

describe.skipIf(!ENABLED)("several API instances: failures", () => {
  it("an outage longer than the slot TTL: streams admitted meanwhile keep their slots; the old streams cannot come back past the limit and are stopped and saved", async () => {
    const env = { FAKE_STREAM_DELAY_MS: "20", MAX_CONCURRENT_STREAMS_PER_USER: "3", STREAM_SLOT_TTL_MS: "2000", PROVIDER_IDLE_TIMEOUT_MS: "120000" };
    // Instance A reaches Redis through the fault proxy; instance B directly, so only A is cut off.
    const cluster = await Cluster.start({ instances: 1, env });
    try {
      const b = await cluster.addNode({ REDIS_URL: cluster.directRedisUrl! });
      const user = await signUp(cluster.node(0).url, "lease");
      const oldConversations = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
      const old = await Promise.all(oldConversations.map((id) => openStream(cluster.node(0).url, user, HANG, id)));
      expect(old.map((s) => s.status)).toEqual([200, 200, 200]);

      cluster.redisProxy!.down();
      // A cannot refresh: by Redis's clock its three slots expire.
      await eventually(async () => (await liveSlots(cluster)) === 0, 10_000, 100);
      const fresh = await Promise.all([0, 1, 2].map(() => openStream(b.url, user, HANG)));
      expect(fresh.map((s) => s.status)).toEqual([200, 200, 200]);
      expect((await openStream(b.url, user, HANG)).status).toBe(429);

      cluster.redisProxy!.up();
      // A's heartbeat finds its slots gone and the account full: its streams stop, none is re-added.
      let maxSeen = 0;
      await eventually(async () => {
        maxSeen = Math.max(maxSeen, await liveSlots(cluster));
        return (await Promise.all(old.map((s) => Promise.race([s.done.then(() => true), new Promise((r) => setTimeout(() => r(false), 10))])))).every(Boolean);
      }, 15_000, 100);
      expect(maxSeen).toBeLessThanOrEqual(3);
      for (const s of old) expect(finishReason((await s.done).events)).toEqual(["cancelled"]);
      expect(await liveSlots(cluster)).toBe(3);
      for (const id of oldConversations) {
        const conv = (await (await fetch(`${b.url}/v1/conversations/${id}`, { headers: user.auth })).json()) as { messages: { role: string; status: string }[] };
        expect(conv.messages.find((m) => m.role === "assistant")?.status).toBe("stopped");
      }
      const metrics = await cluster.metrics(cluster.node(0));
      expect(metricValue(metrics, "dash_stream_stops_total", { source: "lease_lost" })).toBe(3);
      expect(metricValue(metrics, "dash_active_streams")).toBe(0);
      // The streams admitted meanwhile are untouched.
      expect(fresh.every((s) => !s.events.some((e) => e.event === "message.end"))).toBe(true);
      for (const s of fresh) await cancelStream(b.url, user, s.streamId!);
      await eventually(async () => (await liveSlots(cluster)) === 0, 10_000, 100);
    } finally {
      await cluster.stop();
    }
  }, 90_000);

  it("an instance that dies (SIGKILL) frees its slots after STREAM_SLOT_TTL_MS, never before", async () => {
    const cluster = await Cluster.start({ instances: 2, env: { FAKE_STREAM_DELAY_MS: "30", MAX_CONCURRENT_STREAMS_PER_USER: "2", STREAM_SLOT_TTL_MS: "3000" } });
    try {
      const user = await signUp(cluster.node(1).url, "crash");
      const held = await Promise.all([openStream(cluster.node(0).url, user, HANG), openStream(cluster.node(0).url, user, HANG)]);
      expect(held.map((s) => s.status)).toEqual([200, 200]);
      await cluster.node(0).kill();
      const killedAt = Date.now();
      // The dead instance's slots still count: the limit is not exceeded while they might be alive.
      expect((await openStream(cluster.node(1).url, user, SLOW)).status).toBe(429);
      let admitted: Awaited<ReturnType<typeof openStream>> | undefined;
      await eventually(async () => {
        const s = await openStream(cluster.node(1).url, user, SLOW);
        if (s.status === 200) admitted = s;
        return s.status === 200;
      }, 10_000, 200);
      const freedAfter = Date.now() - killedAt;
      expect(freedAfter).toBeGreaterThanOrEqual(2_000);
      expect(freedAfter).toBeLessThan(6_000);
      admitted?.abort();
      for (const s of held) s.abort();
    } finally {
      await cluster.stop();
    }
  }, 60_000);

  it("Redis down: new answers are refused (neutral, retryable), streams already running finish, and service resumes when Redis returns", async () => {
    const cluster = await Cluster.start({ instances: 2, env: { FAKE_STREAM_DELAY_MS: "20", MAX_CONCURRENT_STREAMS_PER_USER: "3", STREAM_SLOT_TTL_MS: "3000" } });
    try {
      const user = await signUp(cluster.node(0).url, "redis");
      const running = await openStream(cluster.node(0).url, user, SLOW);
      expect(running.status).toBe(200);
      cluster.redisProxy!.down();
      // Fail closed: never "unlimited per instance".
      const refused = await Promise.all(cluster.nodes.map((n) => openStream(n.url, user, SLOW)));
      for (const r of refused) {
        expect(r.status).toBe(503);
        expect(r.error).toEqual({ code: "rate_limited", message: "DASH AI is busy right now. Please try again in a moment.", retryable: true });
      }
      // A cancel for a stream on another instance cannot be delivered: busy, not a false "cancelled".
      expect((await cancelStream(cluster.node(1).url, user, running.streamId!)).status).toBe(503);
      // The same cancel on the stream's own instance still works locally.
      expect((await cancelStream(cluster.node(0).url, user, running.streamId!)).cancelled).toBe(true);
      expect(finishReason((await running.done).events)).toEqual(["cancelled"]);
      // Readiness: degraded but still serving (every instance is equally affected).
      const ready = await fetch(`${cluster.node(1).url}/ready`);
      expect(ready.status).toBe(200);
      expect(await ready.json()).toMatchObject({ status: "degraded", checks: { streams: "down" } });
      const metrics = await cluster.metrics(cluster.node(0));
      expect(metricValue(metrics, "dash_stream_admissions_total", { outcome: "unavailable" })).toBeGreaterThanOrEqual(1);
      expect(metricValue(metrics, "dash_busy_rejections_total", { reason: "stream_control" })).toBeGreaterThanOrEqual(1);
      cluster.redisProxy!.up();
      await eventually(async () => (await openStream(cluster.node(1).url, user, "hello")).status === 200, 15_000, 250);
      // Slow Redis (each round trip > the 1 s command timeout): refused, not queued.
      cluster.redisProxy!.slow(1_500);
      const slowStart = Date.now();
      const slow = await openStream(cluster.node(0).url, user, "hello");
      expect(slow.status).toBe(503);
      expect(Date.now() - slowStart).toBeLessThan(4_000);
      cluster.redisProxy!.up();
    } finally {
      await cluster.stop();
    }
  }, 90_000);

  it("SIGTERM drains: not ready, new answers refused, a running answer finishes normally, then the process exits", async () => {
    const cluster = await Cluster.start({ instances: 2, env: { FAKE_STREAM_DELAY_MS: "15", SHUTDOWN_DRAIN_MS: "25000" } });
    try {
      const user = await signUp(cluster.node(0).url, "drain");
      const stream = await openStream(cluster.node(0).url, user, SLOW);
      await eventually(() => stream.events.some((e) => e.event === "message.delta"));
      const exit = cluster.node(0).terminate();
      await eventually(async () => (await fetch(`${cluster.node(0).url}/ready`).catch(() => undefined))?.status === 503, 3_000);
      const refused = await openStream(cluster.node(0).url, user, "hello");
      expect(refused.status).toBe(503);
      // Other instances keep serving.
      expect((await openStream(cluster.node(1).url, user, "hello")).status).toBe(200);
      const { events, broken } = await stream.done;
      expect(broken).toBe(false);
      expect(finishReason(events)).toEqual(["stop"]);
      expect(await exit).toBe(0);
    } finally {
      await cluster.stop();
    }
  }, 60_000);

  it("SIGTERM with a stalled answer: stopped cleanly at the drain deadline (saved as stopped), and the process exits", async () => {
    const cluster = await Cluster.start({ instances: 1, env: { SHUTDOWN_DRAIN_MS: "2000" } });
    try {
      const user = await signUp(cluster.node(0).url, "stall");
      const stream = await openStream(cluster.node(0).url, user, HANG);
      await eventually(() => stream.events.some((e) => e.event === "stream.start"));
      const started = Date.now();
      expect(await cluster.node(0).terminate()).toBe(0);
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(1_900);
      expect(elapsed).toBeLessThan(6_000);
      const { events } = await stream.done;
      expect(finishReason(events)).toEqual(["cancelled"]);
      expect(cluster.node(0).logs).toContain('"outcome":"deadline"');
      // Saved once, as stopped.
      const db = new pg.Client({ connectionString: cluster.databaseUrl });
      await db.connect();
      try {
        const { rows } = await db.query("SELECT status FROM messages WHERE role = 'assistant'");
        expect(rows.map((r: { status: string }) => r.status)).toEqual(["stopped"]);
      } finally {
        await db.end();
      }
    } finally {
      await cluster.stop();
    }
  }, 60_000);

  it("behind the load balancer, a client-written X-Forwarded-For cannot change the client IP the per-IP limit sees", async () => {
    const cluster = await Cluster.start({ instances: 2, env: { RATE_LIMIT_API_PER_MINUTE: "20" } });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 30; i++) {
        const res = await fetch(`${cluster.lb.url}/v1/assistant`, { headers: { "x-forwarded-for": `203.0.113.${i}` } });
        statuses.push(res.status);
      }
      // Shared through Redis across both instances, keyed by the address the load balancer saw.
      expect(statuses.filter((s) => s === 200).length).toBeLessThanOrEqual(21);
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(9);
    } finally {
      await cluster.stop();
    }
  }, 60_000);
});


