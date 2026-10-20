import { accountKey, StreamControlUnavailable, type CancelMessage, type RedisStreamControl, type StreamControlOp } from "./streamControl.js";

interface ActiveStream {
  userId: string;
  account: string;
  /** The limit the stream was admitted under (a lost slot is re-taken only within it). */
  limit: number;
  controller: AbortController;
}

/** Why a stream was stopped from outside (metrics). */
export type StopSource = "cancel" | "remote_cancel" | "account_deleted" | "shutdown" | "lease_lost";

export type AcquireResult = { ok: true } | { ok: false; reason: "full" | "gone" | "unavailable" };

export interface StreamRegistryHooks {
  onAdmission?: (outcome: "admitted" | "full" | "gone" | "unavailable") => void;
  onStop?: (source: StopSource) => void;
  /** Redis could not be used for `op` (at most once per second per op is a good log rate). */
  onBackendError?: (op: StreamControlOp, errorName: string) => void;
  onActiveChange?: (active: number) => void;
}

/** How long a deleted account stays refused here (it can no longer authenticate anyway). */
const GONE_MS = 120_000;

/**
 * In-flight chat streams: the per-account concurrency limit and cancellation.
 *
 * Without shared state (one instance, tests) everything is in this process, and admission is a
 * synchronous check-and-take, so concurrent requests can never all pass the check.
 *
 * With RedisStreamControl (several instances) the slots live in Redis and admission is one atomic
 * script, so an account has at most MAX_CONCURRENT_STREAMS_PER_USER streams across every instance.
 * Cancels and account deletions reach the instance that runs the stream through Redis. If Redis
 * cannot answer, new streams are REFUSED (fail closed): the limit never silently multiplies by the
 * number of instances. Streams already running keep going through a short outage. If the outage
 * outlasts STREAM_SLOT_TTL_MS (or Redis lost its data), their slots have expired: the next successful
 * heartbeat re-takes each one only if the account is still below its limit (other streams may have
 * been admitted meanwhile); a stream that cannot get its slot back is stopped ("lease_lost"), saved
 * as stopped, and settles like any cancelled answer.
 */
export class StreamRegistry {
  private readonly streams = new Map<string, ActiveStream>();
  /** Released while a heartbeat was in flight: released again after it (it may have re-added them). */
  private releasedDuringHeartbeat: Set<string> | null = null;
  private readonly gone = new Map<string, number>();
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private beating: Promise<void> | null = null;

  constructor(
    private readonly shared?: RedisStreamControl,
    private readonly hooks: StreamRegistryHooks = {},
    private readonly now: () => number = Date.now,
  ) {
    if (shared) {
      shared.subscribe((m) => this.onCancelMessage(m));
      // Well inside the slot TTL, so one or two missed beats never expire a live stream.
      this.heartbeatTimer = setInterval(() => void this.heartbeat(), Math.max(250, Math.floor(shared.slotTtlMs / 4)));
      this.heartbeatTimer.unref();
    }
  }

  get kind(): "memory" | "redis" {
    return this.shared ? "redis" : "memory";
  }

  /**
   * Takes one of the account's stream slots for `streamId`, or refuses. Nothing about the stream may
   * start (no provider work, no reservation) unless this returns ok.
   */
  async acquire(streamId: string, userId: string, limit: number, controller: AbortController): Promise<AcquireResult> {
    const account = accountKey(userId);
    const goneAt = this.gone.get(account);
    if (goneAt !== undefined && this.now() - goneAt < GONE_MS) return this.admission({ ok: false, reason: "gone" });
    if (!this.shared) {
      if (this.countForUser(userId) >= limit) return this.admission({ ok: false, reason: "full" });
      this.track(streamId, userId, account, limit, controller);
      return this.admission({ ok: true });
    }
    let outcome;
    try {
      outcome = await this.shared.acquire(account, streamId, limit);
    } catch (err) {
      this.backendError(err);
      return this.admission({ ok: false, reason: "unavailable" });
    }
    if (outcome !== "admitted") return this.admission({ ok: false, reason: outcome });
    this.track(streamId, userId, account, limit, controller);
    return this.admission({ ok: true });
  }

  private track(streamId: string, userId: string, account: string, limit: number, controller: AbortController): void {
    this.streams.set(streamId, { userId, account, limit, controller });
    this.hooks.onActiveChange?.(this.streams.size);
  }

  private admission(result: AcquireResult): AcquireResult {
    this.hooks.onAdmission?.(result.ok ? "admitted" : result.reason);
    return result;
  }

  private backendError(err: unknown): void {
    const op = err instanceof StreamControlUnavailable ? err.op : "acquire";
    const cause = err instanceof StreamControlUnavailable ? err.cause : err;
    this.hooks.onBackendError?.(op, cause instanceof Error ? cause.name : "NotConnected");
  }

