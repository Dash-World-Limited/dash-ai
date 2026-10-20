import type { AssistantMode, ProviderId, Usage } from "@dash-ai/contracts";
import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "../config.js";
import { retryDelayMs } from "../chat/orchestrator.js";
import { withIdleTimeout } from "../chat/timeouts.js";
import type { Metrics } from "../observability/metrics.js";
import { buildSystemPrompt } from "../providers/instructions.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { ProviderError, toProviderError, type ProviderAdapter, type ProviderChunk, type ProviderRequest } from "../providers/types.js";
import type { SpendCoverage } from "./coverage.js";
import { estimateTokensForLedger, requestChars, type InferenceContext } from "./ledger.js";
import { SpendAdmissionError, type Admission, type AiPlatform } from "./platform.js";
import type { RoutePreference, Sensitivity, TaskType } from "./policy.js";
import { estimateTokens, type IntelligenceRouter } from "./router.js";

export interface GenerateDeps {
  providers: ProviderRegistry;
  router: IntelligenceRouter;
  ai: AiPlatform;
  config: AppConfig;
  log: FastifyBaseLogger;
  metrics?: Metrics;
}

export interface GenerateRequest {
  task: TaskType;
  mode: AssistantMode;
  /** Task-specific instructions added after DASH AI's identity and mode instructions. */
  instructions: string;
  prompt: string;
  preference?: RoutePreference;
  signal?: AbortSignal;
  /** The account the work is for (spend limits and the ledger), and the id its ledger rows share. */
  userId: string | null;
  inferenceId: string;
  /**
   * The most time the whole generation (every retry and fallback) may take; enforced here, and the
   * basis of its spend reservation's lease. Default: every configured provider at every retry, each
   * at PROVIDER_TIMEOUT_MS.
   */
  maxDurationMs?: number;
}

export interface GenerateResult {
  content: string;
  /** Internal only (diagnostics, usage, cost); never shown to people. */
  provider: ProviderId;
  model: string;
  /** The model the adapter was configured with (the served `model` may be a dated snapshot of it). */
  configuredModel: string;
  demo: boolean;
  usage: Usage;
  truncated: boolean;
}

/** Why a generation failed, as a normalized code; never provider text. */
export class GenerationError extends Error {
  constructor(
    readonly code: "unavailable" | "provider_error" | "provider_timeout" | "rate_limited" | "limit_reached" | "cancelled",
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = "GenerationError";
  }
}

/**
 * One complete, non-streaming answer for work nobody is watching live (DASH Automates; later reports
 * and background workflows). The DASH Intelligence Router picks the route; each provider gets bounded
 * retries, then the next provider in the route takes over. Because nothing is shown until the whole
 * answer exists, falling over to another provider is always safe here, even after partial output.
 */
export async function generateText(deps: GenerateDeps, request: GenerateRequest): Promise<GenerateResult> {
  if (!deps.config.ai.enabled) throw new GenerationError("unavailable", false);
  const inputChars = request.prompt.length + request.instructions.length + 4_000;
  const estimatedInputTokens = estimateTokens(inputChars);
  // Background work carries the person's own words: it is classified like any other request.
  const sensitivity = deps.ai.classify({ documents: 0, toolsOffered: false });
  const { config } = deps;
  const maxDurationMs =
    request.maxDurationMs ?? Math.max(1, deps.providers.configured().size) * (config.providerRetry.maxRetries + 1) * config.providerTimeoutMs;
  let admission: Admission;
  try {
    // Routed on the spend estimate, then the worst case is held atomically against every spend limit
    // (requests already in flight included) before anything is sent; see ADR 0015.
    admission = await deps.ai.admitAndReserve({
      userId: request.userId,
      inferenceId: request.inferenceId,
      task: request.task,
      maxDurationMs,
      inputChars,
      loop: null,
      route: (costFields) =>
        deps.router.route({
          task: request.task,
          mode: request.mode,
          preference: request.preference,
          estimatedInputTokens,
          sensitivity,
          plan: deps.ai.plan,
          inputModalities: ["text"],
          ...costFields,
        }),
    });
  } catch (err) {
    if (err instanceof SpendAdmissionError) throw new GenerationError("rate_limited", true);
    throw err;
  }
  try {
    // No provider request outlives the reservation's bound (every attempt's signal derives from this).
    const signal = request.signal ? AbortSignal.any([request.signal, AbortSignal.timeout(maxDurationMs)]) : AbortSignal.timeout(maxDurationMs);
    return await generateAdmitted(deps, { ...request, signal }, admission, estimatedInputTokens, sensitivity);
  } finally {
    // After every attempt is in the ledger, whatever the outcome.
    await deps.ai.settle(admission.reservation);
  }
}

