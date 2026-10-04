import type {
  Conversation,
  ConversationMessage,
  DocumentResponse,
  PluginSetting,
  ToolActivity,
  UsageRecord,
  User,
} from "@dash-ai/contracts";
import type {
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

export const toMessage = (m: MessageRecord): ConversationMessage => ({
  id: m.id,
  role: m.role,
  content: m.content,
  origin: m.origin,
  model: m.model,
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

export const toUsage = (u: UsageRow): UsageRecord => ({
  conversationId: u.conversationId,
  messageId: u.messageId,
  provider: u.provider,
  model: u.model,
  demo: u.demo,
  inputTokens: u.inputTokens,
  outputTokens: u.outputTokens,
  createdAt: u.createdAt,
});

export const toToolActivity = (t: ToolInvocationRow): ToolActivity => ({
  conversationId: t.conversationId,
  messageId: t.messageId,
  callId: t.callId,
  provider: t.provider,
  plugin: t.plugin,
  tool: t.tool,
  status: t.status,
  durationMs: t.durationMs,
  argBytes: t.argBytes,
  resultChars: t.resultChars,
  createdAt: t.createdAt,
});

export const toPluginSetting = (s: PluginSettingRecord): PluginSetting => ({
  pluginId: s.pluginId,
  enabled: s.enabled,
  grantedScopes: s.grantedScopes,
  updatedAt: s.updatedAt,
});
