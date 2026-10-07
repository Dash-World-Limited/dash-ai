import { z } from "zod";
import { AssistantMode, Id, IsoDateTime, LIMITS } from "./common.js";
import { Conversation, ConversationMessage, MessageToolActivity } from "./conversations.js";

/** A conversation as sync delivers it. Adds what clients need to merge titles deterministically. */
export const SyncConversation = Conversation.extend({
  /** True once the user renamed it (the server will not overwrite a custom title with a generated one). */
  titleIsCustom: z.boolean(),
  /**
   * Increases every time the title changes. A device sends the revision it last saw with a rename,
   * so the server can tell a fresh rename from a stale one (see docs/sync.md).
   */
  titleRev: z.number().int().nonnegative(),
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
  /** Recorded tool calls of these messages, oldest first (empty for a tombstone). */
  toolActivity: z.array(MessageToolActivity).default([]),
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

// ---- Device → server (push) ---------------------------------------------------------------------

export const SYNC_PUSH_LIMITS = {
  maxOperations: 20,
  maxMessagesPerUpload: 100,
} as const;

/** A user message written on a device. Assistant messages are only ever created by the server. */
export const PushMessage = z.object({
  id: Id,
  content: z
    .string()
    .max(LIMITS.maxMessageChars)
    .refine((s) => s.trim().length > 0, "Message must not be blank"),
  createdAt: IsoDateTime,
});
export type PushMessage = z.infer<typeof PushMessage>;

/** Creates the conversation if the server has never seen it, otherwise appends newer user messages. */
export const UploadConversationOperation = z.object({
  opId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  type: z.literal("upload"),
  conversation: z.object({
    id: Id,
    title: z.string().max(LIMITS.maxTitleChars),
    titleIsCustom: z.boolean(),
    mode: AssistantMode,
    createdAt: IsoDateTime,
  }),
  messages: z.array(PushMessage).max(SYNC_PUSH_LIMITS.maxMessagesPerUpload),
});

export const RenameOperation = z.object({
  opId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  type: z.literal("rename"),
  conversationId: Id,
  title: z.string().trim().min(1).max(LIMITS.maxTitleChars),
  /** The titleRev this device last pulled for the conversation, or null if it never pulled it. */
  baseTitleRev: z.number().int().nonnegative().nullable(),
});

export const DeleteOperation = z.object({
  opId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  type: z.literal("delete"),
  conversationId: Id,
});

export const SyncOperation = z.discriminatedUnion("type", [UploadConversationOperation, RenameOperation, DeleteOperation]);
export type SyncOperation = z.infer<typeof SyncOperation>;

export const SyncPushRequest = z.object({
  operations: z.array(SyncOperation).min(1).max(SYNC_PUSH_LIMITS.maxOperations),
});
export type SyncPushRequest = z.infer<typeof SyncPushRequest>;

/**
 * applied   — done (or already true: every operation is idempotent).
 * conflict  — a stale rename lost to a newer title on the server; the server title stays.
 * deleted   — the conversation was deleted; the device must delete its copy and never re-upload it.
 * not_found — nothing to rename or delete (for delete this means the same as applied).
 * rejected  — the id is not available to this account; nothing was changed or revealed.
 */
export const SyncOperationStatus = z.enum(["applied", "conflict", "deleted", "not_found", "rejected"]);
export type SyncOperationStatus = z.infer<typeof SyncOperationStatus>;

export const SyncOperationResult = z.object({
  opId: z.string(),
  status: SyncOperationStatus,
  /** Upload only: user messages added, and messages ignored (already known, or older than the server's newest). */
  appended: z.number().int().nonnegative().optional(),
  skipped: z.number().int().nonnegative().optional(),
});
export type SyncOperationResult = z.infer<typeof SyncOperationResult>;

export const SyncPushResponse = z.object({ results: z.array(SyncOperationResult) });
export type SyncPushResponse = z.infer<typeof SyncPushResponse>;
