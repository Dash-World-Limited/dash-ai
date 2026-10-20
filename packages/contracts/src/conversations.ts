import { z } from "zod";
import { AssistantMode, Id, IsoDateTime, LIMITS, MessageRole, ProviderId } from "./common.js";
import { ToolCallStatus } from "./tools.js";

export const Conversation = z.object({
  id: Id,
  title: z.string().max(LIMITS.maxTitleChars),
  mode: AssistantMode,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Conversation = z.infer<typeof Conversation>;

export const MessageStatus = z.enum(["complete", "stopped", "failed"]);
export type MessageStatus = z.infer<typeof MessageStatus>;

export const ConversationMessage = z.object({
  id: Id,
  role: MessageRole,
  content: z.string(),
  /** Which provider produced an assistant message. Null for user messages. */
  origin: ProviderId.nullable(),
  model: z.string().nullable(),
  demo: z.boolean(),
  status: MessageStatus,
  compareGroupId: Id.nullable(),
  createdAt: IsoDateTime,
  /**
   * Documents sent with a user message (their ids), so a reopened conversation can regenerate or
   * retry that message with the same documents. Absent from older servers: treat as none.
   */
  attachmentIds: z.array(Id).max(LIMITS.maxAttachmentsPerMessage).default([]),
});
export type ConversationMessage = z.infer<typeof ConversationMessage>;

export const CreateConversationRequest = z.object({
  /** Optional client-generated id so local-first history can use the same id. */
  id: Id.optional(),
  title: z.string().trim().min(1).max(LIMITS.maxTitleChars).optional(),
  mode: AssistantMode.default("general"),
});
export type CreateConversationRequest = z.infer<typeof CreateConversationRequest>;

export const UpdateConversationRequest = z.object({
  title: z.string().trim().min(1).max(LIMITS.maxTitleChars),
});
export type UpdateConversationRequest = z.infer<typeof UpdateConversationRequest>;

export const ConversationListResponse = z.object({
  conversations: z.array(Conversation),
});
export type ConversationListResponse = z.infer<typeof ConversationListResponse>;

/**
 * A tool call recorded while an assistant message was written, as clients show it when a
 * conversation is reopened. Only what the server stored: names, outcome and timing, never arguments
 * or results. Clients never invent entries for messages that have none.
 */
export const MessageToolActivity = z.object({
  messageId: Id,
  callId: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/),
  plugin: z.string(),
  tool: z.string(),
  status: ToolCallStatus,
  durationMs: z.number().int().nonnegative(),
  createdAt: IsoDateTime,
});
export type MessageToolActivity = z.infer<typeof MessageToolActivity>;

export const ConversationDetailResponse = z.object({
  conversation: Conversation,
  messages: z.array(ConversationMessage),
  /** Recorded tool calls of these messages, oldest first. Absent from older servers: treat as none. */
  toolActivity: z.array(MessageToolActivity).default([]),
});
export type ConversationDetailResponse = z.infer<typeof ConversationDetailResponse>;
