import type { PushPlatform } from "@dash-ai/contracts";
import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "../config.js";
import type { Metrics } from "../observability/metrics.js";
import type { ClaimedPushDelivery, Store } from "../store/store.js";
import { buildPushPayload } from "./payload.js";
import type { PushSendResult, PushTransport } from "./types.js";

export interface PushDeps {
  store: Store;
  transports: PushTransport[];
  config: AppConfig;
  log: FastifyBaseLogger;
  metrics: Metrics;
  now: () => Date;
  /** Jitter source (tests pass a constant). */
  random?: () => number;
}

/** Deliveries one instance sends per pass. */
const BATCH = 20;
/** A claimed delivery not finished within this time is claimed again by any instance. */
const LEASE_MS = 60_000;
/** Longest wait between attempts. */
const MAX_BACKOFF_MS = 3_600_000;
/** One send never blocks a pass for longer than this. */
const SEND_TIMEOUT_MS = 15_000;

/**
 * Sends Automates push notifications. Push is a delivery convenience layered after the fact:
 *
 *   run finishes → result + notification + one delivery row per device are stored together
 *   → this service sends due deliveries → sent / retried with backoff / failed.
 *
 * It never touches runs or results, so a push failure can never fail, repeat or regenerate a run, and
 * the in-app notice is there either way. Every instance runs one; deliveries are claimed with
 * FOR UPDATE SKIP LOCKED, so each is sent by one instance at a time. A delivery is checked again just
 * before sending (the session still valid, Automates pushes still on, the notice not already read,
 * not too old), and a device the push service reports as gone is removed.
 */
export class PushService {
  private timer: NodeJS.Timeout | undefined;
  private ticking: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private readonly controller = new AbortController();
  private readonly transports: Map<PushPlatform, PushTransport>;

  constructor(private readonly deps: PushDeps) {
    this.transports = new Map(deps.transports.map((t) => [t.platform, t]));
  }

  /** True when this server can deliver pushes (a transport is configured). */
  get available(): boolean {
    return this.transports.size > 0;
  }

  start(): void {
    if (!this.available || this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => this.poke(), this.deps.config.push.tickMs);
    this.timer.unref();
    this.poke();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.controller.abort("shutdown");
    await this.idle();
  }

  /** Sends whatever is due soon (coalesced with a pass already running). Never throws. */
  poke(): void {
    if (!this.available || this.stopped) return;
    void this.tick().catch((err: unknown) => this.deps.log.warn({ err }, "push delivery pass failed"));
  }

  async idle(): Promise<void> {
    while (this.ticking) await this.ticking.catch(() => undefined);
  }

  /** One delivery pass: claims and sends due deliveries until none are left. */
  tick(): Promise<void> {
    if (this.ticking) {
      this.again = true;
      return this.ticking;
    }
    this.ticking = (async () => {
      do {
        this.again = false;
        for (;;) {
          if (this.stopped) return;
          const now = this.deps.now();
          const batch = await this.deps.store.claimPushDeliveries(now.toISOString(), new Date(now.getTime() + LEASE_MS).toISOString(), BATCH);
          if (batch.length === 0) break;
          await Promise.all(batch.map((c) => this.deliver(c)));
        }
      } while (this.again && !this.stopped);
    })().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private async deliver(claim: ClaimedPushDelivery): Promise<void> {
    const { store, metrics, log, config } = this.deps;
    const { delivery, device, notification } = claim;
    const finish = (status: "sent" | "failed" | "pending", lastError: string | null, nextAttemptAt: string | null = null) =>
      store.finishPushDelivery({ id: delivery.id, status, lastError, nextAttemptAt, now: this.deps.now().toISOString() });

    // Checked at send time, not only when the delivery was queued.
    const skip = !claim.sessionValid
      ? "signed_out"
      : !claim.automatesEnabled
        ? "disabled"
        : notification.readAt !== null
          ? "already_read"
          : this.deps.now().getTime() - Date.parse(notification.createdAt) > config.push.ttlSeconds * 1000
            ? "expired"
            : null;
    if (skip) {
      await finish("failed", skip);
      metrics.pushDeliveries.inc({ outcome: skip });
      return;
    }
    const transport = this.transports.get(device.platform);
    if (!transport) {
      await finish("failed", "no_transport");
      metrics.pushDeliveries.inc({ outcome: "no_transport" });
      return;
    }

    let result: PushSendResult;
    try {
      result = await transport.send({ token: device.token }, buildPushPayload(notification), {
        ttlSeconds: config.push.ttlSeconds,
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(SEND_TIMEOUT_MS)]),
      });
    } catch {
      result = { ok: false, kind: "retryable", code: "transport_error" };
    }

    // Logs carry ids and normalized codes only: never the token or the payload.
    if (result.ok) {
      await finish("sent", null);
      metrics.pushDeliveries.inc({ outcome: "sent" });
      return;
    }
    if (result.kind === "invalid_token") {
      // The device can never receive again: remove it (its other deliveries go with it).
      await store.removeInvalidPushDevice(device.id);
      metrics.pushDeliveries.inc({ outcome: "invalid_token" });
      log.info({ pushDevice: device.id, transport: transport.name, code: result.code }, "push device removed: token no longer valid");
      return;
    }
    if (result.kind === "retryable" && delivery.attempts < config.push.maxAttempts) {
      const delay = Math.max(result.retryAfterMs ?? 0, this.backoffMs(delivery.attempts));
      await finish("pending", result.code, new Date(this.deps.now().getTime() + delay).toISOString());
      metrics.pushDeliveries.inc({ outcome: "retry" });
      log.info({ pushDelivery: delivery.id, transport: transport.name, code: result.code, attempt: delivery.attempts }, "push delivery will be retried");
      return;
    }
    await finish("failed", result.code);
    metrics.pushDeliveries.inc({ outcome: "failed" });
    log.warn({ pushDelivery: delivery.id, transport: transport.name, code: result.code, attempts: delivery.attempts }, "push delivery failed");
  }

  /** Exponential backoff with ±20% jitter: base, 2×base, 4×base… capped at an hour. */
  backoffMs(attempt: number): number {
    const base = this.deps.config.push.retryBaseMs * 2 ** Math.max(0, attempt - 1);
    const jitter = 0.8 + 0.4 * (this.deps.random ?? Math.random)();
    return Math.round(Math.min(MAX_BACKOFF_MS, base) * jitter);
  }
}
