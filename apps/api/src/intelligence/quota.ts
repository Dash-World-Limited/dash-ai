import { ProviderId } from "@dash-ai/contracts";
import { z } from "zod";

/**
 * Provider quotas. Providers measure allowances differently (requests or tokens, per minute, day or
 * month, a promotional balance, a contract with no published limit, or nothing known at all), so a
 * provider's quota is a list of windows, each tracked on its own. Counts are per API instance and
 * seeded from the inference ledger at start-up; the provider's own 429 remains the final authority,
 * and a provider-reported exhaustion pauses the provider until its reset (see `pause`).
 */
const Counted = z.enum(["requests_per_minute", "requests_per_day", "tokens_per_minute", "tokens_per_day", "tokens_per_month"]);
export const QuotaWindow = z.discriminatedUnion("type", [
  z.object({ type: Counted, limit: z.number().int().positive() }),
  z.object({
    type: z.literal("promotional_balance"),
    /** The balance: USD of list-price usage, or tokens. */
    limit: z.number().positive(),
    unit: z.enum(["usd", "tokens"]),
    /** When the promotion ends (ISO 8601); afterwards the balance counts as spent. */
    expiresAt: z.iso.datetime({ offset: true }).optional(),
  }),
  /** The provider publishes no limit DASH can track: only its own rate-limit answers tell. */
  z.object({ type: z.literal("unknown") }),
  /** Contractual or unmetered capacity: never exhausted by DASH's own accounting. */
  z.object({ type: z.literal("unlimited") }),
]);
export type QuotaWindow = z.infer<typeof QuotaWindow>;

export const ProviderQuotaConfig = z.object({
  windows: z.array(QuotaWindow).min(1),
  /** Share of a limit at which the provider is "approaching exhaustion" and moves behind others. */
  softThreshold: z.number().gt(0).lt(1).default(0.9),
});
export type ProviderQuotaConfig = z.infer<typeof ProviderQuotaConfig>;

export const ProviderQuotas = z.record(ProviderId, ProviderQuotaConfig);
export type ProviderQuotas = z.infer<typeof ProviderQuotas>;

/** ok: below the soft threshold. soft: approaching a limit. exhausted: a limit is reached. paused: temporarily disabled. */
export type QuotaState = "ok" | "soft" | "exhausted" | "paused" | "unknown" | "unlimited";

export interface QuotaWindowStatus {
  type: QuotaWindow["type"];
  limit: number | null;
  used: number;
  remaining: number | null;
  /** When the window starts again, when known (ISO 8601). */
  resetsAt: string | null;
}

export interface QuotaStatus {
  provider: ProviderId;
  state: QuotaState;
  pausedUntil: string | null;
  pauseReason: string | null;
  windows: QuotaWindowStatus[];
}

interface Counter {
  key: string;
  used: number;
}

const MINUTE = 60_000;

function windowKey(type: QuotaWindow["type"], now: number): string {
  const d = new Date(now);
  switch (type) {
    case "requests_per_minute":
    case "tokens_per_minute":
      return String(Math.floor(now / MINUTE));
    case "requests_per_day":
    case "tokens_per_day":
      return d.toISOString().slice(0, 10);
    case "tokens_per_month":
      return d.toISOString().slice(0, 7);
    default:
      return "all";
  }
}

function resetsAt(type: QuotaWindow["type"], now: number): string | null {
  const d = new Date(now);
  switch (type) {
    case "requests_per_minute":
    case "tokens_per_minute":
      return new Date((Math.floor(now / MINUTE) + 1) * MINUTE).toISOString();
    case "requests_per_day":
    case "tokens_per_day":
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
    case "tokens_per_month":
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
    default:
      return null;
  }
}

/** What one attempt consumed, for quota accounting. */
export interface QuotaUsage {
  requests: number;
  tokens: number;
  costUsd: number;
}

export class QuotaTracker {
  private readonly counters = new Map<string, Counter>();
  private readonly pauses = new Map<ProviderId, { until: number; reason: string }>();

