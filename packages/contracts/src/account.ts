import { z } from "zod";
import { Id, IsoDateTime, ProviderId } from "./common.js";
import { User } from "./auth.js";
import { AutomationExport } from "./automations.js";
import { ConversationDetailResponse } from "./conversations.js";
import { DocumentResponse } from "./documents.js";
import { PluginSetting, ToolActivity } from "./tools.js";

export const UsageRecord = z.object({
  conversationId: Id,
  messageId: Id,
  /** Diagnostics only: omitted by production servers. */
  provider: ProviderId.optional(),
  model: z.string().optional(),
  demo: z.boolean(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  createdAt: IsoDateTime,
});
export type UsageRecord = z.infer<typeof UsageRecord>;

/** One row per provider in diagnostics mode; a single DASH AI total (no provider) in production. */
export const UsageTotals = z.object({
  provider: ProviderId.optional(),
  requests: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});

export const UsageSummaryResponse = z.object({
  totals: z.array(UsageTotals),
  recent: z.array(UsageRecord),
});
export type UsageSummaryResponse = z.infer<typeof UsageSummaryResponse>;

export const MeResponse = z.object({ user: User });
export type MeResponse = z.infer<typeof MeResponse>;

/** Everything the API holds about a user, for data-portability requests. */
export const DataExportResponse = z.object({
  exportedAt: IsoDateTime,
  user: User,
  conversations: z.array(ConversationDetailResponse),
  documents: z.array(DocumentResponse),
  usage: z.array(UsageRecord),
  /** Older exports lack these; they default to empty. */
  plugins: z.array(PluginSetting).default([]),
  toolActivity: z.array(ToolActivity).default([]),
  automations: z.array(AutomationExport).default([]),
});
export type DataExportResponse = z.infer<typeof DataExportResponse>;
