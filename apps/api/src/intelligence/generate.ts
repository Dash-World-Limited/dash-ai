import type { AssistantMode, ProviderId, Usage } from "@dash-ai/contracts";
import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "../config.js";
import { retryDelayMs } from "../chat/orchestrator.js";
import { withIdleTimeout } from "../chat/timeouts.js";
import type { Metrics } from "../observability/metrics.js";
import { buildSystemPrompt } from "../providers/instructions.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { ProviderError, toProviderError, type ProviderAdapter } from "../providers/types.js";
import { newId } from "../security/crypto.js";
import type { AttemptRecorder, InferenceAttempt } from "./attemptLedger.js";
import { estimateCostUsd } from "./cost.js";
import type { RoutePreference, TaskType } from "./policy.js";
import { estimateTokens, type IntelligenceRouter } from "./router.js";
import { admitBySpend, type SpendLedger, type SpendSettings } from "./spendAdmission.js";

export interface GenerateDeps {
  providers: ProviderRegistry;
  router: IntelligenceRouter;
  config: AppConfig;
  log: FastifyBaseLogger;
  metrics?: Metrics;
  /** Internal append-only attempt accounting. Persistence failure must never break a user request. */
  attemptLedger?: AttemptRecorder & SpendLedger;
  /** Internal kill switches and spend ceilings. Omitted keeps legacy/test callers unchanged. */
  spendSettings?: SpendSettings;
}

export interface GenerateRequest {
  task: TaskType;
  mode: AssistantMode;
  /** Task-specific instructions added after DASH AI's identity and mode instructions. */
  instructions: string;
  prompt: string;
  preference?: RoutePreference;
  signal?: AbortSignal;
  /** Internal accounting identity. Omitted callers get a fresh id and no user attribution. */
  inferenceId?: string;
  userId?: string | null;
}

export interface GenerateResult {
  content: string;
  /** Internal only (diagnostics, usage, cost); never shown to people. */
  provider: ProviderId;
  model: string;
  demo: boolean;
  usage: Usage;
  truncated: boolean;
}