  constructor(
    private readonly configs: ProviderQuotas,
    private readonly now: () => number = Date.now,
  ) {}

  private counter(provider: ProviderId, index: number, type: QuotaWindow["type"]): Counter {
    const id = `${provider}#${index}`;
    const key = windowKey(type, this.now());
    let c = this.counters.get(id);
    if (!c || c.key !== key) {
      c = { key, used: 0 };
      this.counters.set(id, c);
    }
    return c;
  }

  private amount(window: QuotaWindow, usage: QuotaUsage): number {
    switch (window.type) {
      case "requests_per_minute":
      case "requests_per_day":
        return usage.requests;
      case "tokens_per_minute":
      case "tokens_per_day":
      case "tokens_per_month":
        return usage.tokens;
      case "promotional_balance":
        return window.unit === "usd" ? usage.costUsd : usage.tokens;
      default:
        return 0;
    }
  }

  /** Count one finished attempt (successful or not: providers count both). */
  record(provider: ProviderId, usage: QuotaUsage): void {
    this.configs[provider]?.windows.forEach((w, i) => {
      if (w.type === "unknown" || w.type === "unlimited") return;
      this.counter(provider, i, w.type).used += this.amount(w, usage);
    });
  }

  /** Start-up: what the ledger says this provider already used in each window. */
  seed(provider: ProviderId, usedByWindow: (window: QuotaWindow) => number): void {
    this.configs[provider]?.windows.forEach((w, i) => {
      if (w.type === "unknown" || w.type === "unlimited") return;
      this.counter(provider, i, w.type).used = usedByWindow(w);
    });
  }

  /**
   * Temporarily disable a provider (its own answer said the quota is exhausted, or asked to wait).
   * Bounded so a bad header can never switch a provider off for long.
   */
  pause(provider: ProviderId, forMs: number, reason: string): void {
    const ms = Math.max(1_000, Math.min(forMs, 24 * 60 * MINUTE));
    const until = this.now() + ms;
    const current = this.pauses.get(provider);
    if (!current || current.until < until) this.pauses.set(provider, { until, reason });
  }

  resume(provider: ProviderId): void {
    this.pauses.delete(provider);
  }

  configured(provider: ProviderId): boolean {
    return this.configs[provider] !== undefined;
  }

  status(provider: ProviderId): QuotaStatus {
    const now = this.now();
    const pause = this.pauses.get(provider);
    const paused = pause && pause.until > now ? pause : undefined;
    if (pause && !paused) this.pauses.delete(provider);
    const config = this.configs[provider];
    const windows: QuotaWindowStatus[] = [];
    let state: QuotaState = config ? "ok" : "unknown";
    if (config) {
      const tracked = config.windows.filter((w) => w.type !== "unknown" && w.type !== "unlimited");
      if (tracked.length === 0) state = config.windows.some((w) => w.type === "unlimited") ? "unlimited" : "unknown";
      config.windows.forEach((w, i) => {
        if (w.type === "unknown" || w.type === "unlimited") {
          windows.push({ type: w.type, limit: null, used: 0, remaining: null, resetsAt: null });
          return;
        }
        const used = this.counter(provider, i, w.type).used;
        const expired = w.type === "promotional_balance" && w.expiresAt !== undefined && Date.parse(w.expiresAt) <= now;
        const remaining = expired ? 0 : Math.max(0, w.limit - used);
        windows.push({ type: w.type, limit: w.limit, used, remaining, resetsAt: resetsAt(w.type, now) });
        if (remaining <= 0) state = "exhausted";
        else if (state === "ok" && used >= w.limit * config.softThreshold) state = "soft";
      });
    }
    return {
      provider,
      state: paused ? "paused" : state,
      pausedUntil: paused ? new Date(paused.until).toISOString() : null,
      pauseReason: paused?.reason ?? null,
      windows,
    };
  }
}
