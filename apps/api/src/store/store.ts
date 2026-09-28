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

export interface DocumentRecord {
  id: string;
  userId: string;
  name: string;
  kind: DocumentKind;
  mimeType: string;
  sizeBytes: number;
  status: DocumentStatus;
  statusDetail: string;
  /** Extracted plain text. Raw uploaded bytes are never stored. */
  extractedText: string;
  pageCount: number | null;
  createdAt: string;
}

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
 * Persistence boundary. The MVP ships an in-memory implementation; a database-backed
 * implementation can replace it without touching routes (see docs/decisions).
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

  /** Returns the conversation only if it belongs to userId. */
  getConversation(userId: string, id: string): Promise<ConversationRecord | undefined>;
  /** True if any user already owns a conversation with this id. */
  conversationExists(id: string): Promise<boolean>;
  saveConversation(conversation: ConversationRecord): Promise<void>;
  listConversations(userId: string): Promise<ConversationRecord[]>;
  deleteConversation(userId: string, id: string): Promise<boolean>;

  listMessages(conversationId: string): Promise<MessageRecord[]>;
  saveMessage(message: MessageRecord): Promise<void>;
  /** Removes the message with this id and every later message in the conversation. */
  truncateMessagesFrom(conversationId: string, messageId: string): Promise<void>;

  saveDocument(document: DocumentRecord): Promise<void>;
  getDocument(userId: string, id: string): Promise<DocumentRecord | undefined>;
  listDocuments(userId: string): Promise<DocumentRecord[]>;
  deleteDocument(userId: string, id: string): Promise<boolean>;

  recordUsage(row: UsageRow): Promise<void>;
  listUsage(userId: string): Promise<UsageRow[]>;
}
