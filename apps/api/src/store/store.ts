import type { PluginSettingRecord, ToolInvocationRow } from "../tools/types.js";
import type {
  AssistantMode,
  DocumentKind,
  DocumentStatus,
  MessageRole,
  MessageStatus,
  ProviderId,
} from "@dash-ai/contracts";

export interface UserRecord {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  createdAt: string;
}

export interface SessionRecord {
  tokenHash: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

export interface ConversationRecord {
  id: string;
  userId: string;
  title: string;
  titleIsCustom: boolean;
  mode: AssistantMode;
  createdAt: string;
  updatedAt: string;
}

export interface MessageRecord {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  origin: ProviderId | null;
  model: string | null;
  demo: boolean;
  status: MessageStatus;
  compareGroupId: string | null;
  attachmentIds: string[];
  createdAt: string;
}

/** Document metadata. Listing documents never reads (or decrypts) their text. */
export interface DocumentSummary {
  id: string;
  userId: string;
  name: string;
  kind: DocumentKind;
  mimeType: string;
  sizeBytes: number;
  status: DocumentStatus;
  statusDetail: string;
  extractedChars: number;
  pageCount: number | null;
  createdAt: string;
}

export interface DocumentRecord extends Omit<DocumentSummary, "extractedChars"> {
  /** Extracted plain text. Raw uploaded bytes are never stored. Encrypted at rest by durable stores. */
  extractedText: string;
}

export const summarizeDocument = (d: DocumentRecord): DocumentSummary => {
  const { extractedText, ...meta } = d;
  return { ...meta, extractedChars: extractedText.length };
};

export type { PluginSettingRecord, ToolInvocationRow };

export interface UsageRow {
  userId: string;
  conversationId: string;
  messageId: string;
  provider: ProviderId;
  model: string;
  demo: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  createdAt: string;
}

/**
 * One conversation as seen by sync. `seq` is a per-user, strictly increasing change counter that
 * is bumped by every conversation, message or deletion change. A deleted conversation is kept as
 * a tombstone (`deleted: true`, no messages) so other devices learn about the deletion.
 */
export interface ConversationChange {
  seq: number;
  deleted: boolean;
  conversation: ConversationRecord;
  messages: MessageRecord[];
}

export interface ConversationChangePage {
  changes: ConversationChange[];
  /** True when more changes exist after the last one returned. */
  hasMore: boolean;
}

/**
 * Persistence boundary. `PostgresStore` is the production implementation and `MemoryStore` is
 * for isolated tests and local demos. Both are held to the same contract tests
 * (test/store.contract.test.ts).
 */
export interface Store {
  createUser(user: UserRecord): Promise<boolean>;
  findUserByEmail(email: string): Promise<UserRecord | undefined>;
  findUserById(id: string): Promise<UserRecord | undefined>;
  /** Deletes the user and everything they own. */
  deleteUserData(userId: string): Promise<void>;

  createSession(session: SessionRecord): Promise<void>;
  findSession(tokenHash: string): Promise<SessionRecord | undefined>;
  deleteSession(tokenHash: string): Promise<void>;

  /** Returns the conversation only if it belongs to userId and has not been deleted. */
  getConversation(userId: string, id: string): Promise<ConversationRecord | undefined>;
  /** True if any user owns (or owned and deleted) a conversation with this id: ids are never reused. */
  conversationExists(id: string): Promise<boolean>;
  /** Creates or updates. A no-op for a deleted conversation (deletion is final). */
  saveConversation(conversation: ConversationRecord): Promise<void>;
  /** Live (not deleted) conversations, most recently updated first. */
  listConversations(userId: string): Promise<ConversationRecord[]>;
  /** Soft-deletes: removes the messages and leaves a tombstone for sync. */
  deleteConversation(userId: string, id: string): Promise<boolean>;
  /** Conversations (with messages) and tombstones whose seq is greater than afterSeq, oldest first. */
  listConversationChanges(userId: string, afterSeq: number, limit: number): Promise<ConversationChangePage>;

  listMessages(conversationId: string): Promise<MessageRecord[]>;
  /** Creates or replaces by id within the conversation. A no-op if the conversation was deleted. */
  saveMessage(message: MessageRecord): Promise<void>;
  /** Removes the message with this id and every later message in the conversation. */
  truncateMessagesFrom(conversationId: string, messageId: string): Promise<void>;

  saveDocument(document: DocumentRecord): Promise<void>;
  getDocument(userId: string, id: string): Promise<DocumentRecord | undefined>;
  listDocuments(userId: string): Promise<DocumentSummary[]>;
  deleteDocument(userId: string, id: string): Promise<boolean>;

  recordUsage(row: UsageRow): Promise<void>;
  listUsage(userId: string): Promise<UsageRow[]>;

  /** The user's plugin choices (only plugins they have ever configured). */
  getPluginSettings(userId: string): Promise<PluginSettingRecord[]>;
  savePluginSetting(userId: string, setting: PluginSettingRecord): Promise<void>;

  /** Audit metadata for tool calls (never arguments or results). */
  recordToolInvocation(row: ToolInvocationRow): Promise<void>;
  /** Most recent first. */
  listToolInvocations(userId: string, limit: number): Promise<ToolInvocationRow[]>;

  /** Deletes sessions that expired before `now`. Returns how many were removed. */
  purgeExpiredSessions(now: Date): Promise<number>;

  /** Releases connections. Safe to call more than once. */
  close(): Promise<void>;
}
