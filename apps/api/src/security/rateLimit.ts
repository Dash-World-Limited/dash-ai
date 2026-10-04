import { createHash } from "node:crypto";
import { Redis } from "ioredis";
import { RateLimiter, type RateDecision } from "./rateLimiter.js";

export type { RateDecision } from "./rateLimiter.js";

/** Every limit the API enforces. Keys are hashed before they reach any shared store. */
export type RateLimitName = "api" | "auth" | "login" | "chat" | "sync" | "upload";

export interface RateLimitRule {
  /** Requests allowed per window; the bucket refills evenly over the window. */
  capacity: number;
  windowMs: number;
}

/**
 * Where token buckets live. `MemoryRateLimitStore` is per process (one instance, tests);
 * `RedisRateLimitStore` is shared by every API instance using the same Redis.
 */
export interface RateLimitStore {
  readonly kind: "memory" | "redis";
  consume(name: RateLimitName, rule: RateLimitRule, key: string): Promise<RateDecision>;
  /** True when the store can currently enforce shared limits (always true for memory). */
  healthy(): Promise<boolean>;
  close(): Promise<void>;
}

export class MemoryRateLimitStore implements RateLimitStore {
  readonly kind = "memory" as const;
  private readonly limiters = new Map<string, RateLimiter>();

  constructor(private readonly now: () => number = Date.now) {}

  async consume(name: RateLimitName, rule: RateLimitRule, key: string): Promise<RateDecision> {
    const id = `${name}:${rule.capacity}:${rule.windowMs}`;
    let limiter = this.limiters.get(id);
    if (!limiter) {
      limiter = new RateLimiter(rule.capacity, rule.windowMs, this.now);
      this.limiters.set(id, limiter);
    }
    return limiter.consume(key);
  }

  async healthy(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    this.limiters.clear();
  }
}

/**
 * The same token bucket as RateLimiter, executed atomically inside Redis so concurrent requests on
 * different API instances can never both take the last token. Time comes from the caller (ARGV),
 * which keeps tests deterministic; a clock that runs behind another instance's never refills a
 * bucket backwards. A bucket left alone for a full window is full again, so it expires then:
 * expiry and refill give the same answer.
 */
const TOKEN_BUCKET_LUA = `
local capacity = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local rate = capacity / window
local state = redis.call('HMGET', KEYS[1], 't', 'u')
local tokens = tonumber(state[1])
local updated = tonumber(state[2])
if tokens == nil or updated == nil then
  tokens = capacity
  updated = now
end
local elapsed = now - updated
if elapsed < 0 then elapsed = 0 end
tokens = math.min(capacity, tokens + elapsed * rate)
if now > updated then updated = now end
local allowed = 0
local retry = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry = math.ceil((cost - tokens) / rate)
end
redis.call('HSET', KEYS[1], 't', string.format('%.6f', tokens), 'u', tostring(updated))
redis.call('PEXPIRE', KEYS[1], window)
return { allowed, retry, math.floor(tokens) }
`;

type BucketRedis = Redis & {
  dashTokenBucket(key: string, capacity: number, windowMs: number, now: number, cost: number): Promise<[number, number, number]>;
};

export interface RedisRateLimitOptions {
  url: string;
  /** Prefix for every key, so a Redis shared with other software stays tidy. */
  prefix?: string;
  now?: () => number;
  /** How long to use per-instance limits after a Redis error before trying Redis again. */
  degradedMs?: number;
  commandTimeoutMs?: number;
  /** Called (at most once per degraded period) when Redis fails. Never receives the URL. */
  onBackendError?: (errorName: string) => void;
}

/**
 * Shared limits across API instances. If Redis is unreachable or slow, requests are limited by a
 * per-instance memory store for `degradedMs` (default 5 s) and then Redis is tried again: an outage
 * neither removes limiting (fail open) nor blocks every request (fail closed), and never sticks.
 */
export class RedisRateLimitStore implements RateLimitStore {
  readonly kind = "redis" as const;
  private readonly redis: BucketRedis;
  private readonly fallback: MemoryRateLimitStore;
  private readonly now: () => number;
  private readonly prefix: string;
  private readonly degradedMs: number;
  private degradedUntil = 0;

  constructor(private readonly options: RedisRateLimitOptions) {
    this.now = options.now ?? Date.now;
    this.prefix = options.prefix ?? "dash:rl:";
    this.degradedMs = options.degradedMs ?? 5_000;
    this.fallback = new MemoryRateLimitStore(this.now);
    this.redis = new Redis(options.url, {
      // Fail fast instead of queueing while disconnected: the fallback takes over immediately.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      commandTimeout: options.commandTimeoutMs ?? 250,
      connectTimeout: 2_000,
      lazyConnect: false,
    }) as BucketRedis;
    this.redis.defineCommand("dashTokenBucket", { numberOfKeys: 1, lua: TOKEN_BUCKET_LUA });
    // Connection errors are reported through consume(); never print the URL (it can hold a password).
    this.redis.on("error", () => undefined);
  }

  /**
   * Waits (up to `timeoutMs`) for the connection to be ready. Called once at start-up; until Redis is
   * ready, requests use the per-instance fallback rather than waiting.
   */
  async ready(timeoutMs = 3_000): Promise<boolean> {
    if (this.redis.status === "ready") return true;
    return new Promise<boolean>((resolve) => {
      const done = (ok: boolean) => {
        clearTimeout(timer);
        this.redis.off("ready", onReady);
        resolve(ok);
      };
      const onReady = () => done(true);
      const timer = setTimeout(() => done(false), timeoutMs);
      this.redis.on("ready", onReady);
    });
  }

  private bucketKey(name: RateLimitName, key: string): string {
    // Hashed: client IPs, user ids and email addresses never reach Redis in the clear.
    return `${this.prefix}${name}:${createHash("sha256").update(key).digest("base64url").slice(0, 32)}`;
  }

  async consume(name: RateLimitName, rule: RateLimitRule, key: string): Promise<RateDecision> {
    const now = this.now();
    if (now < this.degradedUntil) return this.fallback.consume(name, rule, key);
    try {
      // Connecting or reconnecting: answer from the fallback instead of waiting for a connection.
      if (this.redis.status !== "ready") throw Object.assign(new Error("Redis is not connected"), { name: "NotReady" });
      const [allowed, retryAfterMs, remaining] = await this.redis.dashTokenBucket(this.bucketKey(name, key), rule.capacity, rule.windowMs, now, 1);
      return { allowed: allowed === 1, retryAfterMs: Number(retryAfterMs), remaining: Number(remaining) };
    } catch (err) {
      this.degradedUntil = now + this.degradedMs;
      this.options.onBackendError?.(err instanceof Error ? err.name : "unknown");
      return this.fallback.consume(name, rule, key);
    }
  }

  async healthy(): Promise<boolean> {
    try {
      return (await this.redis.ping()) === "PONG";
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.redis.disconnect();
    await this.fallback.close();
  }
}

export interface RateLimitHooks {
  onRejected?: (name: RateLimitName) => void;
}

/** The limits themselves (from configuration) applied to whichever store is configured. */
export class RateLimitService {
  constructor(
    readonly store: RateLimitStore,
    private readonly rules: Readonly<Record<RateLimitName, RateLimitRule>>,
    private readonly hooks: RateLimitHooks = {},
  ) {}

  async consume(name: RateLimitName, key: string): Promise<RateDecision> {
    const decision = await this.store.consume(name, this.rules[name], key);
    if (!decision.allowed) this.hooks.onRejected?.(name);
    return decision;
  }

  rule(name: RateLimitName): RateLimitRule {
    return this.rules[name];
  }
}
