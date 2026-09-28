import type {
  ConversationRecord,
  DocumentRecord,
  MessageRecord,
  SessionRecord,
  Store,
  UsageRow,
  UserRecord,
} from "./store.js";

/** In-memory store. Data is lost on restart; suitable for development, tests and demos. */
export class MemoryStore implements Store {
  private readonly users = new Map<string, UserRecord>();
  private readonly usersByEmail = new Map<string, string>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly conversations = new Map<string, ConversationRecord>();
  private readonly messages = new Map<string, MessageRecord[]>();
  private readonly documents = new Map<string, DocumentRecord>();
  private usage: UsageRow[] = [];

  async createUser(user: UserRecord): Promise<boolean> {
    const email = user.email.toLowerCase();
    if (this.usersByEmail.has(email)) return false;
    this.users.set(user.id, { ...user, email });
    this.usersByEmail.set(email, user.id);
    return true;
  }

  async findUserByEmail(email: string): Promise<UserRecord | undefined> {
    const id = this.usersByEmail.get(email.toLowerCase());
    return id ? this.users.get(id) : undefined;
  }

  async findUserById(id: string): Promise<UserRecord | undefined> {
    return this.users.get(id);
  }

  async deleteUserData(userId: string): Promise<void> {
    const user = this.users.get(userId);
    if (user) this.usersByEmail.delete(user.email);
    this.users.delete(userId);
    for (const [hash, s] of this.sessions) if (s.userId === userId) this.sessions.delete(hash);
    for (const [id, c] of this.conversations) {
      if (c.userId === userId) {
        this.conversations.delete(id);
        this.messages.delete(id);
      }
    }
    for (const [id, d] of this.documents) if (d.userId === userId) this.documents.delete(id);
    this.usage = this.usage.filter((u) => u.userId !== userId);
  }

  async createSession(session: SessionRecord): Promise<void> {
    this.sessions.set(session.tokenHash, session);
  }

  async findSession(tokenHash: string): Promise<SessionRecord | undefined> {
    return this.sessions.get(tokenHash);
  }

  async deleteSession(tokenHash: string): Promise<void> {
    this.sessions.delete(tokenHash);
  }

  async getConversation(userId: string, id: string): Promise<ConversationRecord | undefined> {
    const c = this.conversations.get(id);
    return c && c.userId === userId ? { ...c } : undefined;
  }

  async conversationExists(id: string): Promise<boolean> {
    return this.conversations.has(id);
  }

  async saveConversation(conversation: ConversationRecord): Promise<void> {
    this.conversations.set(conversation.id, { ...conversation });
  }

  async listConversations(userId: string): Promise<ConversationRecord[]> {
    return [...this.conversations.values()]
      .filter((c) => c.userId === userId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((c) => ({ ...c }));
  }

  async deleteConversation(userId: string, id: string): Promise<boolean> {
    const c = this.conversations.get(id);
    if (!c || c.userId !== userId) return false;
    this.conversations.delete(id);
    this.messages.delete(id);
    return true;
  }

  async listMessages(conversationId: string): Promise<MessageRecord[]> {
    return (this.messages.get(conversationId) ?? []).map((m) => ({ ...m, attachmentIds: [...m.attachmentIds] }));
  }

  async saveMessage(message: MessageRecord): Promise<void> {
    const list = this.messages.get(message.conversationId) ?? [];
    const index = list.findIndex((m) => m.id === message.id);
    if (index === -1) list.push({ ...message });
    else list[index] = { ...message };
    this.messages.set(message.conversationId, list);
  }

  async truncateMessagesFrom(conversationId: string, messageId: string): Promise<void> {
    const list = this.messages.get(conversationId);
    if (!list) return;
    const index = list.findIndex((m) => m.id === messageId);
    if (index !== -1) list.splice(index);
  }

  async saveDocument(document: DocumentRecord): Promise<void> {
    this.documents.set(document.id, { ...document });
  }

  async getDocument(userId: string, id: string): Promise<DocumentRecord | undefined> {
    const d = this.documents.get(id);
    return d && d.userId === userId ? { ...d } : undefined;
  }

  async listDocuments(userId: string): Promise<DocumentRecord[]> {
    return [...this.documents.values()]
      .filter((d) => d.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((d) => ({ ...d }));
  }

  async deleteDocument(userId: string, id: string): Promise<boolean> {
    const d = this.documents.get(id);
    if (!d || d.userId !== userId) return false;
    this.documents.delete(id);
    return true;
  }

  async recordUsage(row: UsageRow): Promise<void> {
    this.usage.push({ ...row });
  }

  async listUsage(userId: string): Promise<UsageRow[]> {
    return this.usage.filter((u) => u.userId === userId).map((u) => ({ ...u }));
  }
}
