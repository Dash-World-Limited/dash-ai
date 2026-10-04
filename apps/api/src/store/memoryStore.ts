import {
  summarizeDocument,
  type ConversationChangePage,
  type ConversationRecord,
  type ConversationState,
  type PushConversationInput,
  type PushConversationResult,
  type RenameResult,
  type DocumentRecord,
  type DocumentSummary,
  type MessageRecord,
  type SessionRecord,
  type Store,
  type UsageRow,
  type UserRecord,
} from "./store.js";
import type { PluginSettingRecord, ToolInvocationRow } from "../tools/types.js";

interface StoredConversation {
  record: ConversationRecord;
  seq: number;
  titleRev: number;
  deleted: boolean;
}

/**
 * In-memory store. Data is lost on restart: for isolated tests and local demos only (production
 * uses PostgresStore). It mirrors the Postgres semantics, including sync sequence numbers and
 * conversation tombstones, and both are checked by the same contract tests.
 */
export class MemoryStore implements Store {
  private readonly users = new Map<string, UserRecord>();
  private readonly usersByEmail = new Map<string, string>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly conversations = new Map<string, StoredConversation>();
  private readonly messages = new Map<string, MessageRecord[]>();
  private readonly documents = new Map<string, DocumentRecord>();
  private readonly syncCounters = new Map<string, number>();
  private usage: UsageRow[] = [];
  private readonly pluginSettings = new Map<string, Map<string, PluginSettingRecord>>();
  private toolInvocations: ToolInvocationRow[] = [];

  private bump(conversation: StoredConversation): void {
    const next = (this.syncCounters.get(conversation.record.userId) ?? 0) + 1;
    this.syncCounters.set(conversation.record.userId, next);
    conversation.seq = next;
  }

  private live(conversationId: string): StoredConversation | undefined {
    const c = this.conversations.get(conversationId);
    return c && !c.deleted ? c : undefined;
  }

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

  async replacePasswordHash(userId: string, expected: string, next: string): Promise<boolean> {
    const user = this.users.get(userId);
    if (!user || user.passwordHash !== expected) return false;
    this.users.set(userId, { ...user, passwordHash: next });
    return true;
  }

