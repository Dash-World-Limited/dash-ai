import type { PluginSettingRecord, ToolInvocationRow } from "../tools/types.js";
import type {
  AssistantMode,
  AutomationRunStatus,
  AutomationRunTrigger,
  AutomationSchedule,
  AutomationStatus,
  NotificationKind,
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
  /** Increases on every title change (see SyncConversation.titleRev). */
  titleRev: number;
  deleted: boolean;
  conversation: ConversationRecord;
  messages: MessageRecord[];
  /** Tool calls recorded for these messages, oldest first (empty for a tombstone). */
  tools: ToolInvocationRow[];
}

export interface ConversationChangePage {
  changes: ConversationChange[];
  /** True when more changes exist after the last one returned. */
  hasMore: boolean;
}

/** Where a conversation id stands for one user. Another user's id is reported as "absent". */
export type ConversationState = "live" | "deleted" | "absent";

export interface PushConversationInput {
  conversation: ConversationRecord;
  /** User messages written on a device, oldest first. Assistant messages are never accepted from devices. */
  messages: MessageRecord[];
}

export interface PushConversationResult {
  /** created/merged: applied. deleted: the user's own tombstone. rejected: the id belongs to someone else. */
  status: "created" | "merged" | "deleted" | "rejected";
  appended: number;
  skipped: number;
}

export interface RenameResult {
  status: "applied" | "conflict" | "deleted" | "not_found";
}

/** A scheduled task. Name and prompt are user content (encrypted at rest by durable stores). */
export interface AutomationRecord {
  id: string;
  userId: string;
  name: string;
  prompt: string;
  mode: AssistantMode;
  schedule: AutomationSchedule;
  timeZone: string;
  status: AutomationStatus;
  /** Next scheduled run (UTC), or null when paused or completed. */
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * One execution of an automation; also the work queue (status "queued" is claimed by a scheduler).
 * `content` is the result (encrypted at rest). Provider and model are internal diagnostics only.
 */
export interface AutomationRunRecord {
  id: string;
  automationId: string;
  userId: string;
  trigger: AutomationRunTrigger;
  status: AutomationRunStatus;
  content: string;
  /** Normalized failure code (never provider text): provider_error, provider_timeout, rate_limited, unavailable, interrupted. */
  errorCode: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** While running: when another instance may consider this run abandoned. */
  leaseUntil: string | null;
  editedAt: string | null;
  provider: ProviderId | null;
  model: string | null;
  demo: boolean;
}

export interface NotificationRecord {
  id: string;
  userId: string;
  kind: NotificationKind;
  automationId: string;
  runId: string;
  createdAt: string;
  readAt: string | null;
}

/** How a finished run is recorded; the notification is written in the same step. */
export interface FinishRunInput {
  runId: string;
  status: "ready" | "failed";
  content: string;
  errorCode: string | null;
  finishedAt: string;
  provider: ProviderId | null;
  model: string | null;
  demo: boolean;
  notification: NotificationRecord;
  /** Runs kept per automation; older finished runs are removed. */
  keep: number;
}

/** The scheduler's compare-and-set step for one due automation. */
export interface ScheduleRunInput {
  automationId: string;
  /** The nextRunAt the scheduler read: only one instance can move it on. */
  expectedNextRunAt: string;
  /** The following occurrence, or null for a one-time automation (which then becomes completed). */
  nextRunAt: string | null;
  updatedAt: string;
  /** Queued unless a run of this automation is already queued or running. */
  run: AutomationRunRecord;
}

/**
 * Persistence boundary. `PostgresStore` is the production implementation and `MemoryStore` is
 * for isolated tests and local demos. Both are held to the same contract tests
 * (test/store.contract.test.ts).
 */
export interface Store {
  /** True when the store can serve requests (PostgreSQL: a trivial query succeeds). */
  ping(): Promise<boolean>;
  createUser(user: UserRecord): Promise<boolean>;
  findUserByEmail(email: string): Promise<UserRecord | undefined>;
  findUserById(id: string): Promise<UserRecord | undefined>;
  /** Replaces the password hash only if it is still `expected` (a re-hash never overwrites a newer change). */
  replacePasswordHash(userId: string, expected: string, next: string): Promise<boolean>;
  /** Deletes the user and everything they own. */
  deleteUserData(userId: string): Promise<void>;

  createSession(session: SessionRecord): Promise<void>;
  findSession(tokenHash: string): Promise<SessionRecord | undefined>;
  deleteSession(tokenHash: string): Promise<void>;
  /** Signs the user out everywhere. Returns how many sessions were removed. */
  deleteSessionsForUser(userId: string): Promise<number>;

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