/** Why a generation failed, as a normalized code; never provider text. */
export class GenerationError extends Error {
  constructor(
    readonly code: "unavailable" | "provider_error" | "provider_timeout" | "rate_limited" | "cancelled",
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
  const estimatedInputTokens = estimateTokens(request.prompt.length + request.instructions.length + 4_000);
  const decision = deps.router.route({
    task: request.task,
    mode: request.mode,
    preference: request.preference,
    estimatedInputTokens,
  });
  if (!decision.ok) {
    deps.metrics?.routerUnavailable.inc({ task: request.task, reason: decision.reason });
    throw new GenerationError("unavailable", decision.reason === "no_provider");
  }
  let adapters = decision.providers.map((p) => deps.providers.get(p)).filter((a): a is ProviderAdapter => a !== undefined);
  if (adapters.length === 0) throw new GenerationError("unavailable", true);

  if (deps.spendSettings) {
    if (!deps.attemptLedger) {
      deps.log.error({ task: request.task }, "spend settings configured without attempt ledger");
      throw new GenerationError("unavailable", false);
    }
    const admitted = await admitBySpend({
      ordered: adapters.map((a) => ({ provider: a.id, model: a.model, demo: a.demo })),
      settings: deps.spendSettings,
      ledger: deps.attemptLedger,
      policy: deps.config.routerPolicy,
      prices: deps.config.modelPrices,
      estimatedInputTokens,
      maxOutputTokens: deps.config.maxOutputTokens,
      userId: request.userId ?? null,
      nowIso: new Date().toISOString(),
    });
    if (admitted.rejected.length > 0) {
      deps.log.info({ task: request.task, rejected: admitted.rejected }, "spend admission filtered provider route");
    }
    const allowed = new Set(admitted.candidates.map((c) => c.provider));
    adapters = adapters.filter((a) => allowed.has(a.id));
    if (adapters.length === 0) {
      deps.metrics?.routerUnavailable.inc({ task: request.task, reason: "spend_control" });
      throw new GenerationError("unavailable", false);
    }
  }

  deps.metrics?.routerDecisions.inc({ task: request.task, provider: adapters[0]!.id });

  const inferenceId = request.inferenceId ?? newId();
  let last: ProviderError | undefined;
  for (const [fallbackIndex, adapter] of adapters.entries()) {
    try {
      return await generateWith(deps, adapter, request, estimatedInputTokens, inferenceId, fallbackIndex);
    } catch (err) {
      const error = err instanceof ProviderError ? err : toProviderError(adapter.displayName, err, request.signal);
      if (error.code === "cancelled") throw new GenerationError("cancelled", false);
      last = error;
      const next = adapters[fallbackIndex + 1];
      if (next) {
        deps.metrics?.providerFallbacks.inc({ from: adapter.id, to: next.id, code: error.code });
        deps.log.warn({ from: adapter.id, to: next.id, code: error.code, httpStatus: error.httpStatus, task: request.task }, "provider fallback");
      }
    }
  }
  const code = last?.code === "provider_timeout" || last?.code === "rate_limited" ? last.code : "provider_error";
  throw new GenerationError(code, last?.retryable ?? true);
}

async function recordAttempt(deps: GenerateDeps, attempt: InferenceAttempt): Promise<void> {
  if (!deps.attemptLedger) return;
  try {
    await deps.attemptLedger.record(attempt);
  } catch (err) {
    // Accounting availability must not turn a valid AI answer into a failed user request. Spend
    // enforcement fails closed at admission when spend settings are enabled and no ledger exists.
    deps.log.warn(
      { err, inferenceId: attempt.inferenceId, provider: attempt.provider, attemptIndex: attempt.attemptIndex, fallbackIndex: attempt.fallbackIndex },
      "could not record provider attempt",
    );
  }
}

async function generateWith(
  deps: GenerateDeps,
  adapter: ProviderAdapter,
  request: GenerateRequest,
  estimatedInputTokens: number,
  inferenceId: string,
  fallbackIndex: number,
): Promise<GenerateResult> {
  const { config } = deps;
  const system = [buildSystemPrompt(request.mode, adapter), request.instructions].join("\n\n");
  const providerStarted = Date.now();
  for (let attempt = 0; ; attempt++) {
    const attemptStarted = Date.now();
    const controller = new AbortController();
    const onAbort = () => controller.abort(request.signal?.reason ?? "cancelled");
    if (request.signal?.aborted) onAbort();
    else request.signal?.addEventListener("abort", onAbort, { once: true });
    const overall = setTimeout(() => controller.abort("timeout"), config.providerTimeoutMs);
    let content = "";
    let usage: Usage = { inputTokens: null, outputTokens: null };
    let finish: "stop" | "length" | "refusal" = "stop";
    let servedModel = adapter.model;
    try {
      const source = adapter.stream({
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
      });
      for await (const chunk of withIdleTimeout(source, config.providerIdleTimeoutMs, () => controller.abort("timeout"))) {
        if (chunk.type === "text") content += chunk.text;
        else if (chunk.type === "finish") {
          finish = chunk.finishReason;
          usage = chunk.usage;
          servedModel = chunk.servedModel ?? servedModel;
        }
      }
      if (content.trim() === "") throw new ProviderError("provider_error", `${adapter.displayName} returned an empty answer.`, true);
      const finishedAt = new Date();
      const estimatedCostUsd = estimateCostUsd(config.modelPrices, {
        provider: adapter.id,
        model: servedModel,
        demo: adapter.demo,
        usage,
      });
      await recordAttempt(deps, {
        id: newId(),
        inferenceId,
        userId: request.userId ?? null,
        task: request.task,
        provider: adapter.id,
        configuredModel: adapter.model,
        servedModel,
        attemptIndex: attempt,
        fallbackIndex,
        startedAt: new Date(attemptStarted).toISOString(),
        finishedAt: finishedAt.toISOString(),
        latencyMs: Math.max(0, finishedAt.getTime() - attemptStarted),
        status: "success",
        errorCode: null,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedTokens: null,
        usageSource: usage.inputTokens !== null || usage.outputTokens !== null ? "provider_reported" : "unknown",
        estimatedCostUsd,
        actualCostUsd: null,
        currency: "USD",
      });
      deps.router.recordSuccess(adapter.id, Date.now() - providerStarted);
      deps.metrics?.aiRequestSeconds.observe({ provider: adapter.id, status: "complete" }, (Date.now() - providerStarted) / 1000);
      if (servedModel !== adapter.model) {
        deps.log.info({ provider: adapter.id, configuredModel: adapter.model, servedModel, task: request.task }, "provider served a different model id");
      }
      return { content, provider: adapter.id, model: servedModel, demo: adapter.demo, usage, truncated: finish === "length" };
    } catch (err) {
      const error = toProviderError(adapter.displayName, err, controller.signal);
      const finishedAt = new Date();
      const estimatedCostUsd = estimateCostUsd(config.modelPrices, {
        provider: adapter.id,
        model: servedModel,
        demo: adapter.demo,
        usage,
      });
      await recordAttempt(deps, {
        id: newId(),
        inferenceId,
        userId: request.userId ?? null,
        task: request.task,
        provider: adapter.id,
        configuredModel: adapter.model,
        servedModel,
        attemptIndex: attempt,
        fallbackIndex,
        startedAt: new Date(attemptStarted).toISOString(),
        finishedAt: finishedAt.toISOString(),
        latencyMs: Math.max(0, finishedAt.getTime() - attemptStarted),
        status: error.code === "cancelled" ? "cancelled" : "failure",
        errorCode: error.code,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedTokens: null,
        usageSource: usage.inputTokens !== null || usage.outputTokens !== null ? "provider_reported" : "unknown",
        estimatedCostUsd,
        actualCostUsd: null,
        currency: "USD",
      });
      deps.router.recordFailure(adapter.id, error.code, error.retryable);
      if (error.code === "cancelled") throw error;
      deps.metrics?.providerFailures.inc({ provider: adapter.id, code: error.code, retryable: error.retryable });
      const delay = retryDelayMs(config.providerRetry, attempt, error);
      if (!error.retryable || attempt >= config.providerRetry.maxRetries) throw error;
      deps.metrics?.providerRetries.inc({ provider: adapter.id, code: error.code });
      deps.log.info({ provider: adapter.id, code: error.code, attempt: attempt + 1, delayMs: delay, task: request.task }, "retrying provider request");
      await new Promise((resolve) => setTimeout(resolve, delay));
    } finally {
      clearTimeout(overall);
      request.signal?.removeEventListener("abort", onAbort);
    }
  }
}
