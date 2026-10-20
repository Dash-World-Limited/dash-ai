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
import { buildProviderMessages } from "../providers/context.js";
import { buildSystemPrompt } from "../providers/instructions.js";
import type { ProviderRegistry } from "../providers/registry.js";
import {
  failoverAllowed,
  toProviderError,
  type ProviderChunk,
  type ProviderError,
  type ProviderRequest,
  type ProviderAdapter,
  type ProviderToolResult,
  type ProviderTurn,
} from "../providers/types.js";
import { newId } from "../security/crypto.js";
import type { ConversationRecord, DocumentRecord, SpendReservationRecord, Store } from "../store/store.js";
import { OfferedTools } from "../tools/registry.js";
import { DUPLICATE_TEXT } from "../tools/executor.js";
import type { ToolRuntime } from "../tools/runtime.js";
import type { ModelToolCall } from "../tools/types.js";
import type { Metrics } from "../observability/metrics.js";
import { estimateAnswerCostUsd } from "../intelligence/cost.js";
import { estimateTokens, type IntelligenceRouter, type RouteDecision } from "../intelligence/router.js";
import { estimateTokensForLedger, requestChars, type InferenceContext } from "../intelligence/ledger.js";
import { SpendAdmissionError, type AiPlatform, type Refusal } from "../intelligence/platform.js";
import type { Sensitivity } from "../intelligence/policy.js";
import type { ToolLoop } from "../intelligence/worstCase.js";
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
  ai: AiPlatform;
  tools: ToolRuntime;
  config: AppConfig;
  log: FastifyBaseLogger;
  now: () => Date;
  metrics?: Metrics;
}

/** A model may ask for many calls in one step; beyond this they are refused, not run. */
export const MAX_TOOL_CALLS_PER_ROUND = 8;

/**
 * The most tool-result characters one round can add to the next request: every call that may run, at
 * its result bound plus room for its name and a truncation note. Calls beyond the limit get short
 * refusals; a round that still grows past its budget is answered without tools (see runChat).
 */