  /** live, deleted (own tombstone) or absent (never existed, or belongs to another user). */
  conversationState(userId: string, id: string): Promise<ConversationState>;

  /**
   * Device upload, atomic per conversation. Unknown id: creates it with the messages. The user's live
   * conversation: appends only messages with unknown ids that are newer than the newest stored message
   * (so truncated or replaced history is never resurrected). Own tombstone: nothing changes ("deleted").
   * Someone else's id: nothing changes ("rejected").
   */
  pushConversation(userId: string, input: PushConversationInput): Promise<PushConversationResult>;

  /**
   * Compare-and-set rename. Applied when the title is already the requested one (idempotent), when the
   * server title was never set by a user, or when baseTitleRev matches; otherwise "conflict".
   */
  renameConversationIfCurrent(userId: string, id: string, title: string, baseTitleRev: number | null, now: string): Promise<RenameResult>;

  /** The user's newest change number (0 when nothing has changed yet). */
  latestSyncSeq(userId: string): Promise<number>;

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
  /**
   * Claims an at-most-once tool execution. True only for the first claim of `keyHash`; every later
   * claim (another call id, a retried stream, another instance, after a restart) gets false.
   */
  claimToolExecution(claim: { keyHash: string; userId: string; createdAt: string }): Promise<boolean>;
  /** Records how a claimed execution ended. The claim itself is never released. */
  finishToolExecution(keyHash: string, status: string, finishedAt: string): Promise<void>;
  /** Most recent first. */
  listToolInvocations(userId: string, limit: number): Promise<ToolInvocationRow[]>;
  /**
   * The user's tool calls recorded in one conversation, oldest first, limited to messages that still
   * exist (a regenerated or truncated message takes its tool calls with it).
   */
  listConversationToolInvocations(userId: string, conversationId: string): Promise<ToolInvocationRow[]>;

  // ---- DASH Automates ----
  countAutomations(userId: string): Promise<number>;
  /** False when the user no longer exists. */
  createAutomation(automation: AutomationRecord): Promise<boolean>;
  getAutomation(userId: string, id: string): Promise<AutomationRecord | undefined>;
  /** Newest first. */
  listAutomations(userId: string): Promise<AutomationRecord[]>;
  /** Replaces the mutable fields of the user's automation. False when it does not exist. */
  updateAutomation(automation: AutomationRecord): Promise<boolean>;
  /** Deletes the automation with its runs and notifications. */
  deleteAutomation(userId: string, id: string): Promise<boolean>;
  /** Active automations whose next run is at or before `now`, across all users, oldest first. */
  listDueAutomations(now: string, limit: number): Promise<AutomationRecord[]>;
  /**
   * Moves a due automation's nextRunAt on (compare-and-set) and queues its run in one step. "queued":
   * this caller won and the run is queued. "skipped": this caller won but a run was already in flight,
   * so none was added. "lost": another scheduler (or an edit) got there first; nothing changed.
   */
  scheduleRun(input: ScheduleRunInput): Promise<"queued" | "skipped" | "lost">;
  /** Queues a manual or regenerate run unless one is already queued or running. */
  enqueueRun(run: AutomationRunRecord): Promise<boolean>;
  /** Claims the oldest queued run (any user): it becomes running with a lease. */
  claimQueuedRun(now: string, leaseUntil: string): Promise<AutomationRunRecord | undefined>;
  /** Records the outcome of a running run and its notification; prunes old runs. False if the run is gone. */
  finishRun(input: FinishRunInput): Promise<boolean>;
  /** Drops a running run without a result or notification (a scheduled run whose automation was paused). */
  discardRun(runId: string): Promise<void>;
  /** Running runs whose lease expired before `now` (their instance stopped). */
  listStaleRuns(now: string, limit: number): Promise<AutomationRunRecord[]>;
  getRun(userId: string, automationId: string, runId: string): Promise<AutomationRunRecord | undefined>;
  /** Most recent first. */
  listRuns(userId: string, automationId: string, limit: number): Promise<AutomationRunRecord[]>;
  /** Replaces a ready result's content (the person's edit). */
  updateRunContent(userId: string, automationId: string, runId: string, content: string, editedAt: string): Promise<boolean>;
  /** Most recent first. */
  listNotifications(userId: string, limit: number): Promise<NotificationRecord[]>;
  countUnreadNotifications(userId: string): Promise<number>;
  /** Marks the given notifications (or all when ids is null) read. Returns how many changed. */
  markNotificationsRead(userId: string, ids: string[] | null, readAt: string): Promise<number>;

  /** Deletes sessions that expired before `now`. Returns how many were removed. */
  purgeExpiredSessions(now: Date): Promise<number>;

  /** Releases connections. Safe to call more than once. */
  close(): Promise<void>;
}
