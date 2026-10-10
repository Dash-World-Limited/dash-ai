import {
  LIMITS,
  providerHint,
  resolveProviders,
  type ChatStreamRequest,
  type MessageStatus,
  type StreamEvent,
  type Usage,
} from "@dash-ai/contracts";
import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "../config.js";
import { AppError } from "../errors.js";
import type { InferenceAttempt } from "../intelligence/attemptLedger.js";
import { estimateCostUsd } from "../intelligence/cost.js";
import { estimateTokens, type IntelligenceRouter } from "../intelligence/router.js";
import type { Metrics } from "../observability/metrics.js";
import { buildProviderMessages } from "../providers/context.js";
import { buildSystemPrompt } from "../providers/instructions.js";
import type { ProviderRegistry } from "../providers/registry.js";
import {
  failoverAllowed,
  toProviderError,
  type ProviderAdapter,
  type ProviderToolResult,
  type ProviderTurn,
} from "../providers/types.js";
import { newId } from "../security/crypto.js";
import type { ConversationRecord, DocumentRecord, Store } from "../store/store.js";
import { DUPLICATE_TEXT } from "../tools/executor.js";
import { OfferedTools } from "../tools/registry.js";
import type { ToolRuntime } from "../tools/runtime.js";
import type { ModelToolCall } from "../tools/types.js";
import { hideProviders, neutralErrorMessage, NEUTRAL_ROUTING_REASON, NEUTRAL_UNAVAILABLE } from "./publicSurface.js";
import { withIdleTimeout } from "./timeouts.js";
import { DEFAULT_TITLE, generateTitle } from "./titles.js";

export interface SseSink {
  send(event: StreamEvent): void;
  comment(text: string): void;
  readonly open: boolean;
}

export interface ChatContext {
  store: Store;
  providers: ProviderRegistry;
  router: IntelligenceRouter;
  /** Internal append-only provider-attempt accounting; never returned to consumers. */
  attemptLedger: { record(attempt: InferenceAttempt): Promise<void> | void };
  tools: ToolRuntime;
  config: AppConfig;
  log: FastifyBaseLogger;
  now: () => Date;
  metrics?: Metrics;
}

/** A model may ask for many calls in one step; beyond this they are refused, not run. */
export const MAX_TOOL_CALLS_PER_ROUND = 8;
const SAFE_CALL_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

export interface PreparedTarget {
  adapter: ProviderAdapter;
  messageId: string;
  /**
   * Other providers DASH AI may route to, in order, if this one fails before producing anything
   * (no text sent, no tool run). Only for DASH AI routing ("smart"); explicit diagnostic routes have none.
   */
  fallbacks: ProviderAdapter[];
}

export interface PreparedChat {
  userId: string;
  request: ChatStreamRequest;
  conversation: ConversationRecord;
  targets: PreparedTarget[];
  routingReason: string;
  compareGroupId: string | null;
  documents: DocumentRecord[];
  /** Tools this user has enabled and granted. Empty when none (the usual case). */
  offered: OfferedTools;
}

/**
 * Validates everything that can fail before the event stream starts, so those failures are
 * returned as ordinary JSON errors with the right HTTP status.
 */