async function generateAdmitted(
  deps: GenerateDeps,
  request: GenerateRequest,
  admission: Admission,
  estimatedInputTokens: number,
  sensitivity: Sensitivity,
): Promise<GenerateResult> {
  const { decision, spend } = admission;
  deps.ai.noteSpendLimit(decision, spend);
  if (!decision.ok) {
    deps.metrics?.routerUnavailable.inc({ task: request.task, reason: decision.reason });
    const refusal = deps.ai.refusal(decision, spend);
    if (refusal.kind === "busy") throw new GenerationError("rate_limited", true);
    if (refusal.kind === "user_limit" || refusal.kind === "too_large") throw new GenerationError("limit_reached", false);
    throw new GenerationError("unavailable", decision.reason === "no_provider");
  }
  const adapters = decision.providers.map((p) => deps.providers.get(p)).filter((a): a is ProviderAdapter => a !== undefined);
  if (adapters.length === 0) throw new GenerationError("unavailable", true);
  deps.metrics?.routerDecisions.inc({ task: request.task, provider: adapters[0]!.id });

  const inference: InferenceContext = {
    inferenceId: request.inferenceId,
    userId: request.userId,
    plan: deps.ai.plan,
    task: request.task,
    mode: request.mode,
    route: {
      routeKey: decision.routeKey,
      order: decision.providers,
      rejected: decision.rejected.filter((r) => r.reason !== "not_configured"),
      sensitivity,
      spendBlockedBy: spend.blockedBy,
    },
  };
  // Every paid attempt (retries and fallbacks included) is covered by the hold before it is sent (ADR 0016).
  const coverage = deps.ai.coverage(admission.reservation);
  let last: ProviderError | undefined;
  let spendStopped: SpendStop | undefined;
  for (const [index, adapter] of adapters.entries()) {
    try {
      return await generateWith(deps, adapter, request, estimatedInputTokens, inference, index, coverage);
    } catch (err) {
      if (err instanceof SpendStop) {
        // This provider's first attempt could not be covered: never sent. The next provider in the route
        // (a free one needs no cover) may still serve; nothing re-routes in a loop.
        spendStopped = err;
        const next = adapters[index + 1];
        if (next) deps.log.info({ from: adapter.id, to: next.id, reason: err.reason, task: request.task }, "provider skipped: its spend could not be covered");
        continue;
      }
      const error = err instanceof ProviderError ? err : toProviderError(adapter.displayName, err, request.signal);
      if (error.code === "cancelled") throw new GenerationError("cancelled", false);
      last = error;
      const next = adapters[index + 1];
      if (next) {
        deps.metrics?.providerFallbacks.inc({ from: adapter.id, to: next.id, code: error.code });
        deps.log.warn({ from: adapter.id, to: next.id, code: error.code, httpStatus: error.httpStatus, task: request.task }, "provider fallback");
      }
    }
  }
  if (!last && spendStopped) {
    // Nothing was sent: refused like a spend admission (busy when it could not be checked).
    if (spendStopped.reason === "error" || spendStopped.reason === "inactive") throw new GenerationError("rate_limited", true);
    if (spendStopped.blockedBy === "user_daily" || spendStopped.blockedBy === "plan_daily") throw new GenerationError("limit_reached", false);
    throw new GenerationError("unavailable", true);
  }
  const code = last?.code === "provider_timeout" || last?.code === "rate_limited" ? last.code : "provider_error";
  throw new GenerationError(code, last?.retryable ?? true);
}

/** A provider's first attempt was not sent because its spend could not be covered (internal). */
class SpendStop extends Error {
  constructor(
    readonly reason: string,
    readonly blockedBy: string | undefined,
  ) {
    super("spend not covered");
    this.name = "SpendStop";
  }
}

