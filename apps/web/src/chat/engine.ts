import type {
  AssistantMode,
  ChatStreamRequest,
  Conversation,
  ConversationMessage,
  HistoryMessage,
  MessageToolActivity,
  StreamEvent,
} from "@dash-ai/contracts";
import { LIMITS } from "@dash-ai/contracts";
import { ApiError } from "../api/client";
import type { ToolStatus, ToolUse } from "../logic/presentation";
import type { Attachment, ChatBackend, ChatMsg } from "./types";

export interface ChatState {
  conversation: Conversation | null;
  messages: ChatMsg[];
  generating: boolean;
  streamId: string | null;
  /** A request-level failure (offline, server refused). Per-answer failures live on the answer. */
  error: ApiError | null;
  loading: boolean;
}

export const EMPTY: ChatState = { conversation: null, messages: [], generating: false, streamId: null, error: null, loading: false };

export function newId(prefix = ""): string {
  return prefix + crypto.randomUUID().replace(/-/g, "");
}

const DEFAULT_TITLE = "New chat";

/** Context sent with a request: earlier turns, never demo answers or empty/failed ones, within the API's limits. */
export function buildHistory(earlier: ChatMsg[]): HistoryMessage[] {
  const turns: HistoryMessage[] = [];
  for (const m of earlier) {
    if (m.role === "user") turns.push({ role: "user", content: m.content });
    else if (!m.demo && m.content.trim() && m.status !== "failed") turns.push({ role: "assistant", content: m.content });
  }
  let recent = turns.slice(-LIMITS.maxHistoryMessages);
  while (recent.reduce((n, t) => n + t.content.length, 0) > LIMITS.maxHistoryChars) recent = recent.slice(1);
  return recent;
}

/** Recorded tool calls by message, in the order they happened. Only what the server stored is shown. */
export function toolsByMessage(activity: readonly MessageToolActivity[] | undefined): Map<string, ToolUse[]> {
  const map = new Map<string, ToolUse[]>();
  for (const a of activity ?? []) {
    const list = map.get(a.messageId) ?? [];
    if (!list.some((t) => t.callId === a.callId)) list.push({ callId: a.callId, plugin: a.plugin, tool: a.tool, status: a.status, durationMs: a.durationMs });
    map.set(a.messageId, list);
  }
  return map;
}

function fromServer(m: ConversationMessage, tools: ToolUse[] = []): ChatMsg {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    status: m.status,
    demo: m.demo,
    createdAt: m.createdAt,
    replyToId: null,
    attachments: [],
    errorMessage: m.status === "failed" ? "This answer was not completed." : null,
    retryable: m.status === "failed",
    tools: m.role === "assistant" ? tools : [],
    finishReason: null,
  };
}

/**
 * The conversation state machine (mirrors the Android ChatSession): send, stream, stop, regenerate,
 * edit and resend. DASH AI decides how each answer is produced; the app never picks a provider.
 * Only the current request may
 * change the visible state; switching chats cancels the old request.
 */
export class ChatEngine {
  private state: ChatState = EMPTY;
  private listeners = new Set<(s: ChatState) => void>();
  private controller: AbortController | null = null;
  private generation = 0;

  constructor(private backend: ChatBackend) {}

  get value(): ChatState {
    return this.state;
  }

