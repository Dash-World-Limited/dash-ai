import { Redis } from "ioredis";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { Metrics } from "../src/observability/metrics.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import { MemoryRateLimitStore, RedisRateLimitStore, type RateLimitStore } from "../src/security/rateLimit.js";
import { register, testConfig } from "./helpers.js";
import { LocalRedis, REDIS_AVAILABLE, REDIS_BINARY_AVAILABLE, TEST_REDIS_URL, freePort } from "./redisTestServer.js";

/**
 * Rate limiting across API instances. Redis tests use a real Redis (TEST_REDIS_URL in CI, or a
 * local redis-server); several "instances" are separate stores or whole apps sharing it.
 */

let local: LocalRedis | undefined;
let redisUrl = TEST_REDIS_URL ?? "";
let prefixCounter = 0;
const stores: RateLimitStore[] = [];
const apps: FastifyInstance[] = [];

beforeAll(async () => {
  if (!TEST_REDIS_URL && REDIS_BINARY_AVAILABLE) {
    local = await LocalRedis.start();
    redisUrl = local.url;
  }
});
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
  while (stores.length) await stores.pop()!.close();
});
afterAll(async () => {
  await local?.stop();
});

/** A unique key prefix per test, so tests sharing one Redis never see each other's buckets. */
const freshPrefix = () => `dash:test:${process.pid}:${++prefixCounter}:${Date.now()}:`;

/** Every backend error seen by stores made with `strictRedisStore`: a test that expects Redis must see none. */
let unexpectedFallbacks: string[] = [];
afterEach(() => {
  const seen = unexpectedFallbacks;
  unexpectedFallbacks = [];
  expect(seen, "a Redis test silently fell back to per-instance limits").toEqual([]);
});

function redisStore(options: { prefix: string; now?: () => number; url?: string; degradedMs?: number; onBackendError?: (e: string) => void }) {
  // A generous command timeout: the full test suite loads the CPU, and a slow command would
  // (correctly) fall back to local limits. Production keeps the 250 ms default.
  const store = new RedisRateLimitStore({ url: options.url ?? redisUrl, prefix: options.prefix, now: options.now, degradedMs: options.degradedMs, onBackendError: options.onBackendError, commandTimeoutMs: 2_000 });
  stores.push(store);
  return store;
}

/** A Redis store that must really use Redis: connected before use, and any fallback fails the test. */
async function strictRedisStore(options: { prefix: string; now?: () => number }) {
  const store = redisStore({ ...options, onBackendError: (e) => unexpectedFallbacks.push(e) });
  expect(await store.ready()).toBe(true);
  return store;
}

const rule = { capacity: 3, windowMs: 60_000 };

describe.each([
  ["memory", (now: () => number) => new MemoryRateLimitStore(now)],
  ...(REDIS_AVAILABLE ? [["redis", (now: () => number) => strictRedisStore({ prefix: freshPrefix(), now })] as const] : []),
] as const)("token bucket semantics (%s store)", (_kind, make) => {
  it("allows exactly the capacity, then refuses with a precise Retry-After", async () => {
    let now = 1_000_000;
    const store = await make(() => now);
    for (let i = 0; i < rule.capacity; i++) {
      expect(await store.consume("login", rule, "k")).toMatchObject({ allowed: true, remaining: rule.capacity - 1 - i });
    }
    const refused = await store.consume("login", rule, "k");
    expect(refused).toMatchObject({ allowed: false, remaining: 0 });
    // One token refills every windowMs / capacity = 20 s.
    expect(refused.retryAfterMs).toBe(20_000);
    now += 19_999;
    expect((await store.consume("login", rule, "k")).allowed).toBe(false);
    now += 1;
    expect((await store.consume("login", rule, "k")).allowed).toBe(true);
    expect((await store.consume("login", rule, "k")).allowed).toBe(false);
  });

  it("refills completely after one window, never beyond capacity", async () => {
    let now = 5_000_000;
    const store = await make(() => now);
    for (let i = 0; i < rule.capacity; i++) await store.consume("login", rule, "k");
    now += rule.windowMs * 10;
    const results = [];
    for (let i = 0; i < rule.capacity + 1; i++) results.push((await store.consume("login", rule, "k")).allowed);
    expect(results).toEqual([true, true, true, false]);
  });

  it("keeps keys and limits independent", async () => {
    const now = 9_000_000;
    const store = await make(() => now);
    for (let i = 0; i < rule.capacity; i++) await store.consume("login", rule, "a");
    expect((await store.consume("login", rule, "a")).allowed).toBe(false);
    expect((await store.consume("login", rule, "b")).allowed).toBe(true);
    expect((await store.consume("auth", rule, "a")).allowed).toBe(true);
  });
});