export async function prepareChat(ctx: ChatContext, userId: string, request: ChatStreamRequest): Promise<PreparedChat> {
  const historyChars = request.history.reduce((n, m) => n + m.content.length, 0);
  if (historyChars > LIMITS.maxHistoryChars) {
    throw new AppError("payload_too_large", "This conversation is too long to send. Start a new chat to continue.");
  }

  let conversation = await ctx.store.getConversation(userId, request.conversationId);
  if (!conversation && (await ctx.store.conversationExists(request.conversationId))) {
    // The id is taken. It may be this user's own new conversation, created a moment ago by a
    // concurrent first request (another server or a retried stream): read it again, by user.
    conversation = await ctx.store.getConversation(userId, request.conversationId);
    if (!conversation) throw new AppError("not_found", "Conversation not found.");
  }
  if (!conversation) {
    const now = ctx.now().toISOString();
    conversation = {
      id: request.conversationId,
      userId,
      title: DEFAULT_TITLE,
      titleIsCustom: false,
      mode: request.mode,
      createdAt: now,
      updatedAt: now,
    };
  }

  const documents: DocumentRecord[] = [];
  for (const id of new Set(request.message.attachmentIds)) {
    const doc = await ctx.store.getDocument(userId, id);
    if (!doc) throw new AppError("not_found", "An attached document was not found. It may have been deleted.");
    if (doc.status !== "ready") {
      throw new AppError("document_unreadable", `"${doc.name}" cannot be used yet: ${doc.statusDetail}`);
    }
    documents.push(doc);
  }

  const offered = await ctx.tools.offeredFor(userId);
  // Consumers never choose a provider: with provider details hidden every request is DASH AI routed.
  const hidden = hideProviders(ctx.config);
  const choice = hidden ? "smart" : request.modelChoice;
  const configured = ctx.providers.configured();
  let targets: PreparedTarget[];
  let routingReason: string;
  if (choice === "smart") {
    // The DASH Intelligence Router decides. A provider the person named in their own words is a
    // preference, applied silently when available.
    const inputChars =
      historyChars + request.message.content.length + documents.reduce((n, d) => n + d.extractedText.length, 0);
    const decision = ctx.router.route({
      task: "chat",
      mode: request.mode,
      hint: providerHint(request.message.content),
      estimatedInputTokens: estimateTokens(inputChars),
      requires: offered.size > 0 ? ["tool_use"] : [],
    });
    if (!decision.ok) {
      ctx.metrics?.routerUnavailable.inc({ task: "chat", reason: decision.reason });
      if (decision.reason === "context_too_large") {
        throw new AppError("payload_too_large", "This conversation and its documents are too long to answer. Start a new chat or attach fewer documents.");
      }
      throw new AppError("no_provider_available", hidden ? NEUTRAL_UNAVAILABLE : "No AI provider is configured on this server.");
    }
    const adapters = decision.providers.map((p) => ctx.providers.get(p)).filter((a): a is ProviderAdapter => a !== undefined);
    if (adapters.length === 0) throw new AppError("no_provider_available", hidden ? NEUTRAL_UNAVAILABLE : "No AI provider is configured on this server.");
    ctx.metrics?.routerDecisions.inc({ task: "chat", provider: adapters[0]!.id });
    ctx.log.debug({ routeKey: decision.routeKey, candidates: decision.candidates, rejected: decision.rejected }, "routing decision");
    targets = [{ adapter: adapters[0]!, messageId: newId(), fallbacks: adapters.slice(1) }];
    const legacy = resolveProviders("smart", request.mode, configured);
    routingReason = hidden
      ? NEUTRAL_ROUTING_REASON
      : legacy.ok && legacy.providers[0] === adapters[0]!.id
        ? legacy.reason
        : `DASH AI routed this request to ${adapters[0]!.displayName} (${decision.routeKey}).`;
  } else {
    const routing = resolveProviders(choice, request.mode, configured);
    if (!routing.ok) throw new AppError(routing.code, routing.message);
    targets = routing.providers.map((p) => {
      const adapter = ctx.providers.get(p);
      if (!adapter) throw new AppError("provider_not_configured", "The selected provider is not configured.");
      return { adapter, messageId: newId(), fallbacks: [] };
    });
    routingReason = routing.reason;
  }

  return {
    userId,
    request: { ...request, modelChoice: choice },
    conversation,
    targets,
    routingReason,
    compareGroupId: choice === "compare" ? request.message.id : null,
    documents,
    offered,
  };
}

export interface TargetOutcome {
  provider: string;
  status: MessageStatus;
  usage: Usage;
}

