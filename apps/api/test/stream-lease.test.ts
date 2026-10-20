import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountKey, RedisStreamControl } from "../src/chat/streamControl.js";
import { StreamRegistry } from "../src/chat/streamRegistry.js";
import { LocalRedis, REDIS_AVAILABLE, TEST_REDIS_URL } from "./redisTestServer.js";

/**
 * Stream slot recovery after the shared state lost the slots (an outage longer than the slot TTL,
 * a Redis restart, a heartbeat that came too late). Deterministic: the slot TTL is long enough that
 * no timer heartbeat runs during a test; each test expires or deletes slots itself and calls
 * heartbeat() at chosen moments. "Instances" are separate StreamRegistry + RedisStreamControl pairs
 * on one real Redis, exactly as several API processes are.
 *
 * Invariant: with Redis available, an account never has more live slots, nor more running streams
 * under shared control, than its limit. A stream that lost its slot gets it back only within the
 * limit, never past a cancel or account-deletion marker; otherwise it is stopped ("lease_lost").
 */
if (process.env.REQUIRE_REDIS_TESTS === "1" && !REDIS_AVAILABLE) throw new Error("REQUIRE_REDIS_TESTS=1 but Redis is not available");

const LIMIT = 3;
const TTL = 300_000; // heartbeat timer every 75 s: never fires during a test
let local: LocalRedis | undefined;
let url = TEST_REDIS_URL ?? "";
let admin: Redis;
let run = 0;

beforeAll(async () => {
  if (!REDIS_AVAILABLE) return;
  if (!url) {
    local = await LocalRedis.start();
    url = local.url;
  }
  admin = new Redis(url);
});
afterAll(async () => {
  admin?.disconnect();
  await local?.stop();
});

interface Instance {
  registry: StreamRegistry;
  controllers: Map<string, AbortController>;
}

async function cluster(n: number) {
  const prefix = `dash:lease${++run}:${Date.now()}:`;
  const instances: Instance[] = [];
  for (let i = 0; i < n; i++) {
    const control = new RedisStreamControl({ url, prefix, slotTtlMs: TTL });
    await control.ready();
    instances.push({ registry: new StreamRegistry(control), controllers: new Map() });
  }
  const slotsKey = (userId: string) => `${prefix}streams:u:${accountKey(userId)}`;
  return {
    instances,
    slotsKey,
    /** Opens a stream on instance i; returns its id when admitted. */
    async open(i: number, userId: string, id: string): Promise<boolean> {
      const controller = new AbortController();
      const r = await instances[i]!.registry.acquire(id, userId, LIMIT, controller);
      if (r.ok) instances[i]!.controllers.set(id, controller);
      return r.ok;
    },
    /** Streams still running under shared control (admitted and not stopped), across instances. */
    running(): string[] {
      return instances.flatMap((inst) => [...inst.controllers].filter(([, c]) => !c.signal.aborted).map(([id]) => id));
    },
    stopReasons(): Record<string, unknown> {
      return Object.fromEntries(instances.flatMap((inst) => [...inst.controllers].filter(([, c]) => c.signal.aborted).map(([id, c]) => [id, c.signal.reason])));
    },
    /** What the route does when a stream ends: release its slot (stopped ones included). */
    async finishStopped(): Promise<void> {
      for (const inst of instances) for (const [id, c] of inst.controllers) if (c.signal.aborted) await inst.registry.release(id);
    },
    async releaseAll(): Promise<void> {
      for (const inst of instances) for (const id of inst.controllers.keys()) await inst.registry.release(id);
    },
    /** The account's slots expire (Redis TIME has passed their score): an outage longer than the TTL. */
    async expire(userId: string): Promise<void> {
      for (const id of await admin.zrange(slotsKey(userId), "0", "-1")) await admin.zadd(slotsKey(userId), "XX", "1", id);
    },
    async live(userId: string): Promise<number> {
      const t = await admin.time();
      const now = Number(t[0]) * 1000 + Math.floor(Number(t[1]) / 1000);
      return admin.zcount(slotsKey(userId), `(${now}`, "+inf");
    },
    async close(): Promise<void> {
      for (const inst of instances) await inst.registry.close();
    },
  };
}

