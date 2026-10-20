import { createHash } from "node:crypto";
import { Redis } from "ioredis";

/**
 * Shared state for chat streams across API instances (ADR 0017): the per-account concurrent-stream
 * slots and cross-instance cancellation, kept in the same Redis the shared rate limits use.
 *
 * Keys (prefix `dash:` by default; account ids are hashed, stream ids are random and carry nothing):
 * - `streams:u:<account hash>`  sorted set of the account's active stream ids, scored by expiry.
 *   An instance refreshes its own streams every heartbeat, so a crashed instance's slots expire on
 *   their own after STREAM_SLOT_TTL_MS. Expiry uses Redis's clock (TIME), never an instance's.
 * - `streams:c:<stream id>`     "cancel this stream" marker (short TTL).
 * - `streams:d:<account hash>`  "this account was deleted: stop its streams" marker (short TTL).
 * - channel `streams:cancel`    fast path: the owning instance stops the stream within milliseconds.
 *   The markers are the backstop for a missed message: every heartbeat reads them.
 * No prompt, answer, email or token ever reaches Redis.
 */

/** Atomic check-and-take of one slot: 1 taken (or already held), 0 full, -1 the account is being deleted. */
const ACQUIRE_LUA = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local ttl = tonumber(ARGV[3])
if redis.call('EXISTS', KEYS[2]) == 1 then return -1 end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZSCORE', KEYS[1], ARGV[1]) then return 1 end
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then return 0 end
redis.call('ZADD', KEYS[1], now + ttl, ARGV[1])
redis.call('PEXPIRE', KEYS[1], ttl * 2)
return 1
`;

/**
 * Refreshes this instance's streams (KEYS: slots, cancel marker, account marker per stream; ARGV:
 * ttl then the stream ids). Returns the ids that were asked to stop; their slots are released.
 * A slot lost to a Redis restart is written back, so the count stays right after an outage.
 */
const HEARTBEAT_LUA = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local ttl = tonumber(ARGV[1])
local out = {}
for i = 1, #ARGV - 1 do
  local slots = KEYS[3 * i - 2]
  local id = ARGV[i + 1]
  if redis.call('EXISTS', KEYS[3 * i - 1]) == 1 or redis.call('EXISTS', KEYS[3 * i]) == 1 then
    redis.call('ZREM', slots, id)
    table.insert(out, id)
  else
    redis.call('ZADD', slots, now + ttl, id)
    redis.call('PEXPIRE', slots, ttl * 2)
  end
end
return out
`;

