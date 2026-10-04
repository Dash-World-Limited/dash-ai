import { z } from "zod";
import { Conversation, ConversationMessage } from "./conversations.js";

/** A conversation as sync delivers it. Adds what clients need to merge titles deterministically. */
export const SyncConversation = Conversation.extend({
  /** True once the user renamed it (the server will not overwrite a custom title with a generated one). */
  titleIsCustom: z.boolean(),
});
export type SyncConversation = z.infer<typeof SyncConversation>;

/**
 * One changed conversation. A deleted conversation arrives as a tombstone: `deleted: true`, an empty
 * title and no messages. A live one arrives with its COMPLETE message list (not a delta), so a
 * client can always reconstruct it from a single change.
 */
export const SyncChange = z.object({
  /** Per-user, strictly increasing change number. Changes are delivered in seq order. */
  seq: z.number().int().positive(),
  deleted: z.boolean(),
  conversation: SyncConversation,
  messages: z.array(ConversationMessage),
});
export type SyncChange = z.infer<typeof SyncChange>;

export const SyncConversationsResponse = z.object({
  changes: z.array(SyncChange),
  /** Pass as `cursor` to continue. Opaque to clients: store it, do not interpret it. */
  cursor: z.string(),
  /** The user's newest change number. A cursor beyond it means the server data was restored: start over. */
  latest: z.string(),
  hasMore: z.boolean(),
});
export type SyncConversationsResponse = z.infer<typeof SyncConversationsResponse>;

export const SYNC_PAGE_LIMIT = { default: 20, max: 50 } as const;
