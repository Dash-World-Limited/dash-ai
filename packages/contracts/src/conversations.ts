import { z } from "zod";
import { AssistantMode, Id, IsoDateTime, LIMITS, MessageRole, ProviderId } from "./common.js";

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

export const ConversationDetailResponse = z.object({
  conversation: Conversation,
  messages: z.array(ConversationMessage),
});
export type ConversationDetailResponse = z.infer<typeof ConversationDetailResponse>;
