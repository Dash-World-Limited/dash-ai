import type { AssistantMode, ProviderId, Usage } from "@dash-ai/contracts";
import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "../config.js";
import { retryDelayMs } from "../chat/orchestrator.js";
import { withIdleTimeout } from "../chat/timeouts.js";
import type { Metrics } from "../observability/metrics.js";
import { buildSystemPrompt } from "../providers/instructions.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { ProviderError, toProviderError, type ProviderAdapter } from "../providers/types.js";
import type { RoutePreference, TaskType } from "./policy.js";
import { estimateTokens, type IntelligenceRouter } from "./router.js";

export interface GenerateDeps {
  providers: ProviderRegistry;
  router: IntelligenceRouter;
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
  const decision = deps.router.route({
    task: request.task,
    mode: request.mode,
    preference: request.preference,
    estimatedInputTokens: estimateTokens(request.prompt.length + request.instructions.length + 4_000),
  });
  if (!decision.ok) {
    deps.metrics?.routerUnavailable.inc({ task: request.task, reason: decision.reason });
    throw new GenerationError("unavailable", decision.reason === "no_provider");
  }
  const adapters = decision.providers.map((p) => deps.providers.get(p)).filter((a): a is ProviderAdapter => a !== undefined);
  if (adapters.length === 0) throw new GenerationError("unavailable", true);
  deps.metrics?.routerDecisions.inc({ task: request.task, provider: adapters[0]!.id });

  let last: ProviderError | undefined;
  for (const [index, adapter] of adapters.entries()) {
    try {
      return await generateWith(deps, adapter, request);
    } catch (err) {
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
  const code = last?.code === "provider_timeout" || last?.code === "rate_limited" ? last.code : "provider_error";
  throw new GenerationError(code, last?.retryable ?? true);
}

async function generateWith(deps: GenerateDeps, adapter: ProviderAdapter, request: GenerateRequest): Promise<GenerateResult> {
  const { config } = deps;
  const system = [buildSystemPrompt(request.mode, adapter), request.instructions].join("\n\n");
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(request.signal?.reason ?? "cancelled");
    if (request.signal?.aborted) onAbort();
    else request.signal?.addEventListener("abort", onAbort, { once: true });
    const overall = setTimeout(() => controller.abort("timeout"), config.providerTimeoutMs);
    let content = "";
    let usage: Usage = { inputTokens: null, outputTokens: null };
    let finish: "stop" | "length" | "refusal" = "stop";
    try {
      const source = adapter.stream({
        system,
        messages: [{ role: "user", content: request.prompt }],
        maxOutputTokens: config.maxOutputTokens,
        signal: controller.signal,
      });
      for await (const chunk of withIdleTimeout(source, config.providerIdleTimeoutMs, () => controller.abort("timeout"))) {
        if (chunk.type === "text") content += chunk.text;
        else if (chunk.type === "finish") {
          finish = chunk.finishReason;
          usage = chunk.usage;
        }
      }
      if (content.trim() === "") throw new ProviderError("provider_error", `${adapter.displayName} returned an empty answer.`, true);
      deps.router.recordSuccess(adapter.id, Date.now() - started);
      deps.metrics?.aiRequestSeconds.observe({ provider: adapter.id, status: "complete" }, (Date.now() - started) / 1000);
      return { content, provider: adapter.id, model: adapter.model, demo: adapter.demo, usage, truncated: finish === "length" };
    } catch (err) {
      const error = toProviderError(adapter.displayName, err, controller.signal);
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