  /** Frees the stream's slot. Safe to call more than once, and for a stream that was never admitted. */
  async release(streamId: string): Promise<void> {
    const s = this.streams.get(streamId);
    if (!s) return;
    this.streams.delete(streamId);
    this.hooks.onActiveChange?.(this.streams.size);
    if (!this.shared) return;
    this.releasedDuringHeartbeat?.add(streamId);
    try {
      await this.shared.release(s.account, streamId);
    } catch (err) {
      // The slot expires on its own within STREAM_SLOT_TTL_MS (it is no longer refreshed).
      this.backendError(err);
    }
  }

  countForUser(userId: string): number {
    let n = 0;
    for (const s of this.streams.values()) if (s.userId === userId) n++;
    return n;
  }

  private stopLocal(streamId: string, source: StopSource): boolean {
    const s = this.streams.get(streamId);
    if (!s) return false;
    if (!s.controller.signal.aborted) {
      s.controller.abort(source === "shutdown" || source === "lease_lost" ? source : "cancelled");
      this.hooks.onStop?.(source);
    }
    return true;
  }

  /**
   * Cancels a stream owned by userId, on whichever instance runs it. Returns false if this account
   * has no such stream (someone else's stream id is indistinguishable from an unknown one). Throws
   * StreamControlUnavailable when the stream is not here and Redis cannot be asked.
   */
  async cancel(userId: string, streamId: string): Promise<boolean> {
    const local = this.streams.get(streamId);
    if (local) {
      if (local.userId !== userId) return false;
      this.stopLocal(streamId, "cancel");
      return true;
    }
    if (!this.shared) return false;
    try {
      return await this.shared.cancel(accountKey(userId), streamId);
    } catch (err) {
      this.backendError(err);
      throw err;
    }
  }

  /**
   * Stops every stream of an account that is being deleted, here and on every other instance, and
   * refuses new ones. Never throws: the deletion itself must go ahead (streams elsewhere then end
   * when their next database write fails, which can never recreate the account's data).
   */
  async cancelAllForUser(userId: string): Promise<void> {
    const account = accountKey(userId);
    this.gone.set(account, this.now());
    this.pruneGone();
    for (const [id, s] of this.streams) if (s.userId === userId) this.stopLocal(id, "account_deleted");
    if (!this.shared) return;
    try {
      await this.shared.cancelAccount(account);
    } catch (err) {
      this.backendError(err);
    }
  }

  private pruneGone(): void {
    const cutoff = this.now() - GONE_MS;
    for (const [k, at] of this.gone) if (at < cutoff) this.gone.delete(k);
  }

  /** Stops every stream on this instance (shutdown after the drain window). */
  cancelAll(source: StopSource = "shutdown"): void {
    for (const id of this.streams.keys()) this.stopLocal(id, source);
  }

  private onCancelMessage(m: CancelMessage): void {
    if (m.kind === "stream") this.stopLocal(m.streamId, "remote_cancel");
    else {
      this.gone.set(m.accountKey, this.now());
      for (const [id, s] of this.streams) if (s.account === m.accountKey) this.stopLocal(id, "account_deleted");
    }
  }

  /** Refreshes this instance's slots and applies any cancellation whose message was missed. */
  heartbeat(): Promise<void> {
    if (!this.shared || this.beating) return this.beating ?? Promise.resolve();
    const shared = this.shared;
    const entries = [...this.streams].map(([streamId, s]) => ({ streamId, account: s.account, limit: s.limit }));
    if (entries.length === 0) return Promise.resolve();
    this.releasedDuringHeartbeat = new Set();
    this.beating = (async () => {
      try {
        for (const stop of await shared.heartbeat(entries)) {
          const s = this.streams.get(stop.streamId);
          if (!s) continue;
          if (stop.reason === "lease_lost") this.stopLocal(stop.streamId, "lease_lost");
          else this.stopLocal(stop.streamId, this.gone.has(s.account) ? "account_deleted" : "remote_cancel");
        }
      } catch (err) {
        this.backendError(err);
      } finally {
        const released = this.releasedDuringHeartbeat ?? new Set<string>();
        this.releasedDuringHeartbeat = null;
        for (const id of released) {
          const e = entries.find((x) => x.streamId === id);
          if (e) await shared.release(e.account, id).catch((err: unknown) => this.backendError(err));
        }
        this.beating = null;
      }
    })();
    return this.beating;
  }

  get size(): number {
    return this.streams.size;
  }

  /** True when a cancel sent to any instance can reach streams on this one. */
  async sharedHealthy(): Promise<boolean> {
    return this.shared ? this.shared.healthy() : true;
  }

  async close(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    await this.beating;
    await this.shared?.close();
  }
}