/** Streams the prepared chat to the sink. Never writes prompt or response text to logs. */
export async function runChat(
  ctx: ChatContext,
  prepared: PreparedChat,
  streamId: string,
  sink: SseSink,
  signal: AbortSignal,
): Promise<TargetOutcome[]> {
  const { request, conversation } = prepared;
  const iso = () => ctx.now().toISOString();

  // Mirror client-side edit/regenerate: re-sending a message replaces it and everything after it.
  await ctx.store.truncateMessagesFrom(conversation.id, request.message.id);
  conversation.mode = request.mode;
  conversation.updatedAt = iso();
  await ctx.store.saveConversation(conversation);
  await ctx.store.saveMessage({
    id: request.message.id,
    conversationId: conversation.id,
    role: "user",
    content: request.message.content,
    origin: null,
    model: null,
    demo: false,
    status: "complete",
    compareGroupId: null,
    attachmentIds: [...request.message.attachmentIds],
    createdAt: iso(),
  });

  sink.send({
    event: "stream.start",
    data: {
      streamId,
      conversationId: conversation.id,
      modelChoice: request.modelChoice,
      compareGroupId: prepared.compareGroupId,
      targets: prepared.targets.map((t) =>
        hideProviders(ctx.config)
          ? { messageId: t.messageId, demo: t.adapter.demo }
          : { messageId: t.messageId, provider: t.adapter.id, model: t.adapter.model, demo: t.adapter.demo },
      ),
      routingReason: prepared.routingReason,
    },
  });

  if (!conversation.titleIsCustom && conversation.title === DEFAULT_TITLE) {
    const title = generateTitle(request.message.content);
    if (title !== DEFAULT_TITLE) {
      conversation.title = title;
      await ctx.store.saveConversation(conversation);
      sink.send({ event: "conversation.title", data: { conversationId: conversation.id, title } });
    }
  }

  const outcomes = await Promise.all(prepared.targets.map((t) => runTarget(ctx, prepared, t, sink, signal)));

  conversation.updatedAt = iso();
  await ctx.store.saveConversation(conversation);
  sink.send({ event: "stream.end", data: { streamId } });
  return outcomes;
}

async function recordChatAttempt(ctx: ChatContext, attempt: InferenceAttempt): Promise<void> {
  try {
    await ctx.attemptLedger.record(attempt);
  } catch (err) {
    ctx.log.warn(
      { err, inferenceId: attempt.inferenceId, provider: attempt.provider, attemptIndex: attempt.attemptIndex, fallbackIndex: attempt.fallbackIndex },
      "could not record chat provider attempt",
    );
  }
}

