import {
  summarizeDocument,
  type InferenceAttemptRow,
  type InferenceSpend,
  type InferenceSpendQuery,
  type ReserveSpendInput,
  type ReserveSpendResult,
  type SettleSpendResult,
  type SpendLimit,
  type SpendReservationRecord,
  type SpendUsage,
  type AutomationRecord,
  type AutomationRunRecord,
  type FinishRunInput,
  type NotificationRecord,
  type ClaimedPushDelivery,
  type FinishPushDeliveryInput,
  type PushDeliveryRecord,
  type PushDeviceRecord,
  type UpsertPushDeviceInput,
  type ScheduleRunInput,
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
import { newId } from "../security/crypto.js";
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
  private attempts: InferenceAttemptRow[] = [];
  /** Insertion order is creation order. */
  private readonly reservations = new Map<string, SpendReservationRecord>();
  private readonly pluginSettings = new Map<string, Map<string, PluginSettingRecord>>();
  private toolInvocations: ToolInvocationRow[] = [];
  private readonly toolExecutions = new Map<string, { userId: string; status: string }>();
  private readonly automations = new Map<string, AutomationRecord>();
  /** Insertion order is creation order. */
  private readonly runs = new Map<string, AutomationRunRecord>();
  private readonly notifications = new Map<string, NotificationRecord>();
  private readonly pushDevices = new Map<string, PushDeviceRecord>();
  /** Insertion order is creation order. */
  private readonly pushDeliveries = new Map<string, PushDeliveryRecord>();
  /** Users who turned Automates pushes off (on is the default). */
  private readonly pushOff = new Set<string>();

  /** The clock spend reservation leases read (PostgreSQL uses the database clock). */
  constructor(private readonly clock: () => number = Date.now) {}

  private bump(conversation: StoredConversation): void {
    const next = (this.syncCounters.get(conversation.record.userId) ?? 0) + 1;
    this.syncCounters.set(conversation.record.userId, next);
    conversation.seq = next;
  }

  private live(conversationId: string): StoredConversation | undefined {
    const c = this.conversations.get(conversationId);
    return c && !c.deleted ? c : undefined;
  }

  async ping(): Promise<boolean> {
    return true;
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
    for (const [hash, s] of this.sessions) if (s.userId === userId) this.dropSession(hash);
    this.pushOff.delete(userId);
    for (const [id, c] of this.conversations) {
      if (c.record.userId === userId) {
        this.conversations.delete(id);
        this.messages.delete(id);
      }
    }
    for (const [id, d] of this.documents) if (d.userId === userId) this.documents.delete(id);
    this.usage = this.usage.filter((u) => u.userId !== userId);
    // The ledger keeps its accounting records; only the account link goes.
    this.attempts = this.attempts.map((a) => (a.userId === userId ? { ...a, userId: null } : a));
    for (const r of this.reservations.values()) if (r.userId === userId) r.userId = null;
    this.pluginSettings.delete(userId);
    this.toolInvocations = this.toolInvocations.filter((t) => t.userId !== userId);
    for (const [key, e] of this.toolExecutions) if (e.userId === userId) this.toolExecutions.delete(key);
    for (const [id, a] of this.automations) if (a.userId === userId) this.deleteAutomationRows(id);
  }

  /**
   * Mirrors PostgreSQL's foreign keys: rows owned by a user that no longer exists are never written.
   * Without this, an answer still streaming when its account was deleted recreated that account's
   * conversation here.
   */
  private owned(userId: string): boolean {
    return this.users.has(userId);
  }

  async createSession(session: SessionRecord): Promise<void> {
    if (!this.owned(session.userId)) return;
    this.sessions.set(session.tokenHash, session);
  }

  async findSession(tokenHash: string): Promise<SessionRecord | undefined> {
    return this.sessions.get(tokenHash);
  }

  /** Mirrors the foreign keys: a session takes its push device (and that device's deliveries) with it. */
  private dropSession(tokenHash: string): void {
    this.sessions.delete(tokenHash);
    for (const [id, d] of this.pushDevices) if (d.sessionHash === tokenHash) this.dropPushDevice(id);
  }

  private dropPushDevice(id: string): void {
    this.pushDevices.delete(id);
    for (const [did, d] of this.pushDeliveries) if (d.deviceId === id) this.pushDeliveries.delete(did);
  }

  private dropNotification(id: string): void {
    this.notifications.delete(id);
    for (const [did, d] of this.pushDeliveries) if (d.notificationId === id) this.pushDeliveries.delete(did);
  }

  async deleteSession(tokenHash: string): Promise<void> {
    this.dropSession(tokenHash);
  }

  async deleteSessionsForUser(userId: string): Promise<number> {
    let removed = 0;
    for (const [hash, session] of this.sessions) {
      if (session.userId === userId) {
        this.dropSession(hash);
        removed += 1;
      }
    }
    return removed;
  }

  async purgeExpiredSessions(now: Date): Promise<number> {
    let removed = 0;
    for (const [hash, s] of this.sessions) {
      if (Date.parse(s.expiresAt) <= now.getTime()) {
        this.dropSession(hash);
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
    if (!this.owned(conversation.userId)) return;
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
    this.toolInvocations = this.toolInvocations.filter((t) => t.conversationId !== id);
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
        tools: c.deleted ? [] : this.conversationTools(userId, c.record.id),
      })),
    };
  }

  async conversationState(userId: string, id: string): Promise<ConversationState> {
    const c = this.conversations.get(id);
    if (!c || c.record.userId !== userId) return "absent";
    return c.deleted ? "deleted" : "live";
  }

  async pushConversation(userId: string, input: PushConversationInput): Promise<PushConversationResult> {
    if (!this.owned(userId)) return { status: "rejected", appended: 0, skipped: input.messages.length };
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
    if (!this.owned(document.userId)) return;
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
    if (!this.owned(row.userId)) return;
    this.usage.push({ ...row, estimatedCostUsd: row.estimatedCostUsd ?? null });
  }

  async listUsage(userId: string): Promise<UsageRow[]> {
    return this.usage.filter((u) => u.userId === userId).map((u) => ({ ...u }));
  }

  async recordInferenceAttempt(row: InferenceAttemptRow): Promise<void> {
    if (this.attempts.some((a) => a.id === row.id)) throw new Error("duplicate inference attempt");
    this.attempts.push(structuredClone(row));
  }

  async listInferenceAttempts(inferenceId: string): Promise<InferenceAttemptRow[]> {
    return this.attempts.filter((a) => a.inferenceId === inferenceId).map((a) => structuredClone(a));
  }

  async sumInferenceSpend(q: InferenceSpendQuery): Promise<InferenceSpend> {
    const since = Date.parse(q.since);
    const rows = this.attempts.filter(
      (a) =>
        Date.parse(a.createdAt) >= since &&
        (q.userId === undefined || a.userId === q.userId) &&
        (q.plan === undefined || a.plan === q.plan) &&
        (q.provider === undefined || a.provider === q.provider) &&
        (q.pricing === undefined || q.pricing.includes(a.pricing)),
    );
    return {
      attempts: rows.length,
      costUsd: rows.reduce((n, a) => n + (a.providerCostUsd ?? a.estimatedCostUsd ?? 0), 0),
      tokens: rows.reduce((n, a) => n + (a.inputTokens ?? a.estimatedInputTokens) + (a.outputTokens ?? a.estimatedOutputTokens), 0),
    };
  }

  // ---- spend reservations ------------------------------------------------------------------------
  // Same rules as PostgresStore. Every check-and-insert below runs without an await in between, so it
  // is atomic within this one process; cross-process guarantees exist only on PostgreSQL.

  /** Paid ledger cost already recorded for one request. */
  private recordedUsd(inferenceId: string): number {
    return this.attempts
      .filter((a) => a.inferenceId === inferenceId && a.pricing === "paid")
      .reduce((n, a) => n + (a.providerCostUsd ?? a.estimatedCostUsd ?? 0), 0);
  }

  private usageNow(limits: readonly SpendLimit[]): SpendUsage[] {
    const now = this.clock();
    const holds = [...this.reservations.values()]
      .filter((r) => r.status === "active" && Date.parse(r.expiresAt) > now)
      .map((r) => ({ r, held: Math.max(0, r.reservedUsd - this.recordedUsd(r.inferenceId)) }));
    return limits.map((l) => {
      const since = Date.parse(l.since);
      const inScope = (row: { plan: string; userId: string | null }) =>
        l.scope === "plan_daily" ? row.plan === l.plan : l.scope === "user_daily" ? row.userId === l.userId : true;
      const actualUsd = round10(
        this.attempts
          .filter((a) => a.pricing === "paid" && Date.parse(a.createdAt) >= since && inScope(a))
          .reduce((n, a) => n + (a.providerCostUsd ?? a.estimatedCostUsd ?? 0), 0),
      );
      const reservedUsd = round10(holds.filter((h) => inScope(h.r)).reduce((n, h) => n + h.held, 0));
      return { scope: l.scope, limitUsd: l.limitUsd, actualUsd, reservedUsd, availableUsd: round10(l.limitUsd - actualUsd - reservedUsd) };
    });
  }

  async spendUsage(limits: readonly SpendLimit[]): Promise<SpendUsage[]> {
    return this.usageNow(limits);
  }

  async reserveSpend(input: ReserveSpendInput): Promise<ReserveSpendResult> {
    const amountUsd = Math.ceil(Math.max(0, input.amountUsd) * 1e10 - 1e-6) / 1e10;
    const usage = this.usageNow(input.limits);
    const blocked = usage.find((u) => Math.round((u.actualUsd + u.reservedUsd + amountUsd) * 1e10) > Math.round(u.limitUsd * 1e10));
    if (blocked) return { ok: false, blockedBy: blocked.scope, usage };
    if ([...this.reservations.values()].some((r) => r.inferenceId === input.inferenceId)) throw new Error("duplicate spend reservation");
    if (input.userId !== null && !this.users.has(input.userId)) throw new Error("spend reservation for an unknown account");
    const now = this.clock();
    const reservation: SpendReservationRecord = {
      id: input.id,
      inferenceId: input.inferenceId,
      userId: input.userId,
      plan: input.plan,
      task: input.task,
      provider: input.provider,
      model: input.model,
      reservedUsd: amountUsd,
      actualUsd: null,
      status: "active",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + Math.max(1, Math.round(input.leaseMs))).toISOString(),
      finishedAt: null,
    };
    this.reservations.set(reservation.id, reservation);
    return { ok: true, reservation: { ...reservation }, usage };
  }

  async settleSpendReservation(id: string): Promise<SettleSpendResult | undefined> {
    const r = this.reservations.get(id);
    if (!r) return undefined;
    if (!(r.status === "active" || (r.status === "expired" && r.actualUsd === null))) return { reservation: { ...r }, alreadyFinished: true };
    const now = this.clock();
    const actual = round10(this.recordedUsd(r.inferenceId));
    r.actualUsd = actual;
    r.status = r.status === "expired" || Date.parse(r.expiresAt) <= now ? "expired" : actual > 0 ? "settled" : "released";
    r.finishedAt ??= new Date(now).toISOString();
    return { reservation: { ...r }, alreadyFinished: false };
  }

  async getSpendReservation(id: string): Promise<SpendReservationRecord | undefined> {
    const r = this.reservations.get(id);
    return r && { ...r };
  }

  async sweepSpendReservations(limit: number, retentionMs: number): Promise<{ expired: number; purged: number }> {
    const now = this.clock();
    let expired = 0;
    let purged = 0;
    for (const r of this.reservations.values()) {
      if (expired < limit && r.status === "active" && Date.parse(r.expiresAt) <= now) {
        r.status = "expired";
        r.finishedAt = new Date(now).toISOString();
        expired += 1;
      }
    }
    for (const [id, r] of this.reservations) {
      if (purged < limit && r.status !== "active" && r.finishedAt !== null && Date.parse(r.finishedAt) < now - retentionMs) {
        this.reservations.delete(id);
        purged += 1;
      }
    }
    return { expired, purged };
  }

  async getPluginSettings(userId: string): Promise<PluginSettingRecord[]> {
    return [...(this.pluginSettings.get(userId)?.values() ?? [])].map((s) => ({ ...s, grantedScopes: [...s.grantedScopes] }));
  }

  async savePluginSetting(userId: string, setting: PluginSettingRecord): Promise<void> {
    if (!this.owned(userId)) return;
    const map = this.pluginSettings.get(userId) ?? new Map<string, PluginSettingRecord>();
    map.set(setting.pluginId, { ...setting, grantedScopes: [...setting.grantedScopes] });
    this.pluginSettings.set(userId, map);
  }

  async recordToolInvocation(row: ToolInvocationRow): Promise<void> {
    if (!this.owned(row.userId)) return;
    this.toolInvocations.push({ ...row });
  }

  async claimToolExecution(claim: { keyHash: string; userId: string; createdAt: string }): Promise<boolean> {
    if (this.toolExecutions.has(claim.keyHash)) return false;
    this.toolExecutions.set(claim.keyHash, { userId: claim.userId, status: "started" });
    return true;
  }

  async finishToolExecution(keyHash: string, status: string): Promise<void> {
    const e = this.toolExecutions.get(keyHash);
    if (e) e.status = status;
  }

  async listToolInvocations(userId: string, limit: number): Promise<ToolInvocationRow[]> {
    return this.toolInvocations.filter((t) => t.userId === userId).slice(-limit).reverse().map((t) => ({ ...t }));
  }

  async listConversationToolInvocations(userId: string, conversationId: string): Promise<ToolInvocationRow[]> {
    return this.conversationTools(userId, conversationId);
  }

  private conversationTools(userId: string, conversationId: string): ToolInvocationRow[] {
    const live = new Set((this.messages.get(conversationId) ?? []).map((m) => m.id));
    return this.toolInvocations
      .filter((t) => t.userId === userId && t.conversationId === conversationId && live.has(t.messageId))
      .map((t) => ({ ...t }));
  }

  // ---- DASH Automates ----

  private deleteAutomationRows(id: string): void {
    this.automations.delete(id);
    for (const [runId, r] of this.runs) if (r.automationId === id) this.runs.delete(runId);
    for (const [nid, n] of this.notifications) if (n.automationId === id) this.dropNotification(nid);
  }

  private inFlight(automationId: string): boolean {
    for (const r of this.runs.values()) if (r.automationId === automationId && (r.status === "queued" || r.status === "running")) return true;
    return false;
  }

  async countAutomations(userId: string): Promise<number> {
    return [...this.automations.values()].filter((a) => a.userId === userId).length;
  }

  async createAutomation(automation: AutomationRecord): Promise<boolean> {
    if (!this.owned(automation.userId) || this.automations.has(automation.id)) return false;
    this.automations.set(automation.id, structuredClone(automation));
    return true;
  }

  async getAutomation(userId: string, id: string): Promise<AutomationRecord | undefined> {
    const a = this.automations.get(id);
    return a && a.userId === userId ? structuredClone(a) : undefined;
  }

  async listAutomations(userId: string): Promise<AutomationRecord[]> {
    return [...this.automations.values()]
      .filter((a) => a.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .map((a) => structuredClone(a));
  }

  async updateAutomation(automation: AutomationRecord): Promise<boolean> {
    const existing = this.automations.get(automation.id);
    if (!existing || existing.userId !== automation.userId) return false;
    this.automations.set(automation.id, { ...structuredClone(automation), createdAt: existing.createdAt });
    return true;
  }

  async deleteAutomation(userId: string, id: string): Promise<boolean> {
    const a = this.automations.get(id);
    if (!a || a.userId !== userId) return false;
    this.deleteAutomationRows(id);
    return true;
  }

  async listDueAutomations(now: string, limit: number): Promise<AutomationRecord[]> {
    const t = Date.parse(now);
    return [...this.automations.values()]
      .filter((a) => a.status === "active" && a.nextRunAt !== null && Date.parse(a.nextRunAt) <= t)
      .sort((a, b) => Date.parse(a.nextRunAt!) - Date.parse(b.nextRunAt!))
      .slice(0, limit)
      .map((a) => structuredClone(a));
  }

  async scheduleRun(input: ScheduleRunInput): Promise<"queued" | "skipped" | "lost"> {
    const a = this.automations.get(input.automationId);
    if (!a || a.status !== "active" || a.nextRunAt === null || Date.parse(a.nextRunAt) !== Date.parse(input.expectedNextRunAt)) return "lost";
    a.nextRunAt = input.nextRunAt;
    if (input.nextRunAt === null) a.status = "completed";
    a.updatedAt = input.updatedAt;
    if (this.inFlight(a.id)) return "skipped";
    this.runs.set(input.run.id, structuredClone(input.run));
    return "queued";
  }

  async enqueueRun(run: AutomationRunRecord): Promise<boolean> {
    const a = this.automations.get(run.automationId);
    if (!a || a.userId !== run.userId || this.inFlight(run.automationId)) return false;
    this.runs.set(run.id, structuredClone(run));
    return true;
  }

  async claimQueuedRun(now: string, leaseUntil: string): Promise<AutomationRunRecord | undefined> {
    for (const r of this.runs.values()) {
      if (r.status !== "queued") continue;
      r.status = "running";
      r.startedAt = now;
      r.leaseUntil = leaseUntil;
      return structuredClone(r);
    }
    return undefined;
  }

  async finishRun(input: FinishRunInput): Promise<boolean> {
    const r = this.runs.get(input.runId);
    if (!r || r.status !== "running") return false;
    Object.assign(r, {
      status: input.status, content: input.content, errorCode: input.errorCode, finishedAt: input.finishedAt,
      leaseUntil: null, provider: input.provider, model: input.model, demo: input.demo,
    });
    this.notifications.set(input.notification.id, structuredClone(input.notification));
    if (input.pushAt !== null && !this.pushOff.has(r.userId)) {
      const t = Date.parse(input.pushAt);
      for (const device of this.pushDevices.values()) {
        const session = this.sessions.get(device.sessionHash);
        if (device.userId !== r.userId || !session || Date.parse(session.expiresAt) <= t) continue;
        const id = newId();
        this.pushDeliveries.set(id, {
          id, notificationId: input.notification.id, deviceId: device.id, userId: r.userId, status: "pending", attempts: 0,
          nextAttemptAt: input.pushAt, leaseUntil: null, lastError: null, createdAt: input.pushAt, updatedAt: input.pushAt,
        });
      }
    }
    const finished = [...this.runs.values()].filter((x) => x.automationId === r.automationId && (x.status === "ready" || x.status === "failed")).reverse();
    for (const old of finished.slice(input.keep)) {
      this.runs.delete(old.id);
      for (const [nid, n] of this.notifications) if (n.runId === old.id) this.dropNotification(nid);
    }
    return true;
  }

  async discardRun(runId: string): Promise<void> {
    if (this.runs.get(runId)?.status === "running") this.runs.delete(runId);
  }

  async listStaleRuns(now: string, limit: number): Promise<AutomationRunRecord[]> {
    const t = Date.parse(now);
    return [...this.runs.values()]
      .filter((r) => r.status === "running" && r.leaseUntil !== null && Date.parse(r.leaseUntil) < t)
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }

  async getRun(userId: string, automationId: string, runId: string): Promise<AutomationRunRecord | undefined> {
    const r = this.runs.get(runId);
    return r && r.userId === userId && r.automationId === automationId ? structuredClone(r) : undefined;
  }

  async listRuns(userId: string, automationId: string, limit: number): Promise<AutomationRunRecord[]> {
    return [...this.runs.values()]
      .filter((r) => r.userId === userId && r.automationId === automationId)
      .reverse()
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }

  async updateRunContent(userId: string, automationId: string, runId: string, content: string, editedAt: string): Promise<boolean> {
    const r = this.runs.get(runId);
    if (!r || r.userId !== userId || r.automationId !== automationId || r.status !== "ready") return false;
    r.content = content;
    r.editedAt = editedAt;
    return true;
  }

  async listNotifications(userId: string, limit: number): Promise<NotificationRecord[]> {
    return [...this.notifications.values()]
      .filter((n) => n.userId === userId)
      .reverse()
      .slice(0, limit)
      .map((n) => structuredClone(n));
  }

  async countUnreadNotifications(userId: string): Promise<number> {
    return [...this.notifications.values()].filter((n) => n.userId === userId && n.readAt === null).length;
  }

  async markNotificationsRead(userId: string, ids: string[] | null, readAt: string): Promise<number> {
    let changed = 0;
    const wanted = ids ? new Set(ids) : null;
    for (const n of this.notifications.values()) {
      if (n.userId !== userId || n.readAt !== null || (wanted && !wanted.has(n.id))) continue;
      n.readAt = readAt;
      changed += 1;
    }
    return changed;
  }

  // ---- Push notifications ----

  async upsertPushDevice(input: UpsertPushDeviceInput): Promise<PushDeviceRecord | undefined> {
    const session = this.sessions.get(input.sessionHash);
    if (!session || session.userId !== input.userId || !this.owned(input.userId)) return undefined;
    let same: PushDeviceRecord | undefined;
    for (const [id, d] of this.pushDevices) {
      if (d.sessionHash !== input.sessionHash && d.token !== input.token) continue;
      if (d.sessionHash === input.sessionHash && d.token === input.token && d.userId === input.userId) same = d;
      else this.dropPushDevice(id);
    }
    if (same) {
      Object.assign(same, { platform: input.platform, appVersion: input.appVersion, updatedAt: input.now });
      return structuredClone(same);
    }
    const record: PushDeviceRecord = {
      id: input.id, userId: input.userId, sessionHash: input.sessionHash, platform: input.platform, token: input.token,
      appVersion: input.appVersion, createdAt: input.now, updatedAt: input.now,
    };
    this.pushDevices.set(record.id, record);
    return structuredClone(record);
  }

  async getPushDeviceForSession(sessionHash: string): Promise<PushDeviceRecord | undefined> {
    for (const d of this.pushDevices.values()) if (d.sessionHash === sessionHash) return structuredClone(d);
    return undefined;
  }

  async listPushDevices(userId: string): Promise<PushDeviceRecord[]> {
    return [...this.pushDevices.values()].filter((d) => d.userId === userId).map((d) => structuredClone(d));
  }

  async deletePushDevice(userId: string, id: string): Promise<boolean> {
    const d = this.pushDevices.get(id);
    if (!d || d.userId !== userId) return false;
    this.dropPushDevice(id);
    return true;
  }

  async deletePushDeviceForSession(sessionHash: string): Promise<boolean> {
    for (const [id, d] of this.pushDevices) {
      if (d.sessionHash === sessionHash) {
        this.dropPushDevice(id);
        return true;
      }
    }
    return false;
  }

  async removeInvalidPushDevice(id: string): Promise<boolean> {
    if (!this.pushDevices.has(id)) return false;
    this.dropPushDevice(id);
    return true;
  }

  async getPushPreferences(userId: string): Promise<{ automates: boolean }> {
    return { automates: !this.pushOff.has(userId) };
  }

  async setPushPreferences(userId: string, prefs: { automates: boolean }): Promise<void> {
    if (!this.owned(userId)) return;
    if (prefs.automates) this.pushOff.delete(userId);
    else this.pushOff.add(userId);
  }

  async claimPushDeliveries(now: string, leaseUntil: string, limit: number): Promise<ClaimedPushDelivery[]> {
    const t = Date.parse(now);
    const due = [...this.pushDeliveries.values()]
      .filter(
        (d) =>
          (d.status === "pending" && d.nextAttemptAt !== null && Date.parse(d.nextAttemptAt) <= t) ||
          (d.status === "sending" && d.leaseUntil !== null && Date.parse(d.leaseUntil) < t),
      )
      .sort((a, b) => Date.parse(a.nextAttemptAt ?? a.createdAt) - Date.parse(b.nextAttemptAt ?? b.createdAt))
      .slice(0, limit);
    const out: ClaimedPushDelivery[] = [];
    for (const d of due) {
      const device = this.pushDevices.get(d.deviceId);
      const notification = this.notifications.get(d.notificationId);
      if (!device || !notification) continue;
      Object.assign(d, { status: "sending", attempts: d.attempts + 1, leaseUntil, updatedAt: now });
      const session = this.sessions.get(device.sessionHash);
      out.push({
        delivery: structuredClone(d),
        device: structuredClone(device),
        notification: structuredClone(notification),
        sessionValid: !!session && Date.parse(session.expiresAt) > t,
        automatesEnabled: !this.pushOff.has(d.userId),
      });
    }
    return out;
  }

  async finishPushDelivery(input: FinishPushDeliveryInput): Promise<boolean> {
    const d = this.pushDeliveries.get(input.id);
    if (!d || d.status !== "sending") return false;
    Object.assign(d, { status: input.status, nextAttemptAt: input.nextAttemptAt, leaseUntil: null, lastError: input.lastError, updatedAt: input.now });
    return true;
  }

  async listPushDeliveries(userId: string): Promise<PushDeliveryRecord[]> {
    return [...this.pushDeliveries.values()].filter((d) => d.userId === userId).map((d) => structuredClone(d));
  }

  async close(): Promise<void> {}
}

const round10 = (usd: number): number => Math.round(usd * 1e10) / 1e10;