/** Cancels a stream only if it is one of this account's live streams: 1 asked to stop, 0 not found. */
const CANCEL_LUA = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local score = redis.call('ZSCORE', KEYS[1], ARGV[1])
if not score or tonumber(score) <= now then return 0 end
redis.call('SET', KEYS[2], '1', 'PX', tonumber(ARGV[2]))
redis.call('PUBLISH', ARGV[3], 's:' .. ARGV[1])
return 1
`;

/** Stops every stream of an account, on every instance, and frees its slots. */
const CANCEL_ACCOUNT_LUA = `
redis.call('SET', KEYS[2], '1', 'PX', tonumber(ARGV[1]))
redis.call('DEL', KEYS[1])
redis.call('PUBLISH', ARGV[2], 'u:' .. ARGV[3])
return 1
`;

type StreamRedis = Redis & {
  dashStreamAcquire(slots: string, accountMarker: string, streamId: string, limit: number, ttlMs: number): Promise<number>;
  dashStreamHeartbeat(numKeys: number, ...args: Array<string | number>): Promise<string[]>;
  dashStreamCancel(slots: string, marker: string, streamId: string, markerTtlMs: number, channel: string): Promise<number>;
  dashStreamCancelAccount(slots: string, accountMarker: string, markerTtlMs: number, channel: string, accountKey: string): Promise<number>;
};

/** An account id as it appears in Redis: hashed, so ids never reach Redis in the clear. */
export const accountKey = (userId: string): string => createHash("sha256").update(`stream:${userId}`).digest("base64url").slice(0, 32);

export type AcquireOutcome = "admitted" | "full" | "gone";
export type CancelMessage = { kind: "stream"; streamId: string } | { kind: "account"; accountKey: string };

/** The operation that failed when Redis could not be used (metrics and logs; never the URL). */
export type StreamControlOp = "acquire" | "release" | "heartbeat" | "cancel" | "cancel_account";

export class StreamControlUnavailable extends Error {
  constructor(readonly op: StreamControlOp, cause?: unknown) {
    super("Shared stream state is unavailable");
    this.name = "StreamControlUnavailable";
    if (cause !== undefined) this.cause = cause;
  }
}

export interface RedisStreamControlOptions {
  url: string;
  /** Key prefix shared with the rate limits' Redis (default "dash:"). */
  prefix?: string;
  /** How long a slot lives without a heartbeat (a crashed instance's streams free up after this). */
  slotTtlMs: number;
  commandTimeoutMs?: number;
}

/** The Redis side of StreamRegistry. Every method throws StreamControlUnavailable when Redis cannot answer. */
export class RedisStreamControl {
  readonly kind = "redis" as const;
  private readonly redis: StreamRedis;
  private subscriber: Redis | undefined;
  private readonly prefix: string;
  private readonly channel: string;
  readonly slotTtlMs: number;
  /** Markers outlive every slot they could apply to. */
  private readonly markerTtlMs: number;

  constructor(private readonly options: RedisStreamControlOptions) {
    this.prefix = `${options.prefix ?? "dash:"}streams:`;
    this.channel = `${this.prefix}cancel`;
    this.slotTtlMs = options.slotTtlMs;
    this.markerTtlMs = Math.max(60_000, options.slotTtlMs * 3);
    this.redis = new Redis(options.url, {
      // Never queue while disconnected: a stream is refused at once rather than left waiting.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      commandTimeout: options.commandTimeoutMs ?? 1_000,
      connectTimeout: 2_000,
    }) as StreamRedis;
    this.redis.defineCommand("dashStreamAcquire", { numberOfKeys: 2, lua: ACQUIRE_LUA });
    this.redis.defineCommand("dashStreamHeartbeat", { lua: HEARTBEAT_LUA });
    this.redis.defineCommand("dashStreamCancel", { numberOfKeys: 2, lua: CANCEL_LUA });
    this.redis.defineCommand("dashStreamCancelAccount", { numberOfKeys: 2, lua: CANCEL_ACCOUNT_LUA });
    // Errors surface through each call; never print the URL (it can hold a password).
    this.redis.on("error", () => undefined);
  }

  private slots(account: string): string {
    return `${this.prefix}u:${account}`;
  }
  private streamMarker(streamId: string): string {
    return `${this.prefix}c:${streamId}`;
  }
  private accountMarker(account: string): string {
    return `${this.prefix}d:${account}`;
  }

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

  private async call<T>(op: StreamControlOp, fn: () => Promise<T>): Promise<T> {
    if (this.redis.status !== "ready") throw new StreamControlUnavailable(op);
    try {
      return await fn();
    } catch (err) {
      throw new StreamControlUnavailable(op, err);
    }
  }

  async acquire(account: string, streamId: string, limit: number): Promise<AcquireOutcome> {
    const r = await this.call("acquire", () => this.redis.dashStreamAcquire(this.slots(account), this.accountMarker(account), streamId, limit, this.slotTtlMs));
    return r === 1 ? "admitted" : r === -1 ? "gone" : "full";
  }

  async release(account: string, streamId: string): Promise<void> {
    await this.call("release", () => this.redis.zrem(this.slots(account), streamId));
  }

  /** Refreshes these streams' slots; returns the ids that must stop (cancelled elsewhere). */
  async heartbeat(entries: ReadonlyArray<{ account: string; streamId: string }>): Promise<string[]> {
    const out: string[] = [];
    for (let i = 0; i < entries.length; i += 200) {
      const batch = entries.slice(i, i + 200);
      const keys = batch.flatMap((e) => [this.slots(e.account), this.streamMarker(e.streamId), this.accountMarker(e.account)]);
      out.push(...(await this.call("heartbeat", () => this.redis.dashStreamHeartbeat(keys.length, ...keys, this.slotTtlMs, ...batch.map((e) => e.streamId)))));
    }
    return out;
  }

  /** True when the stream is one of this account's live streams (it has then been asked to stop). */
  async cancel(account: string, streamId: string): Promise<boolean> {
    return (await this.call("cancel", () => this.redis.dashStreamCancel(this.slots(account), this.streamMarker(streamId), streamId, this.markerTtlMs, this.channel))) === 1;
  }

  async cancelAccount(account: string): Promise<void> {
    await this.call("cancel_account", () =>
      this.redis.dashStreamCancelAccount(this.slots(account), this.accountMarker(account), this.markerTtlMs, this.channel, account),
    );
  }

  /** Delivers cancellations published by any instance (resubscribes by itself after a reconnect). */
  subscribe(handler: (message: CancelMessage) => void): void {
    if (this.subscriber) return;
    // A separate connection (subscriber mode); it may queue its SUBSCRIBE until connected.
    this.subscriber = new Redis(this.options.url, { connectTimeout: 2_000, maxRetriesPerRequest: null });
    this.subscriber.on("error", () => undefined);
    this.subscriber.on("message", (_channel: string, message: string) => {
      if (message.startsWith("s:")) handler({ kind: "stream", streamId: message.slice(2) });
      else if (message.startsWith("u:")) handler({ kind: "account", accountKey: message.slice(2) });
    });
    void this.subscriber.subscribe(this.channel).catch(() => undefined);
  }

  async healthy(): Promise<boolean> {
    try {
      return (await this.redis.ping()) === "PONG";
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.subscriber?.disconnect();
    this.redis.disconnect();
  }
}