describe.skipIf(!REDIS_AVAILABLE)("shared limits across instances (Redis)", () => {
  it("two instances share one bucket: the capacity holds in total, not per instance", async () => {
    const prefix = freshPrefix();
    let now = 2_000_000;
    const a = await strictRedisStore({ prefix, now: () => now });
    const b = await strictRedisStore({ prefix, now: () => now });
    const results = [];
    for (let i = 0; i < 6; i++) results.push((await (i % 2 === 0 ? a : b).consume("login", rule, "user@example.com")).allowed);
    expect(results).toEqual([true, true, true, false, false, false]);
    now += 20_000;
    expect((await b.consume("login", rule, "user@example.com")).allowed).toBe(true);
    expect((await a.consume("login", rule, "user@example.com")).allowed).toBe(false);
  });

  it("is atomic under concurrency: 60 simultaneous requests on 3 instances get exactly the capacity", async () => {
    const prefix = freshPrefix();
    const now = 3_000_000;
    const instances = [await strictRedisStore({ prefix, now: () => now }), await strictRedisStore({ prefix, now: () => now }), await strictRedisStore({ prefix, now: () => now })];
    const capacity = { capacity: 10, windowMs: 60_000 };
    const decisions = await Promise.all(Array.from({ length: 60 }, (_, i) => instances[i % 3]!.consume("chat", capacity, "u1")));
    expect(decisions.filter((d) => d.allowed)).toHaveLength(10);
  });

  it("an instance whose clock runs behind never refills a bucket backwards", async () => {
    const prefix = freshPrefix();
    const ahead = await strictRedisStore({ prefix, now: () => 4_000_000 });
    const behind = await strictRedisStore({ prefix, now: () => 4_000_000 - 30_000 });
    for (let i = 0; i < rule.capacity; i++) await ahead.consume("login", rule, "k");
    expect((await behind.consume("login", rule, "k")).allowed).toBe(false);
    expect((await ahead.consume("login", rule, "k")).allowed).toBe(false);
  });

  it("buckets expire after one window and store no plaintext identifiers", async () => {
    const prefix = freshPrefix();
    const store = await strictRedisStore({ prefix, now: () => 6_000_000 });
    await store.consume("login", rule, "private.person@example.com");
    await store.consume("api", rule, "api:203.0.113.7");
    const inspect = new Redis(redisUrl);
    try {
      const keys = await inspect.keys(`${prefix}*`);
      expect(keys).toHaveLength(2);
      for (const key of keys) {
        expect(key).not.toMatch(/private|example|203\.0/);
        const ttl = await inspect.pttl(key);
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(rule.windowMs);
        expect(JSON.stringify(await inspect.hgetall(key))).not.toMatch(/private|203\.0/);
      }
    } finally {
      inspect.disconnect();
    }
  });

  it("whole API instances share sign-in limits per account and per IP", async () => {
    const prefix = freshPrefix();
    const sharedDatabase = new MemoryStore(); // both instances use one database, as in production
    const make = async () => {
      const { app } = await buildApp({
        store: sharedDatabase,
        config: testConfig({ RATE_LIMIT_LOGIN_PER_ACCOUNT: "3", RATE_LIMIT_AUTH_PER_MINUTE: "1000" }),
        rateLimitStore: await strictRedisStore({ prefix }),
      });
      await app.ready();
      apps.push(app);
      return app;
    };
    const [one, two] = [await make(), await make()];
    const account = await register(one);
    const attempt = (app: FastifyInstance) =>
      app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: account.user.email, password: "wrong password!" } });
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await attempt(i % 2 === 0 ? one : two)).statusCode);
    expect(statuses).toEqual([401, 401, 401, 429, 429]);
    const limited = await attempt(two);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    // Another account is unaffected.
    const other = await register(two);
    expect((await one.inject({ method: "POST", url: "/v1/auth/login", payload: { email: other.user.email, password: "correct horse battery" } })).statusCode).toBe(200);
  });
});

