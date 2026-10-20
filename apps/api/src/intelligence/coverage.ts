import type { ProviderAdapter, ProviderError } from "../providers/types.js";
import type { InferenceAttemptRow, SpendReservationRecord, SpendScope } from "../store/store.js";
import type { AiPlatform } from "./platform.js";

/**
 * Retry and fallback spend accounting (ADR 0016): every paid provider attempt of a request is covered by
 * the request's spend hold BEFORE it is sent. One SpendCoverage per logical request (chat answer or
 * Automates run) counts what its attempts may have cost so far; an attempt that would take the request
 * past its hold is sent only after the hold was extended atomically in the store.
 */

/** Where an attempt sits in its request: the coordinates its ledger row carries. */
export interface AttemptCoordinates {
  fallbackIndex: number;
  round: number;
  retry: number;
}

export interface PlannedAttempt extends AttemptCoordinates {
  adapter: Pick<ProviderAdapter, "id" | "model">;
  /** Estimated input tokens of exactly the request about to be sent (ledger estimate). */
  inputTokens: number;
}

/** Why an extension was needed (metrics only): a retry, a fallback provider's first round, or another round. */
export type AttemptKind = "retry" | "fallback" | "round";

export const attemptKind = (a: AttemptCoordinates): AttemptKind => (a.retry > 0 ? "retry" : a.round === 0 && a.fallbackIndex > 0 ? "fallback" : "round");

export type CoverRefusal = "denied" | "inactive" | "error" | "unpriced";
export type Cover = { ok: true } | { ok: false; reason: CoverRefusal; kind: AttemptKind; blockedBy?: SpendScope };

/**
 * A provider that answered with a client error before producing anything (400, 401, 403, 404, 413, 422,
 * 429) refused the request before working on it. Every other failure of an attempt that began (5xx,
 * connection error, timeout including 408, a stream broken after output, a cancel) may have been billed.
 */
export function refusedBeforeWork(error: ProviderError, output: boolean): boolean {
  const status = error.httpStatus;
  return !output && status !== undefined && status >= 400 && status < 500 && status !== 408;
}

const key = (a: AttemptCoordinates) => `${a.fallbackIndex}:${a.round}:${a.retry}`;
const round10 = (usd: number) => Math.round(usd * 1e10) / 1e10;

export class SpendCoverage {
  private reservedUsd: number;
  /** What each attempt started under this hold counts for: its worst case until known otherwise. */
  private readonly counted = new Map<string, number>();
  private readonly worst = new Map<string, number>();

  constructor(
    private readonly ai: AiPlatform,
    private readonly hold: SpendReservationRecord | null,
  ) {
    this.reservedUsd = hold?.reservedUsd ?? 0;
  }

  /** What the request's earlier attempts may have cost (in-flight ones at their worst case). */
  priorUsd(): number {
    let usd = 0;
    for (const v of this.counted.values()) usd += v;
    return usd;
  }

  /** The hold as this request last saw it. */
  get heldUsd(): number {
    return this.reservedUsd;
  }

  /**
   * Called immediately before an attempt is sent. Free and demonstration providers, and requests with no
   * hold (no aggregate limit applies), need nothing. A paid attempt is covered when everything the
   * request may already have spent plus this attempt's worst case fits in the hold; otherwise the hold is
   * extended first. Anything else (a limit, an unpriced model, an ended hold, a database error) refuses:
   * the attempt must not be sent.
   */
  async cover(a: PlannedAttempt): Promise<Cover> {
    if (!this.hold || !this.ai.isPaid(a.adapter.id)) return { ok: true };
    const k = key(a);
    if (this.counted.has(k)) return { ok: true };
    const kind = attemptKind(a);
    const worst = this.ai.attemptWorstCaseUsd(a.adapter.id, a.inputTokens);
    if (worst === null) {
      this.ai.notePrevented(kind, "unpriced");
      return { ok: false, reason: "unpriced", kind };
    }
    const prior = this.priorUsd();
    if (round10(prior + worst) > round10(this.reservedUsd)) {
      const extended = await this.ai.extendHold(this.hold, { ...a, provider: a.adapter.id, model: a.adapter.model }, { attemptUsd: worst, priorUsd: prior, kind });
      if (!extended.ok) {
        this.ai.notePrevented(kind, extended.reason);
        return { ok: false, reason: extended.reason, kind, ...(extended.blockedBy ? { blockedBy: extended.blockedBy } : {}) };
      }
      this.reservedUsd = Math.max(this.reservedUsd, extended.reservedUsd);
    }
    this.counted.set(k, worst);
    this.worst.set(k, worst);
    return { ok: true };
  }

  /**
   * After the attempt ended and its ledger row was written (row undefined: the write failed). A success
   * or a refusal before work counts its ledger cost from now on; any other failure keeps at least its
   * worst case until the request settles (billing uncertain). Never lowers the hold itself.
   */
  record(a: AttemptCoordinates, row: InferenceAttemptRow | undefined, outcome: { error?: ProviderError; output: boolean }): void {
    const k = key(a);
    const worst = this.worst.get(k);
    if (worst === undefined || !row) return;
    const cost = row.pricing === "paid" ? (row.providerCostUsd ?? row.estimatedCostUsd ?? worst) : 0;
    const certain = !outcome.error || refusedBeforeWork(outcome.error, outcome.output);
    this.counted.set(k, certain ? cost : Math.max(cost, worst));
  }
}