  async deleteUserData(userId: string): Promise<void> {
    const user = this.users.get(userId);
    if (user) this.usersByEmail.delete(user.email);
    this.users.delete(userId);
    this.syncCounters.delete(userId);
    for (const [hash, s] of this.sessions) if (s.userId === userId) this.sessions.delete(hash);
    for (const [id, c] of this.conversations) {
      if (c.record.userId === userId) {
        this.conversations.delete(id);
        this.messages.delete(id);
      }
    }
    for (const [id, d] of this.documents) if (d.userId === userId) this.documents.delete(id);
    this.usage = this.usage.filter((u) => u.userId !== userId);
    this.pluginSettings.delete(userId);
    this.toolInvocations = this.toolInvocations.filter((t) => t.userId !== userId);
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

  async deleteSessionsForUser(userId: string): Promise<number> {
    let removed = 0;
    for (const [hash, session] of this.sessions) {
      if (session.userId === userId) {
        this.sessions.delete(hash);
        removed += 1;
      }
    }
    return removed;
  }

  async purgeExpiredSessions(now: Date): Promise<number> {
    let removed = 0;
    for (const [hash, s] of this.sessions) {
      if (Date.parse(s.expiresAt) <= now.getTime()) {
        this.sessions.delete(hash);
        removed += 1;
      }
    }
    return removed;
  }

  async getConversation(userId: string, id: string): Promise<ConversationRecord | undefined> {
    const c = this.live(id);
    return c && c.record.userId === userId ? { ...c.record } : undefined;
  }

  async conversationExists(id: string): Promise<boolean> {
    return this.conversations.has(id);
  }

  async saveConversation(conversation: ConversationRecord): Promise<void> {
    const existing = this.conversations.get(conversation.id);
    if (existing && (existing.deleted || existing.record.userId !== conversation.userId)) return;
    const stored = existing ?? { record: conversation, seq: 0, titleRev: 0, deleted: false };
    if (existing && existing.record.title !== conversation.title) stored.titleRev += 1;
    stored.record = { ...conversation };
    this.bump(stored);
    this.conversations.set(conversation.id, stored);
  }

  async listConversations(userId: string): Promise<ConversationRecord[]> {
    return [...this.conversations.values()]
      .filter((c) => !c.deleted && c.record.userId === userId)
      .map((c) => ({ ...c.record }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async deleteConversation(userId: string, id: string): Promise<boolean> {
    const c = this.live(id);
    if (!c || c.record.userId !== userId) return false;
    c.deleted = true;
    c.record = { ...c.record, title: "" };
    this.messages.delete(id);
    this.bump(c);
    return true;
  }

  async listConversationChanges(userId: string, afterSeq: number, limit: number): Promise<ConversationChangePage> {
    const rows = [...this.conversations.values()]
      .filter((c) => c.record.userId === userId && c.seq > afterSeq)
      .sort((a, b) => a.seq - b.seq);
    const page = rows.slice(0, limit);
    return {
      hasMore: rows.length > limit,
      changes: page.map((c) => ({
        seq: c.seq,
        titleRev: c.titleRev,
        deleted: c.deleted,
        conversation: { ...c.record },
        messages: c.deleted ? [] : this.cloneMessages(c.record.id),
      })),
    };
  }

  async conversationState(userId: string, id: string): Promise<ConversationState> {
    const c = this.conversations.get(id);
    if (!c || c.record.userId !== userId) return "absent";
    return c.deleted ? "deleted" : "live";
  }

  async pushConversation(userId: string, input: PushConversationInput): Promise<PushConversationResult> {
    const existing = this.conversations.get(input.conversation.id);
    if (existing && existing.record.userId !== userId) return { status: "rejected", appended: 0, skipped: input.messages.length };
    if (existing?.deleted) return { status: "deleted", appended: 0, skipped: input.messages.length };
    const created = !existing;
    const stored = existing ?? { record: { ...input.conversation, userId }, seq: 0, titleRev: 0, deleted: false };
    this.conversations.set(stored.record.id, stored);
    const list = this.messages.get(stored.record.id) ?? [];
    const known = new Set(list.map((m) => m.id));
    // Only the tail may grow: anything not newer than the newest stored message is ignored.
    const baseline = list.reduce((max, m) => Math.max(max, Date.parse(m.createdAt)), Number.NEGATIVE_INFINITY);
    let newest = "";
    let appended = 0;
    for (const m of input.messages) {
      if (known.has(m.id) || Date.parse(m.createdAt) <= baseline) continue;
      list.push({ ...m, conversationId: stored.record.id, attachmentIds: [] });
      known.add(m.id);
      if (m.createdAt > newest) newest = m.createdAt;
      appended += 1;
    }
    this.messages.set(stored.record.id, list);
    if (created || appended > 0) {
      if (appended > 0 && stored.record.updatedAt < newest) stored.record = { ...stored.record, updatedAt: newest };
      this.bump(stored);
    }
    return { status: created ? "created" : "merged", appended, skipped: input.messages.length - appended };
  }

  async renameConversationIfCurrent(userId: string, id: string, title: string, baseTitleRev: number | null, now: string): Promise<RenameResult> {
    const c = this.conversations.get(id);
    if (!c || c.record.userId !== userId) return { status: "not_found" };
    if (c.deleted) return { status: "deleted" };
    if (c.record.title === title && c.record.titleIsCustom) return { status: "applied" };
    if (c.record.titleIsCustom && baseTitleRev !== c.titleRev) return { status: "conflict" };
    await this.saveConversation({ ...c.record, title, titleIsCustom: true, updatedAt: now });
    return { status: "applied" };
  }

  async latestSyncSeq(userId: string): Promise<number> {
    return this.syncCounters.get(userId) ?? 0;
  }

  private cloneMessages(conversationId: string): MessageRecord[] {
    return (this.messages.get(conversationId) ?? []).map((m) => ({ ...m, attachmentIds: [...m.attachmentIds] }));
  }

  async listMessages(conversationId: string): Promise<MessageRecord[]> {
    return this.live(conversationId) ? this.cloneMessages(conversationId) : [];
  }

  async saveMessage(message: MessageRecord): Promise<void> {
    const conversation = this.live(message.conversationId);
    if (!conversation) return;
    const list = this.messages.get(message.conversationId) ?? [];
    const stored = { ...message, attachmentIds: [...message.attachmentIds] };
    const index = list.findIndex((m) => m.id === message.id);
    if (index === -1) list.push(stored);
    else list[index] = stored;
    this.messages.set(message.conversationId, list);
    this.bump(conversation);
  }

  async truncateMessagesFrom(conversationId: string, messageId: string): Promise<void> {
    const conversation = this.live(conversationId);
    const list = this.messages.get(conversationId);
    if (!conversation || !list) return;
    const index = list.findIndex((m) => m.id === messageId);
    if (index === -1) return;
    list.splice(index);
    this.bump(conversation);
  }

  async saveDocument(document: DocumentRecord): Promise<void> {
    this.documents.set(document.id, { ...document });
  }

  async getDocument(userId: string, id: string): Promise<DocumentRecord | undefined> {
    const d = this.documents.get(id);
    return d && d.userId === userId ? { ...d } : undefined;
  }

  async listDocuments(userId: string): Promise<DocumentSummary[]> {
    return [...this.documents.values()]
      .filter((d) => d.userId === userId)
      .map(summarizeDocument)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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

  async getPluginSettings(userId: string): Promise<PluginSettingRecord[]> {
    return [...(this.pluginSettings.get(userId)?.values() ?? [])].map((s) => ({ ...s, grantedScopes: [...s.grantedScopes] }));
  }

  async savePluginSetting(userId: string, setting: PluginSettingRecord): Promise<void> {
    const map = this.pluginSettings.get(userId) ?? new Map<string, PluginSettingRecord>();
    map.set(setting.pluginId, { ...setting, grantedScopes: [...setting.grantedScopes] });
    this.pluginSettings.set(userId, map);
  }

  async recordToolInvocation(row: ToolInvocationRow): Promise<void> {
    this.toolInvocations.push({ ...row });
  }

  async listToolInvocations(userId: string, limit: number): Promise<ToolInvocationRow[]> {
    return this.toolInvocations.filter((t) => t.userId === userId).slice(-limit).reverse().map((t) => ({ ...t }));
  }

  async close(): Promise<void> {}
}