async function generateWith(
  deps: GenerateDeps,
  adapter: ProviderAdapter,
  request: GenerateRequest,
  estimatedInputTokens: number,
  inference: InferenceContext,
  fallbackIndex: number,
  coverage: SpendCoverage,
): Promise<GenerateResult> {
  const { config } = deps;
  const system = [buildSystemPrompt(request.mode, adapter), request.instructions].join("\n\n");
  const started = Date.now();
  let failed: ProviderError | undefined;
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(request.signal?.reason ?? "cancelled");
    if (request.signal?.aborted) onAbort();
    else request.signal?.addEventListener("abort", onAbort, { once: true });
    const overall = setTimeout(() => controller.abort("timeout"), config.providerTimeoutMs);
    let content = "";
    let usage: Usage = { inputTokens: null, outputTokens: null };
    let finish: "stop" | "length" | "refusal" = "stop";
    let servedModel = adapter.model;
    let finishChunk: Extract<ProviderChunk, { type: "finish" }> | undefined;
    const attemptStarted = Date.now();
    const providerRequest: ProviderRequest = {
      system,
      messages: [{ role: "user", content: request.prompt }],
      maxOutputTokens: config.maxOutputTokens,
      signal: controller.signal,
      routing: {
        task: request.task,
        mode: request.mode,
        preference: request.preference ?? "balanced",
        estimatedInputTokens,
      },
    };
    const at = { fallbackIndex, round: 0, retry: attempt };
    // Before anything is sent: this exact request at this provider's prices must fit in the hold.
    const cover = await coverage.cover({ ...at, adapter, inputTokens: estimateTokensForLedger(requestChars(providerRequest)) });
    if (!cover.ok) {
      clearTimeout(overall);
      request.signal?.removeEventListener("abort", onAbort);
      // A retry that cannot be covered is not sent: the failure that asked for it stands.
      if (failed) throw failed;
      throw new SpendStop(cover.reason, cover.blockedBy);
    }
    const report = (error?: ProviderError) =>
      deps.ai.attempts.record(inference, {
        adapter,
        fallbackIndex,
        round: 0,
        retry: attempt,
        startedAt: attemptStarted,
        endedAt: Date.now(),
        requestChars: requestChars(providerRequest),
        outputChars: content.length,
        finish: finishChunk,
        error,
      });
    try {
      const source = adapter.stream(providerRequest);
      for await (const chunk of withIdleTimeout(source, config.providerIdleTimeoutMs, () => controller.abort("timeout"))) {
        if (chunk.type === "text") content += chunk.text;
        else if (chunk.type === "finish") {
          finish = chunk.finishReason;
          usage = chunk.usage;
          servedModel = chunk.servedModel ?? servedModel;
          finishChunk = chunk;
        }
      }
      if (content.trim() === "") throw new ProviderError("provider_error", `${adapter.displayName} returned an empty answer.`, true);
      coverage.record(at, await report(), { output: true });
      deps.router.recordSuccess(adapter.id, Date.now() - started);
      deps.metrics?.aiRequestSeconds.observe({ provider: adapter.id, status: "complete" }, (Date.now() - started) / 1000);
      if (servedModel !== adapter.model) {
        deps.log.info({ provider: adapter.id, configuredModel: adapter.model, servedModel, task: request.task }, "provider served a different model id");
      }
      return { content, provider: adapter.id, model: servedModel, configuredModel: adapter.model, demo: adapter.demo, usage, truncated: finish === "length" };
    } catch (err) {
      const error = toProviderError(adapter.displayName, err, controller.signal);
      coverage.record(at, await report(error), { error, output: content.length > 0 || finishChunk !== undefined });
      failed = error;
      deps.router.recordFailure(adapter.id, error.code, error.retryable);
      if (error.code === "cancelled") throw error;
      deps.metrics?.providerFailures.inc({ provider: adapter.id, code: error.code, retryable: error.retryable });
      const delay = Math.max(retryDelayMs(config.providerRetry, attempt, error), error.retryAfterMs ?? 0);
      const paused = deps.ai.quota.status(adapter.id).state === "paused";
      if (!error.retryable || error.quotaExhausted || paused || attempt >= config.providerRetry.maxRetries || delay > config.providerTimeoutMs) throw error;
      deps.metrics?.providerRetries.inc({ provider: adapter.id, code: error.code });
      deps.log.info({ provider: adapter.id, code: error.code, attempt: attempt + 1, delayMs: delay, task: request.task }, "retrying provider request");
      await new Promise((resolve) => setTimeout(resolve, delay));
    } finally {
      clearTimeout(overall);
      request.signal?.removeEventListener("abort", onAbort);
    }
  }
}