describe("when the shared backend fails", () => {
  it("falls back to per-instance limits (never unlimited, never a lockout) and reports the error once per period", async () => {
    let now = 7_000_000;
    const errors: string[] = [];
    // Nothing listens on this port: every Redis command fails immediately.
    const store = redisStore({ prefix: freshPrefix(), url: `redis://127.0.0.1:${await freePort()}`, now: () => now, degradedMs: 5_000, onBackendError: (e) => errors.push(e) });
    const results = [];
    for (let i = 0; i < 4; i++) results.push((await store.consume("login", rule, "k")).allowed);
    expect(results).toEqual([true, true, true, false]); // still limited, by the local fallback
    expect(errors).toHaveLength(1);
    now += 20_000; // past the degraded period: Redis is tried again, fails again, reported again
    expect((await store.consume("login", rule, "k")).allowed).toBe(true);
    expect(errors).toHaveLength(2);
    expect(await store.healthy()).toBe(false);
  });

  it.skipIf(!REDIS_BINARY_AVAILABLE || Boolean(TEST_REDIS_URL))("recovers shared limiting after a Redis outage", async () => {
    const redis = await LocalRedis.start();
    try {
      let now = 8_000_000;
      const errors: string[] = [];
      const prefix = freshPrefix();
      const a = redisStore({ prefix, url: redis.url, now: () => now, degradedMs: 1_000, onBackendError: (e) => errors.push(e) });
      const b = redisStore({ prefix, url: redis.url, now: () => now, degradedMs: 1_000, onBackendError: (e) => errors.push(`b:${e}`) });
      expect(await a.ready()).toBe(true);
      expect(await b.ready()).toBe(true);
      expect((await a.consume("login", rule, "k")).allowed).toBe(true);
      expect(errors).toEqual([]);
      await redis.stop();
      await new Promise((r) => setTimeout(r, 100)); // let both clients notice the closed connection
      // During the outage requests still get answers (from the fallback).
      expect((await a.consume("login", rule, "k")).allowed).toBe(true);
      expect(errors.length).toBeGreaterThanOrEqual(1);
      await redis.start();
      expect(await a.ready(10_000)).toBe(true);
      expect(await b.ready(10_000)).toBe(true);
      now += 1_001;
      // Shared again: the restarted Redis (no persistence) starts with full buckets, and both
      // instances draw from the same one.
      const failuresBefore = errors.length;
      const results = [];
      for (let i = 0; i < 4; i++) results.push((await (i % 2 === 0 ? a : b).consume("login", rule, "k")).allowed);
      expect(results).toEqual([true, true, true, false]);
      expect(errors.length).toBe(failuresBefore);
    } finally {
      await redis.stop();
    }
  }, 20_000);

  it("counts rejections in metrics without identifying the client", async () => {
    const metrics = new Metrics();
    const { app } = await buildApp({ config: testConfig({ RATE_LIMIT_LOGIN_PER_ACCOUNT: "1" }), metrics });
    await app.ready();
    apps.push(app);
    for (let i = 0; i < 3; i++) {
      await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: "someone.private@example.com", password: "x" } });
    }
    expect(metrics.rateLimitRejections.get({ limit: "login" })).toBe(2);
    expect(metrics.render()).not.toMatch(/someone|example\.com|127\.0\.0\.1/);
  });
});
