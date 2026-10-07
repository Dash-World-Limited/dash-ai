import type {
  Conversation,
  ConversationMessage,
  DocumentResponse,
  MessageToolActivity,
  PluginSetting,
  SyncChange,
  ToolActivity,
  UsageRecord,
  User,
} from "@dash-ai/contracts";
import type {
  ConversationChange,
  ConversationRecord,
  DocumentSummary,
  MessageRecord,
  PluginSettingRecord,
  ToolInvocationRow,
  UsageRow,
  UserRecord,
} from "../store/store.js";

export const toUser = (u: UserRecord): User => ({
  id: u.id,
  email: u.email,
  displayName: u.displayName,
  createdAt: u.createdAt,
});

export const toConversation = (c: ConversationRecord): Conversation => ({
  id: c.id,
  title: c.title,
  mode: c.mode,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
});

/**
 * How much infrastructure detail a response may carry. `hidden` (production): no provider or model
 * names reach consumers; the store, logs and metrics keep them. See chat/publicSurface.ts.
 */
export interface View {
  hidden: boolean;
}
export const viewFor = (config: { providerDetails: "hidden" | "exposed" }): View => ({ hidden: config.providerDetails !== "exposed" });

export const toMessage = (m: MessageRecord, view: View): ConversationMessage => ({
  id: m.id,
  role: m.role,
  content: m.content,
  origin: view.hidden ? null : m.origin,
  model: view.hidden ? null : m.model,
  demo: m.demo,
  status: m.status,
  compareGroupId: m.compareGroupId,
  createdAt: m.createdAt,
});

export const toDocument = (d: DocumentSummary): DocumentResponse => ({
  id: d.id,
  name: d.name,
  kind: d.kind,
  mimeType: d.mimeType,
  sizeBytes: d.sizeBytes,
  status: d.status,
  statusDetail: d.statusDetail,
  extractedChars: d.extractedChars,
  pageCount: d.pageCount,
  createdAt: d.createdAt,
});

export const toUsage = (u: UsageRow, view: View): UsageRecord => ({
  conversationId: u.conversationId,
  messageId: u.messageId,
  ...(view.hidden ? {} : { provider: u.provider, model: u.model }),
  demo: u.demo,
  inputTokens: u.inputTokens,
  outputTokens: u.outputTokens,
  createdAt: u.createdAt,
});

export const toToolActivity = (t: ToolInvocationRow, view: View): ToolActivity => ({
  conversationId: t.conversationId,
  messageId: t.messageId,
  callId: t.callId,
  ...(view.hidden ? {} : { provider: t.provider }),
  plugin: t.plugin,
  tool: t.tool,
  status: t.status,
  durationMs: t.durationMs,
  argBytes: t.argBytes,
  resultChars: t.resultChars,
  createdAt: t.createdAt,
});

/** What a client shows for a recorded tool call: names, outcome and timing only. */
export const toMessageToolActivity = (t: ToolInvocationRow): MessageToolActivity => ({
  messageId: t.messageId,
  callId: t.callId,
  plugin: t.plugin,
  tool: t.tool,
  status: t.status,
  durationMs: t.durationMs,
  createdAt: t.createdAt,
});

export const toPluginSetting = (s: PluginSettingRecord): PluginSetting => ({
  pluginId: s.pluginId,
  enabled: s.enabled,
  grantedScopes: s.grantedScopes,
  updatedAt: s.updatedAt,
});

export const toSyncChange = (c: ConversationChange, view: View): SyncChange => ({
  seq: c.seq,
  deleted: c.deleted,
  conversation: { ...toConversation(c.conversation), titleIsCustom: c.conversation.titleIsCustom, titleRev: c.titleRev },
  messages: c.messages.map((m) => toMessage(m, view)),
  toolActivity: c.tools.map(toMessageToolActivity),
});
