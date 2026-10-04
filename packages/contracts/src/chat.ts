import { z } from "zod";
import { ApiError, AssistantMode, Id, LIMITS, MessageRole, ModelChoice, ProviderId } from "./common.js";
import { ToolCallStatus } from "./tools.js";

/**
 * A prior turn the client sends as context. Assistant turns must carry the provider that produced
 * them; the API drops assistant turns from a different provider before calling a provider, so one
 * provider's answers are never silently forwarded to another. Demo answers are never sent.
 */
export const HistoryMessage = z
  .object({
    role: MessageRole,
    content: z.string().min(1).max(LIMITS.maxMessageChars),
    origin: ProviderId.nullable(),
  })
  .superRefine((m, ctx) => {
    if (m.role === "user" && m.origin !== null) {
      ctx.addIssue({ code: "custom", message: "User messages must have a null origin", path: ["origin"] });
    }
    if (m.role === "assistant" && m.origin === null) {
      ctx.addIssue({ code: "custom", message: "Assistant messages must name their provider", path: ["origin"] });
    }
  });
export type HistoryMessage = z.infer<typeof HistoryMessage>;

export const OutgoingMessage = z.object({
  id: Id,
  content: z
    .string()
    .max(LIMITS.maxMessageChars)
    .refine((s) => s.trim().length > 0, "Message must not be blank"),
  attachmentIds: z.array(Id).max(LIMITS.maxAttachmentsPerMessage).default([]),
});
export type OutgoingMessage = z.infer<typeof OutgoingMessage>;

export const ChatStreamRequest = z.object({
  conversationId: Id,
  mode: AssistantMode,
  modelChoice: ModelChoice,
  message: OutgoingMessage,
  history: z.array(HistoryMessage).max(LIMITS.maxHistoryMessages).default([]),
});
export type ChatStreamRequest = z.infer<typeof ChatStreamRequest>;

export const StreamTarget = z.object({
  messageId: Id,
  provider: ProviderId,
  model: z.string(),
  /** True when a fake adapter produced this answer. Clients must label it as a demonstration. */
  demo: z.boolean(),
});
export type StreamTarget = z.infer<typeof StreamTarget>;

export const FinishReason = z.enum(["stop", "length", "refusal", "cancelled"]);
export type FinishReason = z.infer<typeof FinishReason>;

export const Usage = z.object({
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
});
export type Usage = z.infer<typeof Usage>;

export const StreamStartEvent = z.object({
  streamId: Id,
  conversationId: Id,
  modelChoice: ModelChoice,
  compareGroupId: Id.nullable(),
  targets: z.array(StreamTarget).min(1).max(2),
  routingReason: z.string(),
});
export const MessageDeltaEvent = z.object({ messageId: Id, text: z.string() });
export const MessageEndEvent = z.object({ messageId: Id, finishReason: FinishReason, usage: Usage });
export const MessageErrorEvent = z.object({ messageId: Id, error: ApiError });
export const ConversationTitleEvent = z.object({ conversationId: Id, title: z.string() });
/** A model asked to use a tool and the backend started running it. Informational: never carries arguments. */
export const ToolCallEvent = z.object({ messageId: Id, callId: z.string(), plugin: z.string(), tool: z.string() });
export const ToolResultEvent = z.object({
  messageId: Id,
  callId: z.string(),
  plugin: z.string(),
  tool: z.string(),
  status: ToolCallStatus,
  durationMs: z.number().int().nonnegative(),
});
export const StreamEndEvent = z.object({ streamId: Id });
export const StreamErrorEvent = z.object({ error: ApiError });

/** Server-sent event names and their JSON payload schemas. */
export const STREAM_EVENTS = {
  "stream.start": StreamStartEvent,
  "message.delta": MessageDeltaEvent,
  "message.end": MessageEndEvent,
  "message.error": MessageErrorEvent,
  "conversation.title": ConversationTitleEvent,
  "tool.call": ToolCallEvent,
  "tool.result": ToolResultEvent,
  "stream.end": StreamEndEvent,
  "stream.error": StreamErrorEvent,
} as const;
export type StreamEventName = keyof typeof STREAM_EVENTS;
export type StreamEventPayload<N extends StreamEventName> = z.infer<(typeof STREAM_EVENTS)[N]>;

export type StreamEvent = {
  [N in StreamEventName]: { event: N; data: StreamEventPayload<N> };
}[StreamEventName];

export const CancelStreamResponse = z.object({
  streamId: Id,
  cancelled: z.boolean(),
});
export type CancelStreamResponse = z.infer<typeof CancelStreamResponse>;

/** Serialises one server-sent event. */
export function encodeSseEvent(event: StreamEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

export interface RawSseEvent {
  event: string;
  data: string;
}

/** Minimal text/event-stream parser used by tests and tooling. Comments (": ping") are skipped. */
export function parseSseText(text: string): RawSseEvent[] {
  const events: RawSseEvent[] = [];
  let eventName = "message";
  let dataLines: string[] = [];
  const flush = () => {
    if (dataLines.length > 0) events.push({ event: eventName, data: dataLines.join("\n") });
    eventName = "message";
    dataLines = [];
  };
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine === "") {
      flush();
      continue;
    }
    if (rawLine.startsWith(":")) continue;
    const colon = rawLine.indexOf(":");
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
    let value = colon === -1 ? "" : rawLine.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value;
    else if (field === "data") dataLines.push(value);
  }
  flush();
  return events;
}

/** Parses and validates a whole stream transcript against the event schemas. */
export function decodeStream(text: string): StreamEvent[] {
  return parseSseText(text).map((raw) => {
    const schema = STREAM_EVENTS[raw.event as StreamEventName];
    if (!schema) throw new Error(`Unknown stream event: ${raw.event}`);
    return { event: raw.event, data: schema.parse(JSON.parse(raw.data)) } as StreamEvent;
  });
}