describe.skipIf(!REDIS_AVAILABLE)("stream slot recovery never exceeds the limit", () => {
  it("slots expired during an outage: new streams admitted first, then the old ones' heartbeat cannot push the account past 3", async () => {
    const c = await cluster(2);
    try {
      for (const id of ["old-1", "old-2", "old-3"]) expect(await c.open(0, "u1", id)).toBe(true);
      await c.expire("u1");
      // Redis is back; instance B admits new streams before instance A's next heartbeat.
      for (const id of ["new-1", "new-2", "new-3"]) expect(await c.open(1, "u1", id)).toBe(true);
      expect(await c.open(1, "u1", "new-4")).toBe(false);
      await c.instances[0]!.registry.heartbeat();
      expect(await c.live("u1")).toBeLessThanOrEqual(LIMIT);
      expect(c.running().length).toBeLessThanOrEqual(LIMIT);
      expect(c.running().sort()).toEqual(["new-1", "new-2", "new-3"]);
      expect(c.stopReasons()).toEqual({ "old-1": "lease_lost", "old-2": "lease_lost", "old-3": "lease_lost" });
      // A repeated heartbeat changes nothing.
      await c.instances[0]!.registry.heartbeat();
      await c.instances[1]!.registry.heartbeat();
      expect(await c.live("u1")).toBe(3);
      await c.finishStopped();
      await c.releaseAll();
      expect(await admin.zcard(c.slotsKey("u1"))).toBe(0);
    } finally {
      await c.close();
    }
  });

  it("Redis lost its data (restart): running streams re-take their slots only up to the limit", async () => {
    const c = await cluster(2);
    try {
      for (const id of ["a1", "a2", "a3"]) expect(await c.open(0, "u2", id)).toBe(true);
      await admin.del(c.slotsKey("u2")); // state loss
      expect(await c.open(1, "u2", "b1")).toBe(true);
      await c.instances[0]!.registry.heartbeat();
      expect(await c.live("u2")).toBe(3);
      expect(c.running()).toHaveLength(3);
      expect(c.running()).toContain("b1");
      expect(Object.values(c.stopReasons())).toEqual(["lease_lost"]);
      await c.finishStopped();
      await c.releaseAll();
      expect(await admin.zcard(c.slotsKey("u2"))).toBe(0);
    } finally {
      await c.close();
    }
  });

  it("several instances recovering together never overshoot", async () => {
    const c = await cluster(3);
    try {
      // A holds 2, B holds 1 (the account is full); everything expires; C admits 2 new streams.
      expect(await c.open(0, "u3", "a1")).toBe(true);
      expect(await c.open(0, "u3", "a2")).toBe(true);
      expect(await c.open(1, "u3", "b1")).toBe(true);
      await c.expire("u3");
      expect(await c.open(2, "u3", "c1")).toBe(true);
      expect(await c.open(2, "u3", "c2")).toBe(true);
      // A and B reconnect at the same moment, each several times.
      await Promise.all([0, 1, 0, 1].map((i) => c.instances[i]!.registry.heartbeat()));
      await Promise.all([c.instances[0]!.registry.heartbeat(), c.instances[1]!.registry.heartbeat()]);
      expect(await c.live("u3")).toBe(3);
      expect(c.running()).toHaveLength(3);
      expect(c.running()).toEqual(expect.arrayContaining(["c1", "c2"]));
      expect(Object.values(c.stopReasons())).toEqual(["lease_lost", "lease_lost"]);
      await c.finishStopped();
      await c.releaseAll();
      expect(await admin.zcard(c.slotsKey("u3"))).toBe(0);
    } finally {
      await c.close();
    }
  });

  it("a cancel marker or an account-deletion marker still wins over re-taking a lost slot", async () => {
    const c = await cluster(2);
    try {
      for (const id of ["k1", "k2"]) expect(await c.open(0, "u4", id)).toBe(true);
      // Cancel k1 from instance B (marker written), then the slots are lost.
      expect(await c.instances[1]!.registry.cancel("u4", "k1")).toBe(true);
      await admin.del(c.slotsKey("u4"));
      await c.instances[0]!.registry.heartbeat();
      expect(c.stopReasons()).toEqual({ k1: "cancelled" });
      expect(c.running()).toEqual(["k2"]);
      expect(await c.live("u4")).toBe(1);

      // The account is deleted elsewhere while its slots are lost: nothing comes back.
      expect(await c.open(0, "u5", "d1")).toBe(true);
      expect(await c.open(0, "u5", "d2")).toBe(true);
      await c.instances[1]!.registry.cancelAllForUser("u5");
      await admin.del(c.slotsKey("u5"));
      await c.instances[0]!.registry.heartbeat();
      expect(await admin.zcard(c.slotsKey("u5"))).toBe(0);
      expect(c.running()).toEqual(["k2"]);
      expect(await c.open(1, "u5", "d3")).toBe(false);
      await c.finishStopped();
      await c.releaseAll();
      expect(await admin.zcard(c.slotsKey("u4"))).toBe(0);
    } finally {
      await c.close();
    }
  });

  it("a live slot is only extended, and duplicate heartbeats and releases are harmless", async () => {
    const c = await cluster(1);
    try {
      for (const id of ["s1", "s2", "s3"]) expect(await c.open(0, "u6", id)).toBe(true);
      await Promise.all([c.instances[0]!.registry.heartbeat(), c.instances[0]!.registry.heartbeat()]);
      expect(await c.live("u6")).toBe(3);
      expect(c.running()).toHaveLength(3);
      await c.instances[0]!.registry.release("s1");
      await c.instances[0]!.registry.release("s1");
      await c.instances[0]!.registry.heartbeat();
      expect(await c.live("u6")).toBe(2);
      await c.releaseAll();
      await c.instances[0]!.registry.heartbeat();
      expect(await admin.zcard(c.slotsKey("u6"))).toBe(0);
    } finally {
      await c.close();
    }
  });
});
