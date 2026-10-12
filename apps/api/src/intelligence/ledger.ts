import type { FastifyBaseLogger } from "fastify";
import type { Metrics } from "../observability/metrics.js";
import { isToolCallTurn, isToolResultTurn, type ProviderAdapter, type ProviderChunk, type ProviderError, type ProviderRequest } from "../providers/types.js";
import { newId } from "../security/crypto.js";
import type { InferenceAttemptRow, Store } from "../store/store.js";
import { estimateCostUsd, type ModelPrices } from "./cost.js";
import type { RouterPolicy } from "./policy.js";
import type { QuotaTracker } from "./quota.js";
import type { SpendGuard } from "./spend.js";

/**
 * Accounting estimate of tokens from characters: deliberately conservative (about three characters
 * per token, so it over- rather than under-counts). It is recorded as an estimate and used for cost
 * only when a provider reports no usage; provider-reported counts are always preferred.
 */
export const estimateTokensForLedger = (chars: number): number => Math.ceil(Math.max(0, chars) / 3);

/** Everything sent to the provider, in characters: system prompt, turns, tool calls and results, tool schemas. */
export function requestChars(request: Pick<ProviderRequest, "system" | "messages" | "tools">): number {
  let n = request.system.length;
  for (const m of request.messages) {
    if (isToolResultTurn(m)) n += m.results.reduce((s, r) => s + r.content.length + r.name.length, 0);
    else if (isToolCallTurn(m)) n += m.content.length + m.toolCalls.reduce((s, c) => s + c.name.length + c.argumentsJson.length, 0);
    else n += m.content.length;
  }
  if (request.tools?.length) n += JSON.stringify(request.tools).length;
  return n;
}

/** Who and what an answer is for: shared by all of its attempts. */
export interface InferenceContext {
  inferenceId: string;
  userId: string | null;
  plan: string;
  task: string;
  mode: string | null;
  /** Routing metadata for internal debugging (route key, order, rejections, sensitivity). Never content. */
  route: Record<string, unknown>;
}

/** One finished provider attempt. */
export interface AttemptReport {
  adapter: Pick<ProviderAdapter, "id" | "model" | "demo">;
  fallbackIndex: number;
  round: number;
  retry: number;
  startedAt: number;
  endedAt: number;
  requestChars: number;
  outputChars: number;
  finish?: Extract<ProviderChunk, { type: "finish" }>;
  error?: ProviderError;
}

/** Without a Retry-After, a provider that reports its quota used up is paused this long. */
export const QUOTA_PAUSE_MS = 60 * 60 * 1000;
/** A rate limit that asks callers to wait at least this long pauses the provider for that time. */
export const LONG_RETRY_AFTER_MS = 10_000;

/**
 * Records every provider attempt: an immutable ledger row (tokens, latency, outcome, cost, route), the
 * provider's quota usage, and pauses when a provider reports its quota used up or asks to wait. Never
 * throws: accounting must not break an answer (failures are logged).
 */
export class AttemptRecorder {
  constructor(
    private readonly deps: {
      store: Store;
      quota: QuotaTracker;
      prices: ModelPrices;
      policy: RouterPolicy;
      spend?: SpendGuard;
      metrics?: Metrics;
      log: FastifyBaseLogger;
      /** The clock spend limits and quota seeding read; rows are stamped with it. */
      now?: () => number;
    },
  ) {}

  async record(ctx: InferenceContext, a: AttemptReport): Promise<InferenceAttemptRow | undefined> {
    const { store, quota, prices, policy, metrics, log } = this.deps;
    const provider = a.adapter.id;
    const pricing: InferenceAttemptRow["pricing"] = a.adapter.demo ? "demo" : (policy.providers[provider]?.pricing ?? "paid");
    const reported = a.finish?.usage;
    const providerTokens = reported && reported.inputTokens !== null && reported.outputTokens !== null;
    // A provider that refused the request (an HTTP error before any output: 429, 5xx, 4xx) generated
    // nothing billable. Anything else (an answer, a timeout, a cancel, a failure mid-answer) may be
    // billed, so its tokens are estimated when the provider reported none.
    const refused = Boolean(a.error && a.error.httpStatus !== undefined && a.outputChars === 0 && !a.finish);
    const estimatedInputTokens = refused ? 0 : estimateTokensForLedger(a.requestChars);
    const estimatedOutputTokens = refused ? 0 : estimateTokensForLedger(a.outputChars);
    const inputTokens = providerTokens ? reported.inputTokens! : estimatedInputTokens;
    const outputTokens = providerTokens ? reported.outputTokens! : estimatedOutputTokens;
    const model = a.finish?.servedModel ?? a.adapter.model;
    const estimatedCostUsd = estimateCostUsd(prices, { provider, model, demo: a.adapter.demo, usage: { inputTokens, outputTokens } });
    const providerCostUsd = a.finish?.providerCostUsd ?? null;
    const e = a.error;
    const outcome: InferenceAttemptRow["outcome"] = !e ? "success" : e.code === "cancelled" ? "cancelled" : "failure";
    const latencyMs = Math.max(0, Math.round(a.endedAt - a.startedAt));
    const row: InferenceAttemptRow = {
      id: newId(),
      inferenceId: ctx.inferenceId,
      userId: ctx.userId,
      plan: ctx.plan,
      task: ctx.task,
      mode: ctx.mode,
      provider,
      model,
      pricing,
      // When the attempt started, on the application clock (the one spend limits and quotas read).
      createdAt: new Date((this.deps.now ?? Date.now)() - latencyMs).toISOString(),
      latencyMs,
      outcome,
      errorCode: !e ? null : e.quotaExhausted ? "quota_exhausted" : e.code,
      httpStatus: e?.httpStatus ?? null,
      retry: a.retry,
      round: a.round,
      fallbackIndex: a.fallbackIndex,
      inputTokens: providerTokens ? reported.inputTokens : null,
      outputTokens: providerTokens ? reported.outputTokens : null,
      cachedInputTokens: a.finish?.cachedInputTokens ?? null,
      estimatedInputTokens,
      estimatedOutputTokens,
      tokenSource: providerTokens ? "provider" : "estimated",
      estimatedCostUsd,
      providerCostUsd,
      currency: "USD",
      route: ctx.route,
    };

    if (!a.adapter.demo) {
      quota.record(provider, { requests: 1, tokens: inputTokens + outputTokens, costUsd: providerCostUsd ?? estimatedCostUsd ?? 0 });
      if (e?.quotaExhausted) {
        quota.pause(provider, e.retryAfterMs ?? QUOTA_PAUSE_MS, "quota_exhausted");
        metrics?.providerPauses.inc({ provider, reason: "quota_exhausted" });
        log.warn({ provider, retryAfterMs: e.retryAfterMs ?? null }, "provider reported its quota used up; paused");
      } else if (e?.code === "rate_limited" && (e.retryAfterMs ?? 0) >= LONG_RETRY_AFTER_MS) {
        quota.pause(provider, e.retryAfterMs!, "rate_limited");
        metrics?.providerPauses.inc({ provider, reason: "rate_limited" });
      }
    }
    metrics?.inferenceAttempts.inc({ provider, pricing, outcome });
    const cost = providerCostUsd ?? estimatedCostUsd;
    if (cost) {
      metrics?.attemptCostUsd.inc({ pricing }, cost);
      if (pricing === "paid") this.deps.spend?.invalidate();
    }
    try {
      await store.recordInferenceAttempt(row);
      return row;
    } catch (err) {
      log.warn({ err, provider, inferenceId: ctx.inferenceId }, "could not record an inference attempt");
      return undefined;
    }
  }
}