async function runTarget(
  ctx: ChatContext,
  prepared: PreparedChat,
  target: PreparedTarget,
  sink: SseSink,
  parentSignal: AbortSignal,
): Promise<TargetOutcome> {
  const { messageId } = target;
  // DASH AI's route: the chosen provider first, then internal fallbacks (see PreparedTarget.fallbacks).
  const candidates = [target.adapter, ...target.fallbacks];
  let adapter = candidates[0]!;
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(parentSignal.reason ?? "cancelled");
  if (parentSignal.aborted) onParentAbort();
  else parentSignal.addEventListener("abort", onParentAbort, { once: true });
  const overall = setTimeout(() => controller.abort("timeout"), ctx.config.providerTimeoutMs);

  const started = Date.now();
  const seenCallIds = new Set<string>();
  let attempts = 0;
  let content = "";
  let status: MessageStatus = "complete";
  let usage: Usage = { inputTokens: null, outputTokens: null };
  /** The model id the provider reports for the answer kept (an adaptive provider picks one per request). */
  let served: string | undefined;
  // Internal hints for adapters that choose between models they own; the router already chose the provider.
  const routing = {
    task: "chat",
    mode: prepared.request.mode,
    estimatedInputTokens: estimateTokens(
      prepared.request.history.reduce((n, m) => n + m.content.length, 0) +
        prepared.request.message.content.length +
        prepared.documents.reduce((n, d) => n + d.extractedText.length, 0),
    ),
  };

  /** One complete answer from `provider`; throws on failure. Text and tool calls stream as they come. */
  const generate = async (provider: ProviderAdapter, fallbackIndex: number): Promise<"stop" | "length" | "refusal"> => {
    const adapter = provider;
    served = undefined;
    const turns: ProviderTurn[] = buildProviderMessages(
      adapter.id,
      prepared.request.history,
      prepared.request.message.content,
      prepared.documents,
    );
    const offered = prepared.offered;
    const system = buildSystemPrompt(prepared.request.mode, adapter, { toolsOffered: offered.size > 0 });
    let finishReason: "stop" | "length" | "refusal" = "stop";
    let servedModel: string | null | undefined;

    for (let round = 0; ; round++) {
      // A cancel or timeout during a tool call must end the response, not start another round.
      if (controller.signal.aborted) throw new Error("aborted");
      // The tool list stays identical every round (see ProviderRequest.toolChoice). On the last
      // allowed round tool use is switched off, so the model must answer with what it has.
      const tools = offered.size > 0 ? offered.list() : undefined;
      const toolUse = tools !== undefined && round < ctx.tools.maxRounds;
      let roundText = "";
      let calls: ModelToolCall[] = [];
      let continuation: unknown;
      let roundFinish: "stop" | "length" | "refusal" = "stop";
      // One provider request per attempt. A retryable failure before this attempt produced anything
      // is retried with backoff (see retryDelayMs); once output has reached the client, or a tool
      // has been requested, the failure is final: retrying would duplicate text or tool calls.
      // Tools from earlier rounds already ran and their results are in `turns`, so a retried
      // request never runs them again.
      for (let attempt = 0; ; attempt++) {
        const accountingAttemptIndex = attempts++;
        const attemptStarted = Date.now();
        const attemptController = new AbortController();
        const onTargetAbort = () => attemptController.abort(controller.signal.reason);
        if (controller.signal.aborted) onTargetAbort();
        else controller.signal.addEventListener("abort", onTargetAbort, { once: true });
        let produced = false;
        let attemptUsage: Usage = { inputTokens: null, outputTokens: null };
        let attemptServedModel = adapter.model;
        try {
          const source = adapter.stream({
            system,
            messages: turns,
            ...(tools ? { tools, toolChoice: toolUse ? ("auto" as const) : ("none" as const) } : {}),
            maxOutputTokens: ctx.config.maxOutputTokens,
            signal: attemptController.signal,
            routing,
          });
          for await (const chunk of withIdleTimeout(source, ctx.config.providerIdleTimeoutMs, () =>
            attemptController.abort("timeout"),
          )) {
            produced = true;
            if (chunk.type === "text") {
              if (roundText === "" && content !== "" && !/\s$/.test(content)) {
                content += "\n\n";
                sink.send({ event: "message.delta", data: { messageId, text: "\n\n" } });
              }
              content += chunk.text;
              roundText += chunk.text;
              sink.send({ event: "message.delta", data: { messageId, text: chunk.text } });
            } else if (chunk.type === "tool_calls") {
              calls = chunk.calls;
              continuation = chunk.continuation;
            } else {
              roundFinish = chunk.finishReason;
              attemptUsage = chunk.usage;
              usage = addUsage(usage, chunk.usage);
              attemptServedModel = chunk.servedModel ?? attemptServedModel;
              servedModel = chunk.servedModel ?? servedModel;
            }
          }
          const finished = Date.now();
          await recordChatAttempt(ctx, {
            id: newId(),
            inferenceId: messageId,
            userId: prepared.userId,
            task: "chat",
            provider: adapter.id,
            configuredModel: adapter.model,
            servedModel: attemptServedModel,
            attemptIndex: accountingAttemptIndex,
            fallbackIndex,
            startedAt: new Date(attemptStarted).toISOString(),
            finishedAt: new Date(finished).toISOString(),
            latencyMs: Math.max(0, finished - attemptStarted),
            status: "success",
            errorCode: null,
            inputTokens: attemptUsage.inputTokens,
            outputTokens: attemptUsage.outputTokens,
            cachedTokens: null,
            usageSource: attemptUsage.inputTokens !== null || attemptUsage.outputTokens !== null ? "provider_reported" : "unknown",
            estimatedCostUsd: estimateCostUsd(ctx.config.modelPrices, {
              provider: adapter.id,
              model: attemptServedModel,
              demo: adapter.demo,
              usage: attemptUsage,
            }),
            actualCostUsd: null,
            currency: "USD",
          });
          break;
        } catch (err) {
          const error = toProviderError(adapter.displayName, err, attemptController.signal);
          const finished = Date.now();
          await recordChatAttempt(ctx, {
            id: newId(),
            inferenceId: messageId,
            userId: prepared.userId,
            task: "chat",
            provider: adapter.id,
            configuredModel: adapter.model,
            servedModel: attemptServedModel,
            attemptIndex: accountingAttemptIndex,
            fallbackIndex,
            startedAt: new Date(attemptStarted).toISOString(),
            finishedAt: new Date(finished).toISOString(),
            latencyMs: Math.max(0, finished - attemptStarted),
            status: error.code === "cancelled" ? "cancelled" : "failure",
            errorCode: error.code,
            inputTokens: attemptUsage.inputTokens,
            outputTokens: attemptUsage.outputTokens,
            cachedTokens: null,
            usageSource: attemptUsage.inputTokens !== null || attemptUsage.outputTokens !== null ? "provider_reported" : "unknown",
            estimatedCostUsd: estimateCostUsd(ctx.config.modelPrices, {
              provider: adapter.id,
              model: attemptServedModel,
              demo: adapter.demo,
              usage: attemptUsage,
            }),
            actualCostUsd: null,
            currency: "USD",
          });
          // The target's own abort (user cancel, overall timeout) is never retried.
          if (controller.signal.aborted) throw err;
          ctx.metrics?.providerFailures.inc({ provider: adapter.id, code: error.code, retryable: error.retryable });
          const delay = retryDelayMs(ctx.config.providerRetry, attempt, error);
          const remaining = ctx.config.providerTimeoutMs - (Date.now() - started);
          if (produced || !error.retryable || attempt >= ctx.config.providerRetry.maxRetries || delay >= remaining) {
            throw error;
          }
          ctx.metrics?.providerRetries.inc({ provider: adapter.id, code: error.code });
          ctx.log.info({ provider: adapter.id, code: error.code, attempt: attempt + 1, delayMs: delay }, "retrying provider request");
          await sleep(delay, controller.signal);
        } finally {
          controller.signal.removeEventListener("abort", onTargetAbort);
        }
      }
      finishReason = roundFinish;
      if (calls.length === 0) break;
      if (!toolUse || roundFinish !== "stop") {
        // Tool requests when tool use was off, or from a cut-off answer, are never acted on.
        ctx.log.warn({ provider: adapter.id, calls: calls.length, offered: toolUse }, "ignored tool calls");
        break;
      }

      const results = await runToolCalls(ctx, prepared, { ...target, adapter }, calls, controller.signal, sink, seenCallIds);
      // `turns` belongs to this target alone, so a continuation only ever goes back to its own provider.
      turns.push(
        { role: "assistant", content: roundText, toolCalls: calls, ...(continuation !== undefined ? { continuation } : {}) },
        { role: "tool", results },
      );
    }
    if (servedModel && servedModel !== adapter.model) {
      ctx.log.info({ provider: adapter.id, configuredModel: adapter.model, servedModel }, "provider served a different model id");
    }
    served = servedModel ?? undefined;
    return finishReason;
  };

  try {
    let finishReason: "stop" | "length" | "refusal" = "stop";
    for (let c = 0; ; c++) {
      adapter = candidates[c]!;
      const attemptStarted = Date.now();
      try {
        finishReason = await generate(adapter, c);
        ctx.router.recordSuccess(adapter.id, Date.now() - attemptStarted);
        break;
      } catch (err) {
        const error = toProviderError(adapter.displayName, err, controller.signal);
        // Health learns from provider failures (timeouts included); a person's cancel is ignored.
        ctx.router.recordFailure(adapter.id, error.code, error.retryable);
        if (controller.signal.aborted) throw err;
        const next = candidates[c + 1];
        // Safe only while nothing reached the person and no tool ran: the next provider starts clean.
        if (!next || content !== "" || seenCallIds.size > 0 || !failoverAllowed(error)) throw err;
        ctx.metrics?.providerFallbacks?.inc({ from: adapter.id, to: next.id, code: error.code });
        ctx.log.warn({ from: adapter.id, to: next.id, code: error.code, httpStatus: error.httpStatus, attempts }, "provider fallback");
      }
    }
    sink.send({ event: "message.end", data: { messageId, finishReason, usage } });
  } catch (err) {
    const error = toProviderError(adapter.displayName, err, controller.signal);
    if (error.code === "cancelled") {
      status = "stopped";
      sink.send({
        event: "message.end",
        data: { messageId, finishReason: "cancelled", usage: { inputTokens: null, outputTokens: null } },
      });
    } else {
      status = "failed";
      // Metadata only: never the prompt, the partial answer, tool payloads or provider error text.
      ctx.log.warn(
        { provider: adapter.id, code: error.code, httpStatus: error.httpStatus, demo: adapter.demo, attempts, partial: content.length > 0 },
        "provider stream failed",
      );
      // DASH AI already tried every safe route. Consumers get a neutral message and Retry; the
      // provider's own wording (and which provider failed) stays in the log above.
      const hidden = hideProviders(ctx.config);
      const alternatives = hidden ? [] : [...ctx.providers.configured()].filter((p) => p !== adapter.id);
      sink.send({
        event: "message.error",
        data: {
          messageId,
          error: { code: error.code, message: hidden ? neutralErrorMessage(error.code) : error.message, retryable: error.retryable },
          recovery: { attempts: Math.max(1, attempts), alternatives },
        },
      });
    }
  } finally {
    clearTimeout(overall);
    parentSignal.removeEventListener("abort", onParentAbort);
  }

  ctx.metrics?.aiRequestSeconds.observe({ provider: adapter.id, status }, (Date.now() - started) / 1000);
  const now = ctx.now().toISOString();
  const model = served ?? adapter.model;
  const estimatedCostUsd = estimateCostUsd(ctx.config.modelPrices, { provider: adapter.id, model, demo: adapter.demo, usage });
  if (estimatedCostUsd) ctx.metrics?.estimatedCostUsd.inc({ provider: adapter.id }, estimatedCostUsd);
  await ctx.store.saveMessage({
    id: messageId,
    conversationId: prepared.conversation.id,
    role: "assistant",
    content,
    origin: adapter.id,
    model,
    demo: adapter.demo,
    status,
    compareGroupId: prepared.compareGroupId,
    attachmentIds: [],
    createdAt: now,
  });
  await ctx.store.recordUsage({
    userId: prepared.userId,
    conversationId: prepared.conversation.id,
    messageId,
    provider: adapter.id,
    model,
    demo: adapter.demo,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    estimatedCostUsd,
    createdAt: now,
  });
  return { provider: adapter.id, status, usage };
}