export const toolResultCharsPerRound = (maxResultChars: number): number => MAX_TOOL_CALLS_PER_ROUND * (maxResultChars + 200);
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
  /** The account plan and the request's sensitivity (they decided which providers were eligible). */
  plan: string;
  sensitivity: Sensitivity;
  /** Routing metadata recorded with every ledger attempt (internal; never content). */
  route: Record<string, unknown>;
  /**
   * What a paid provider was admitted on under a spend limit or ceiling (DASH AI routing only): the
   * first request's estimated input tokens and the tool loop. Each provider request of the answer is
   * then held to its round's input budget (see AiPlatform.inputBudgets). Null when nothing is bounded.
   */
  costBudget: { firstInputTokens: number; loop: ToolLoop | null } | null;
  /**
   * The in-flight spend hold taken at admission (ADR 0015), settled by runChat when the answer ends.
   * Null when no aggregate spend limit or no paid provider applies.
   */
  reservation: SpendReservationRecord | null;
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
  if (!ctx.config.ai.enabled) {
    throw new AppError("no_provider_available", hidden ? NEUTRAL_UNAVAILABLE : "AI is switched off on this server (AI_ENABLED=false).");
  }
  const choice = hidden ? "smart" : request.modelChoice;
  const configured = ctx.providers.configured();
  const plan = ctx.ai.plan;
  const sensitivity = ctx.ai.classify({ documents: documents.length, toolsOffered: offered.size > 0 });
  let targets: PreparedTarget[];
  let routingReason: string;
  let costBudget: PreparedChat["costBudget"] = null;
  let route: Record<string, unknown>;
  let reservation: SpendReservationRecord | null = null;
  if (choice === "smart") {
    // The DASH Intelligence Router decides. A provider the person named in their own words is a
    // preference, applied silently when available.
    const inputChars =
      historyChars + request.message.content.length + documents.reduce((n, d) => n + d.extractedText.length, 0);
    // The first provider request exactly as it will be sent (documents rendered, history trimmed; the
    // turns are the same for every provider), and never less than the plain estimate above.
    const firstInputChars =
      Math.max(inputChars, requestChars({ system: "", messages: buildProviderMessages("dash", request.history, request.message.content, documents) })) +
      requestChars({
        system: buildSystemPrompt(request.mode, undefined, { toolsOffered: offered.size > 0 }),
        messages: [],
        ...(offered.size > 0 ? { tools: offered.list() } : {}),
      });
    const loop: ToolLoop | null =
      offered.size > 0 ? { toolRounds: ctx.tools.maxRounds, resultCharsPerRound: toolResultCharsPerRound(ctx.tools.maxResultChars) } : null;
    const messageId = newId();
    let admission;
    try {
      // Routed on the spend estimate, then the worst case is held atomically against every spend limit
      // (requests already in flight included) before anything is sent; see ADR 0015.
      admission = await ctx.ai.admitAndReserve({
        userId,
        inferenceId: messageId,
        task: "chat",
        // The answer's own abort (runTarget) ends every provider request by then.
        maxDurationMs: ctx.config.providerTimeoutMs,
        inputChars: firstInputChars,
        loop,
        route: (costFields) =>
          ctx.router.route({
            task: "chat",
            mode: request.mode,
            hint: providerHint(request.message.content),
            estimatedInputTokens: estimateTokens(inputChars),
            requires: offered.size > 0 ? ["tool_use"] : [],
            sensitivity,
            plan,
            inputModalities: ["text"],
            // Cost limits compare against everything sent (system prompt and tool schemas included), for
            // every provider request a tool-using answer may make (its tool rounds, then a final answer).
            ...costFields,
          }),
      });
    } catch (err) {
      if (err instanceof SpendAdmissionError) throw refusalError({ kind: "busy" }, hidden, "spend_admission");
      throw err;
    }
    const { decision, spend } = admission;
    reservation = admission.reservation;
    costBudget = ctx.ai.costBounded(spend) ? { firstInputTokens: estimateTokensForLedger(firstInputChars), loop } : null;
    ctx.ai.noteSpendLimit(decision, spend);
    if (!decision.ok) {
      ctx.metrics?.routerUnavailable.inc({ task: "chat", reason: decision.reason });
      ctx.log.info({ reason: decision.reason, rejected: decision.rejected, spend: spend.blockedBy }, "no provider for this request");
      throw refusalError(ctx.ai.refusal(decision, spend), hidden, decision.reason);
    }
    const adapters = decision.providers.map((p) => ctx.providers.get(p)).filter((a): a is ProviderAdapter => a !== undefined);
    if (adapters.length === 0) {
      await ctx.ai.settle(reservation);
      throw new AppError("no_provider_available", hidden ? NEUTRAL_UNAVAILABLE : "No AI provider is configured on this server.");
    }
    ctx.metrics?.routerDecisions.inc({ task: "chat", provider: adapters[0]!.id });
    ctx.log.debug({ routeKey: decision.routeKey, candidates: decision.candidates, rejected: decision.rejected }, "routing decision");
    targets = [{ adapter: adapters[0]!, messageId, fallbacks: adapters.slice(1) }];
    route = routeMetadata(decision, sensitivity, spend.blockedBy);
    const legacy = resolveProviders("smart", request.mode, configured);
    routingReason = hidden
      ? NEUTRAL_ROUTING_REASON
      : legacy.ok && legacy.providers[0] === adapters[0]!.id
        ? legacy.reason
        : `DASH AI routed this request to ${adapters[0]!.displayName} (${decision.routeKey}).`;
  } else {
    // Engineering routes (PROVIDER_DETAILS=exposed only, refused in production): a limit already
    // reached still applies; they are not reserved (see ADR 0015).
    const spend = await ctx.ai.admit(userId);
    const routing = resolveProviders(choice, request.mode, configured);
    if (!routing.ok) throw new AppError(routing.code, routing.message);
    targets = routing.providers.map((p) => {
      const adapter = ctx.providers.get(p);
      if (!adapter) throw new AppError("provider_not_configured", "The selected provider is not configured.");
      if (!adapter.demo && !spend.paidAllowed) throw new AppError("rate_limited", `A spend limit (${spend.blockedBy}) stops paid providers.`, { retryable: false });
      return { adapter, messageId: newId(), fallbacks: [] };
    });
    routingReason = routing.reason;
    route = { routeKey: `explicit:${choice}`, order: routing.providers, sensitivity };
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
    plan,
    sensitivity,
    route,
    costBudget,
    reservation,
  };
}

/** Internal routing metadata for the ledger: order, rejections and why. No content. */
function routeMetadata(decision: Extract<RouteDecision, { ok: true }>, sensitivity: Sensitivity, spendBlockedBy: string | null): Record<string, unknown> {
  return {
    routeKey: decision.routeKey,
    order: decision.providers,
    candidates: decision.candidates.map((c) => ({ provider: c.provider, score: c.score, pricing: c.pricing, freePreferred: c.freePreferred, circuitOpen: c.circuitOpen, quota: c.quota })),
    rejected: decision.rejected.filter((r) => r.reason !== "not_configured"),
    sensitivity,
    spendBlockedBy,
  };
}

/** A request nobody may serve → an error in DASH AI's own words (details only in engineering mode). */
function refusalError(refusal: Refusal, hidden: boolean, reason: string): AppError {
  switch (refusal.kind) {
    case "context_too_large":
      return new AppError("payload_too_large", "This conversation and its documents are too long to answer. Start a new chat or attach fewer documents.");
    case "too_large":
      return new AppError("payload_too_large", "This request is too large for DASH AI right now. Try a shorter message or fewer documents.");
    case "user_limit":
      return new AppError("rate_limited", "You've reached today's DASH AI usage limit. Please try again tomorrow.", { retryable: false });
    case "busy":
      return new AppError("rate_limited", "DASH AI is very busy right now. Please try again in a moment.");
    default:
      return new AppError("no_provider_available", hidden ? NEUTRAL_UNAVAILABLE : `No AI provider may serve this request (${reason}).`);
  }
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
  try {
    return await streamChat(ctx, prepared, streamId, sink, signal);
  } finally {
    // After every attempt of the answer is in the ledger, whatever the outcome (ADR 0015).
    await ctx.ai.settle(prepared.reservation);
  }
}