  subscribe(fn: (s: ChatState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(change: (s: ChatState) => ChatState, gen?: number): void {
    if (gen !== undefined && gen !== this.generation) return;
    this.state = change(this.state);
    for (const l of this.listeners) l(this.state);
  }

  /** Account or Demo Mode changed: nothing of the previous one stays on screen. */
  setBackend(backend: ChatBackend): void {
    this.backend = backend;
    this.newChat();
  }

  newChat(): void {
    this.cancelCurrent();
    this.set(() => EMPTY);
  }

  async open(id: string): Promise<void> {
    this.cancelCurrent();
    const gen = this.generation;
    this.set(() => ({ ...EMPTY, loading: true }));
    try {
      const detail = await this.backend.get(id);
      if (!detail) return this.set(() => EMPTY, gen);
      const tools = toolsByMessage(detail.toolActivity);
      this.set(() => ({ ...EMPTY, conversation: detail.conversation, messages: detail.messages.map((m) => fromServer(m, tools.get(m.id))) }), gen);
    } catch (e) {
      this.set(() => ({ ...EMPTY, error: e instanceof ApiError ? e : ApiError.network() }), gen);
    }
  }

  dismissError(): void {
    this.set((s) => ({ ...s, error: null }));
  }

  renamed(id: string, title: string): void {
    this.set((s) => (s.conversation?.id === id ? { ...s, conversation: { ...s.conversation, title } } : s));
  }

  send(text: string, mode: AssistantMode, attachments: Attachment[] = []): boolean {
    const content = text.trim();
    if (!content || content.length > LIMITS.maxMessageChars || this.state.generating) return false;
    const now = new Date().toISOString();
    const conversation: Conversation = this.state.conversation
      ? { ...this.state.conversation, mode, updatedAt: now }
      : { id: newId("c"), title: DEFAULT_TITLE, mode, createdAt: now, updatedAt: now };
    const user: ChatMsg = {
      id: newId("m"), role: "user", content, status: "complete", demo: this.backend.demo,
      replyToId: null, createdAt: now, attachments, errorMessage: null, retryable: false, tools: [], finishReason: null,
    };
    this.set((s) => ({ ...s, conversation, messages: [...s.messages, user], error: null }));
    void this.generate(conversation, user, mode);
    return true;
  }

  /** Stops the answer; the partial text is kept and marked stopped. */
  stop(): void {
    const streamId = this.state.streamId;
    this.controller?.abort();
    if (streamId) void this.backend.cancel(streamId).catch(() => undefined);
  }

  /**
   * The browser lost its connection while an answer was streaming. A dropped connection can leave the
   * request hanging for minutes, so the answer is ended now as failed (with Retry) instead of waiting.
   * What arrived so far is kept. Demo Mode needs no connection and is not affected.
   */
  connectionLost(): void {
    if (!this.state.generating || this.backend.demo) return;
    this.controller?.abort(ApiError.connectionLost());
  }

  /** Answers the same question again. */
  regenerate(answerId: string): boolean {
    const messages = this.state.messages;
    const answer = messages.find((m) => m.id === answerId && m.role === "assistant");
    if (!answer) return false;
    const index = messages.indexOf(answer);
    const user = answer.replyToId ? messages.find((m) => m.id === answer.replyToId) : [...messages.slice(0, index)].reverse().find((m) => m.role === "user");
    if (!user) return false;
    return this.resend(user, user.content);
  }

  editAndResend(userId: string, text: string): boolean {
    const user = this.state.messages.find((m) => m.id === userId && m.role === "user");
    if (!user || !text.trim()) return false;
    return this.resend(user, text.trim());
  }

  retryLast(): boolean {
    const user = [...this.state.messages].reverse().find((m) => m.role === "user");
    return user ? this.resend(user, user.content) : false;
  }

  private resend(user: ChatMsg, content: string): boolean {
    const conversation = this.state.conversation;
    if (this.state.generating || !conversation) return false;
    const index = this.state.messages.indexOf(user);
    // Same message id: the API replaces that message and everything after it.
    const updated = { ...user, content };
    this.set((s) => ({ ...s, messages: [...s.messages.slice(0, index), updated], error: null }));
    void this.generate(conversation, updated, conversation.mode);
    return true;
  }

  private cancelCurrent(): void {
    this.generation++;
    this.controller?.abort();
    this.controller = null;
  }

  private updateAnswer(gen: number, id: string, change: (m: ChatMsg) => ChatMsg): void {
    this.set((s) => ({ ...s, messages: s.messages.map((m) => (m.id === id ? change(m) : m)) }), gen);
  }

  private async generate(conversation: Conversation, user: ChatMsg, mode: AssistantMode): Promise<void> {
    this.cancelCurrent();
    const gen = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    const earlier = this.state.messages.slice(0, this.state.messages.indexOf(user));
    const request: ChatStreamRequest = {
      conversationId: conversation.id,
      mode,
      modelChoice: "smart",
      message: { id: user.id, content: user.content, attachmentIds: user.attachments.map((a) => a.id) },
      history: buildHistory(earlier),
    };
    this.set((s) => ({ ...s, generating: true, streamId: null }), gen);
    const answers = new Set<string>();
    try {
      for await (const event of this.backend.stream(request, controller.signal)) {
        if (gen !== this.generation) break;
        this.handle(gen, event, user, answers);
      }
      this.finishStreaming(gen, answers, "failed", "The response ended unexpectedly.");
    } catch (e) {
      const lost = controller.signal.aborted && controller.signal.reason instanceof ApiError ? controller.signal.reason : null;
      if (lost) {
        this.finishStreaming(gen, answers, "failed", lost.message);
        this.set((s) => ({ ...s, error: lost }), gen);
      } else if (controller.signal.aborted) {
        this.finishStreaming(gen, answers, "stopped", null);
      } else {
        const error = e instanceof ApiError ? e : new ApiError("internal_error", "Something went wrong. Please try again.", true);
        this.finishStreaming(gen, answers, "failed", error.message);
        this.set((s) => ({ ...s, error }), gen);
      }
    } finally {
      // Demo Mode keeps the finished chat first, so the history refresh that follows sees it.
      if (gen === this.generation && this.backend.save && this.state.conversation) this.backend.save(this.state.conversation, this.state.messages);
      this.set((s) => ({ ...s, generating: false, streamId: null }), gen);
    }
  }

  private finishStreaming(gen: number, answers: Set<string>, status: "failed" | "stopped", message: string | null): void {
    for (const id of answers) {
      this.updateAnswer(gen, id, (m) =>
        m.status !== "streaming"
          ? m
          : {
              ...m,
              status,
              errorMessage: message ?? m.errorMessage,
              retryable: status === "failed",
              tools: m.tools.map((t) => (t.status === null ? { ...t, status: status === "stopped" ? "cancelled" : "error" } : t)),
            },
      );
    }
  }

  private handle(gen: number, event: StreamEvent, user: ChatMsg, answers: Set<string>): void {
    switch (event.event) {
      case "stream.start": {
        const placeholders: ChatMsg[] = event.data.targets.map((t) => ({
          id: t.messageId, role: "assistant", content: "", status: "streaming", demo: t.demo,
          replyToId: user.id, createdAt: new Date().toISOString(), attachments: [],
          errorMessage: null, retryable: false, tools: [], finishReason: null,
        }));
        placeholders.forEach((p) => answers.add(p.id));
        this.set((s) => ({ ...s, streamId: event.data.streamId, messages: [...s.messages, ...placeholders] }), gen);
        break;
      }
      case "message.delta":
        if (answers.has(event.data.messageId)) this.updateAnswer(gen, event.data.messageId, (m) => ({ ...m, content: m.content + event.data.text }));
        break;
      case "message.end":
        if (answers.has(event.data.messageId)) {
          const reason = event.data.finishReason;
          this.updateAnswer(gen, event.data.messageId, (m) => ({ ...m, status: reason === "cancelled" ? "stopped" : "complete", finishReason: reason }));
        }
        break;
      case "message.error":
        if (answers.has(event.data.messageId)) {
          const { error, recovery } = event.data;
          this.updateAnswer(gen, event.data.messageId, (m) => ({ ...m, status: "failed", errorMessage: error.message, retryable: error.retryable, recovery: recovery ? { attempts: recovery.attempts } : undefined }));
        }
        break;
      case "tool.call":
        if (answers.has(event.data.messageId)) {
          const { callId, plugin, tool } = event.data;
          this.updateAnswer(gen, event.data.messageId, (m) =>
            m.tools.some((t) => t.callId === callId) ? m : { ...m, tools: [...m.tools, { callId, plugin, tool, status: null, durationMs: null }] },
          );
        }
        break;
      case "tool.result":
        if (answers.has(event.data.messageId)) {
          const { callId, plugin, tool, status, durationMs } = event.data;
          const done = { callId, plugin, tool, status: status as ToolStatus, durationMs };
          this.updateAnswer(gen, event.data.messageId, (m) => ({
            ...m,
            tools: m.tools.some((t) => t.callId === callId) ? m.tools.map((t) => (t.callId === callId ? done : t)) : [...m.tools, done],
          }));
        }
        break;
      case "conversation.title":
        this.set((s) => (s.conversation?.id === event.data.conversationId ? { ...s, conversation: { ...s.conversation, title: event.data.title } } : s), gen);
        break;
      case "stream.error":
        this.finishStreaming(gen, answers, "failed", event.data.error.message);
        this.set((s) => ({ ...s, error: new ApiError(event.data.error.code, event.data.error.message, event.data.error.retryable) }), gen);
        break;
      case "stream.end":
        break;
    }
  }
}