/**
 * Backoff before retry number `attempt + 1`: base × 2^attempt, four times longer after rate
 * limiting, ±20 % jitter so instances do not retry in lockstep, capped at 8 s.
 */
export function retryDelayMs(policy: { baseMs: number }, attempt: number, error: { code: string }, random: () => number = Math.random): number {
  const factor = error.code === "rate_limited" ? 4 : 1;
  const raw = policy.baseMs * factor * 2 ** attempt;
  return Math.min(8_000, Math.round(raw * (0.8 + 0.4 * random())));
}

/** Resolves after `ms`, or rejects as soon as `signal` aborts (a cancel during backoff is immediate). */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const addUsage = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens === null && b.inputTokens === null ? null : (a.inputTokens ?? 0) + (b.inputTokens ?? 0),
  outputTokens: a.outputTokens === null && b.outputTokens === null ? null : (a.outputTokens ?? 0) + (b.outputTokens ?? 0),
});

/**
 * Runs one round of model-requested tool calls through the backend tool layer, one at a time and
 * in the order requested. Every call gets a result (the providers require it) and an audit row.
 */
async function runToolCalls(
  ctx: ChatContext,
  prepared: PreparedChat,
  target: PreparedTarget,
  calls: readonly ModelToolCall[],
  signal: AbortSignal,
  sink: SseSink,
  /** Call ids already handled in this response (any round). A repeated id is never run again. */
  seenCallIds: Set<string>,
): Promise<ProviderToolResult[]> {
  const { adapter, messageId } = target;
  const results: ProviderToolResult[] = [];
  // Permissions are checked again at the moment of invocation, not only when the response started:
  // a plugin disabled, a scope revoked or TOOLS_ENABLED switched off mid-response takes effect at the
  // next round. If the current permissions cannot be read, nothing runs (fail closed).
  let allowed: OfferedTools;
  try {
    allowed = prepared.offered.intersect(await ctx.tools.offeredFor(prepared.userId));
  } catch (err) {
    ctx.log.warn({ err }, "could not re-check tool permissions; refusing this round");
    allowed = OfferedTools.none;
  }
  for (const [index, call] of calls.entries()) {
    const overLimit = index >= MAX_TOOL_CALLS_PER_ROUND;
    // Call ids come from the provider. The original is replayed to that provider, but only a bounded,
    // plain id ever reaches clients (SSE) or the audit log.
    const callId = SAFE_CALL_ID.test(call.id) ? call.id : `call_${index + 1}`;
    const label = /^([a-z][a-z0-9-]{1,31})__([a-z][a-z0-9_]{1,47})$/.exec(call.name);
    const plugin = label?.[1] ?? "unknown";
    const tool = label?.[2] ?? "unknown";
    sink.send({ event: "tool.call", data: { messageId, callId, plugin, tool } });
    const repeated = seenCallIds.has(call.id);
    seenCallIds.add(call.id);
    const notRun = (status: "denied" | "duplicate", content: string) => ({
      callId: call.id, name: call.name, plugin, tool, status, isError: status !== "duplicate", durationMs: 0,
      argBytes: Buffer.byteLength(call.argumentsJson, "utf8"), content,
    });
    const execution = repeated
      ? notRun("duplicate", DUPLICATE_TEXT.callId)
      : overLimit
      ? notRun("denied", "Too many tool calls were requested in one step; this one was not run.")
      : await ctx.tools.executor.execute(call, allowed, {
          userId: prepared.userId,
          conversationId: prepared.conversation.id,
          messageId,
          turnId: prepared.request.message.id,
          provider: adapter.id,
          signal,
          now: ctx.now,
          log: ctx.log,
        });
    sink.send({
      event: "tool.result",
      data: { messageId, callId, plugin: execution.plugin, tool: execution.tool, status: execution.status, durationMs: execution.durationMs },
    });
    ctx.metrics?.toolInvocations.inc({ plugin: execution.plugin, tool: execution.tool, status: execution.status });
    // Metadata only (no arguments, no results), for the user's own tool-activity view and export.
    ctx.log.info(
      { provider: adapter.id, plugin: execution.plugin, tool: execution.tool, status: execution.status, durationMs: execution.durationMs },
      "tool call finished",
    );
    try {
      await ctx.store.recordToolInvocation({
        userId: prepared.userId,
        conversationId: prepared.conversation.id,
        messageId,
        callId,
        provider: adapter.id,
        plugin: execution.plugin,
        tool: execution.tool,
        status: execution.status,
        durationMs: execution.durationMs,
        argBytes: execution.argBytes,
        resultChars: execution.content.length,
        createdAt: ctx.now().toISOString(),
      });
    } catch (err) {
      ctx.log.warn({ err }, "could not record tool audit row");
    }
    results.push({ callId: call.id, name: call.name, content: execution.content, isError: execution.isError });
  }
  return results;
}