async function streamChat(
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

  // Every provider attempt (retries, tool rounds, fallbacks) goes to the inference ledger.
  const inference: InferenceContext = {
    inferenceId: messageId,
    userId: prepared.userId,
    plan: prepared.plan,
    task: "chat",
    mode: prepared.request.mode,
    route: prepared.route,
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
    // A paid provider admitted on its worst case is held to it: no request of this answer may send
    // more than its round's input budget (null: nothing to enforce).
    const budgets =
      prepared.costBudget && ctx.ai.isPaid(adapter.id)
        ? ctx.ai.inputBudgets(adapter.id, prepared.costBudget.firstInputTokens, prepared.costBudget.loop)
        : null;

    for (let round = 0; ; round++) {
      // A cancel or timeout during a tool call must end the response, not start another round.
      if (controller.signal.aborted) throw new Error("aborted");
      // The tool list stays identical every round (see ProviderRequest.toolChoice). On the last
      // allowed round tool use is switched off, so the model must answer with what it has.
      const tools = offered.size > 0 ? offered.list() : undefined;
      let toolUse = tools !== undefined && round < ctx.tools.maxRounds;
      if (budgets) {
        const sending = estimateTokensForLedger(requestChars({ system, messages: turns, ...(tools ? { tools } : {}) }));
        const budget = budgets[Math.min(round, budgets.length - 1)]!;
        if (sending > budget) {
          // Tool results grew past what was admitted. If the final answer's budget still covers this
          // request, answer now without tools (the answer then makes fewer requests than admitted);
          // otherwise stop here rather than spend past the reservation.
          if (sending > budgets[budgets.length - 1]!) {
            ctx.log.warn({ provider: adapter.id, round, sending, budget }, "answer stopped at its spend reservation");
            finishReason = "length";
            break;
          }
          ctx.log.info({ provider: adapter.id, round, sending, budget }, "final answer early: tool results reached the spend reservation");
          toolUse = false;
        }
      }
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
        attempts += 1;
        const attemptController = new AbortController();
        const onTargetAbort = () => attemptController.abort(controller.signal.reason);
        if (controller.signal.aborted) onTargetAbort();
        else controller.signal.addEventListener("abort", onTargetAbort, { once: true });
        let produced = false;
        const attemptStarted = Date.now();
        let attemptChars = 0;
        let attemptFinish: Extract<ProviderChunk, { type: "finish" }> | undefined;
        const providerRequest: ProviderRequest = {
          system,
          messages: turns,
          ...(tools ? { tools, toolChoice: toolUse ? ("auto" as const) : ("none" as const) } : {}),
          maxOutputTokens: ctx.config.maxOutputTokens,
          signal: attemptController.signal,
          routing,
        };
        const report = (error?: ProviderError) =>
          ctx.ai.attempts.record(inference, {
            adapter,
            fallbackIndex,
            round,
            retry: attempt,
            startedAt: attemptStarted,
            endedAt: Date.now(),
            requestChars: requestChars(providerRequest),
            outputChars: attemptChars,
            finish: attemptFinish,
            error,
          });
        try {
          const source = adapter.stream(providerRequest);
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
              attemptChars += chunk.text.length;
              sink.send({ event: "message.delta", data: { messageId, text: chunk.text } });
            } else if (chunk.type === "tool_calls") {
              calls = chunk.calls;
              continuation = chunk.continuation;
            } else {
              roundFinish = chunk.finishReason;
              usage = addUsage(usage, chunk.usage);
              servedModel = chunk.servedModel ?? servedModel;
              attemptFinish = chunk;
            }
          }
          await report();
          break;
        } catch (err) {
          const error = toProviderError(adapter.displayName, err, attemptController.signal);
          await report(error);
          // The target's own abort (user cancel, overall timeout) is never retried.
          if (controller.signal.aborted) throw err;
          ctx.metrics?.providerFailures.inc({ provider: adapter.id, code: error.code, retryable: error.retryable });
          // A provider that asked for a longer wait than the backoff gets it, or is not retried at all.
          const delay = Math.max(retryDelayMs(ctx.config.providerRetry, attempt, error), error.retryAfterMs ?? 0);
          const remaining = ctx.config.providerTimeoutMs - (Date.now() - started);
          const paused = ctx.ai.quota.status(adapter.id).state === "paused";
          if (produced || !error.retryable || error.quotaExhausted || paused || attempt >= ctx.config.providerRetry.maxRetries || delay >= remaining) {
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
  const estimatedCostUsd = estimateAnswerCostUsd(ctx.config.modelPrices, { provider: adapter.id, servedModel: model, configuredModel: adapter.model, demo: adapter.demo, usage });
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
