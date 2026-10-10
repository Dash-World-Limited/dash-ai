import type { ProviderId } from "@dash-ai/contracts";

/** Quota counters supported by provider APIs and operator configuration. */
export type QuotaDimension =
  | "requests_minute"
  | "requests_day"
  | "tokens_minute"
  | "tokens_day"
  | "tokens_month";

export interface QuotaWindow {
  /** Maximum allowance for the window. null means the provider does not report a limit. */
  limit: number | null;
  /** Usage observed/reported inside the current window. */
  used: number;
  /** ISO timestamp for the next reset when the provider reports one. */
  resetAt?: string | null;
}

/**
 * Normalized provider quota state. This deliberately does not assume every provider exposes the
 * same counters: unknown data stays unknown instead of being guessed.
 */
export interface ProviderQuotaSnapshot {
  classification: "unknown" | "unlimited" | "metered";
  dimensions?: Partial<Record<QuotaDimension, QuotaWindow>>;
  /** Promotional/prepaid balance where the provider exposes it. Zero is a hard exhaustion signal. */
  promotionalBalanceUsd?: number | null;
  /** When this snapshot was collected; informational only. */
  updatedAt?: string | null;
}

export interface ProviderQuotaStatus {
  hardExhausted: boolean;
  softExhausted: boolean;
  /** Lowest remaining fraction across active known windows, or null when no finite limit is known. */
  remainingFraction: number | null;
}

const CLEAR: ProviderQuotaStatus = { hardExhausted: false, softExhausted: false, remainingFraction: null };

/**
 * In-memory normalized quota view used by the router. Persistence/provider polling is intentionally
 * separate: callers may feed snapshots from provider APIs, admin configuration, or future workers.
 */
export class ProviderQuotaTracker {
  private readonly snapshots = new Map<ProviderId, ProviderQuotaSnapshot>();

  constructor(
    private readonly softThreshold = 0.1,
    private readonly now: () => number = Date.now,
  ) {
    if (!(softThreshold >= 0 && softThreshold <= 1)) throw new Error("softThreshold must be between 0 and 1");
  }

  update(provider: ProviderId, snapshot: ProviderQuotaSnapshot): void {
    this.snapshots.set(provider, snapshot);
  }

  clear(provider: ProviderId): void {
    this.snapshots.delete(provider);
  }

  snapshot(provider: ProviderId): ProviderQuotaSnapshot | undefined {
    return this.snapshots.get(provider);
  }

  status(provider: ProviderId): ProviderQuotaStatus {
    const snapshot = this.snapshots.get(provider);
    if (!snapshot || snapshot.classification === "unknown" || snapshot.classification === "unlimited") return CLEAR;

    const fractions: number[] = [];
    let hardExhausted = snapshot.promotionalBalanceUsd !== undefined && snapshot.promotionalBalanceUsd !== null && snapshot.promotionalBalanceUsd <= 0;

    for (const window of Object.values(snapshot.dimensions ?? {})) {
      if (!window || window.limit === null || !Number.isFinite(window.limit) || !Number.isFinite(window.used)) continue;

      // A provider may leave the last window in telemetry after it reset. Do not let stale counters
      // block routing until a fresh snapshot arrives.
      if (window.resetAt) {
        const resetMs = Date.parse(window.resetAt);
        if (Number.isFinite(resetMs) && resetMs <= this.now()) continue;
      }

      if (window.limit <= 0) {
        hardExhausted = true;
        fractions.push(0);
        continue;
      }

      const used = Math.max(0, window.used);
      const remaining = Math.max(0, (window.limit - used) / window.limit);
      fractions.push(remaining);
      if (used >= window.limit) hardExhausted = true;
    }

    const remainingFraction = fractions.length ? Math.min(...fractions) : null;
    return {
      hardExhausted,
      softExhausted: !hardExhausted && remainingFraction !== null && remainingFraction <= this.softThreshold,
      remainingFraction,
    };
  }
}
