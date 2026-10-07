import type { ProviderId } from "@dash-ai/contracts";

/** What the router has observed about one provider on this API instance. */
export interface ProviderHealthSnapshot {
  provider: ProviderId;
  /** Smoothed success rate of finished requests, 0..1 (1 until something is observed). */
  reliability: number;
  /** Smoothed duration of successful requests, or null before the first one. */
  latencyMs: number | null;
  consecutiveFailures: number;
  /** While set and in the future, the provider goes to the back of every route. */
  circuitOpenUntil: string | null;
  successes: number;
  failures: number;
  lastFailureCode: string | null;
}

interface State {
  reliability: number;
  latencyMs: number | null;
  consecutiveFailures: number;
  circuitOpenUntil: number;
  successes: number;
  failures: number;
  lastFailureCode: string | null;
}

/**
 * Per-instance provider health: smoothed reliability and latency plus a simple circuit breaker. Fed by
 * every routed request (chat and automations). Counts and codes only; never content.
 *
 * Each instance learns on its own: health is advisory (it reorders routes, never removes the last
 * option), so instances disagreeing briefly is harmless. A shared view can come later from metrics.
 */
export class ProviderHealth {
  private readonly states = new Map<ProviderId, State>();

  constructor(
    private readonly options: { smoothing: number; failureThreshold: number; cooldownMs: number },
    private readonly now: () => number = Date.now,
  ) {}

  private state(provider: ProviderId): State {
    let s = this.states.get(provider);
    if (!s) {
      s = { reliability: 1, latencyMs: null, consecutiveFailures: 0, circuitOpenUntil: 0, successes: 0, failures: 0, lastFailureCode: null };
      this.states.set(provider, s);
    }
    return s;
  }

  recordSuccess(provider: ProviderId, durationMs: number): void {
    const s = this.state(provider);
    const a = this.options.smoothing;
    s.reliability = s.reliability * (1 - a) + a;
    s.latencyMs = s.latencyMs === null ? durationMs : s.latencyMs * (1 - a) + durationMs * a;
    s.consecutiveFailures = 0;
    s.circuitOpenUntil = 0;
    s.successes += 1;
  }

  /**
   * A provider failure. Only provider-side failures count (outage, timeout, rate limiting): a request
   * the person cancelled says nothing about the provider and is never recorded.
   */
  recordFailure(provider: ProviderId, code: string, retryable: boolean): void {
    const s = this.state(provider);
    const a = this.options.smoothing;
    s.reliability = s.reliability * (1 - a);
    s.failures += 1;
    s.lastFailureCode = code;
    // A non-retryable failure (a request too long for the model, a rejected key) is about this
    // request or this configuration; only repeated retryable ones open the circuit.
    if (!retryable) return;
    s.consecutiveFailures += 1;
    if (s.consecutiveFailures >= this.options.failureThreshold) s.circuitOpenUntil = this.now() + this.options.cooldownMs;
  }

  isOpen(provider: ProviderId): boolean {
    return this.state(provider).circuitOpenUntil > this.now();
  }

  reliability(provider: ProviderId): number {
    return this.state(provider).reliability;
  }

  latencyMs(provider: ProviderId): number | null {
    return this.state(provider).latencyMs;
  }

  snapshot(providers: readonly ProviderId[]): ProviderHealthSnapshot[] {
    return providers.map((provider) => {
      const s = this.state(provider);
      return {
        provider,
        reliability: Math.round(s.reliability * 1000) / 1000,
        latencyMs: s.latencyMs === null ? null : Math.round(s.latencyMs),
        consecutiveFailures: s.consecutiveFailures,
        circuitOpenUntil: s.circuitOpenUntil > this.now() ? new Date(s.circuitOpenUntil).toISOString() : null,
        successes: s.successes,
        failures: s.failures,
        lastFailureCode: s.lastFailureCode,
      };
    });
  }
}
