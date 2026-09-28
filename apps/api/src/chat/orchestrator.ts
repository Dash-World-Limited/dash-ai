import {
  LIMITS,
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
import { toProviderError, type ProviderAdapter } from "../providers/types.js";
import { newId } from "../security/crypto.js";
import type { ConversationRecord, DocumentRecord, Store } from "../store/store.js";
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
  config: AppConfig;
  log: FastifyBaseLogger;
  now: () => Date;
}

export interface PreparedTarget {
  adapter: ProviderAdapter;
  messageId: string;
}

export interface PreparedChat {
  userId: string;
  request: ChatStreamRequest;
  conversation: ConversationRecord;
  targets: PreparedTarget[];
  routingReason: string;
  compareGroupId: string | null;
  documents: DocumentRecord[];
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
  if (!conversation) {
    if (await ctx.store.conversationExists(request.conversationId)) {
      throw new AppError("not_found", "Conversation not found.");
    }
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

  const routing = resolveProviders(request.modelChoice, request.mode, ctx.providers.configured());
  if (!routing.ok) throw new AppError(routing.code, routing.message);

  const targets = routing.providers.map((p) => {
    const adapter = ctx.providers.get(p);
    if (!adapter) throw new AppError("provider_not_configured", "The selected provider is not configured.");
    return { adapter, messageId: newId() };
  });

  return {
    userId,
    request,
    conversation,
    targets,
    routingReason: routing.reason,
    compareGroupId: request.modelChoice === "compare" ? request.message.id : null,
    documents,
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
      targets: prepared.targets.map((t) => ({
        messageId: t.messageId,
        provider: t.adapter.id,
        model: t.adapter.model,
        demo: t.adapter.demo,
      })),
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
  const { adapter, messageId } = target;
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(parentSignal.reason ?? "cancelled");
  if (parentSignal.aborted) onParentAbort();
  else parentSignal.addEventListener("abort", onParentAbort, { once: true });
  const overall = setTimeout(() => controller.abort("timeout"), ctx.config.providerTimeoutMs);

  let content = "";
  let status: MessageStatus = "complete";
  let usage: Usage = { inputTokens: null, outputTokens: null };

  try {
    const messages = buildProviderMessages(
      adapter.id,
      prepared.request.history,
      prepared.request.message.content,
      prepared.documents,
    );
    const source = adapter.stream({
      system: buildSystemPrompt(prepared.request.mode, adapter),
      messages,
      maxOutputTokens: ctx.config.maxOutputTokens,
      signal: controller.signal,
    });
    let finishReason: "stop" | "length" | "refusal" = "stop";
    for await (const chunk of withIdleTimeout(source, ctx.config.providerIdleTimeoutMs, () =>
      controller.abort("timeout"),
    )) {
      if (chunk.type === "text") {
        content += chunk.text;
        sink.send({ event: "message.delta", data: { messageId, text: chunk.text } });
      } else {
        finishReason = chunk.finishReason;
        usage = chunk.usage;
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
      ctx.log.warn(
        { provider: adapter.id, code: error.code, httpStatus: error.httpStatus, demo: adapter.demo },
        "provider stream failed",
      );
      sink.send({
        event: "message.error",
        data: { messageId, error: { code: error.code, message: error.message, retryable: error.retryable } },
      });
    }
  } finally {
    clearTimeout(overall);
    parentSignal.removeEventListener("abort", onParentAbort);
  }

  const now = ctx.now().toISOString();
  await ctx.store.saveMessage({
    id: messageId,
    conversationId: prepared.conversation.id,
    role: "assistant",
    content,
    origin: adapter.id,
    model: adapter.model,
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
    model: adapter.model,
    demo: adapter.demo,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    createdAt: now,
  });
  return { provider: adapter.id, status, usage };
}
