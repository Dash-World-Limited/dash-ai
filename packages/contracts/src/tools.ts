import { z } from "zod";
import { Id, IsoDateTime, ProviderId } from "./common.js";

/** Plugin ids and tool names are restricted so `${plugin}__${tool}` is a valid provider function name. */
export const PluginId = z.string().regex(/^[a-z][a-z0-9-]{1,31}$/, "Invalid plugin id");
export type PluginId = z.infer<typeof PluginId>;
export const ToolName = z.string().regex(/^[a-z][a-z0-9_]{1,47}$/, "Invalid tool name");
export type ToolName = z.infer<typeof ToolName>;
export const ScopeId = z.string().regex(/^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/, "Invalid scope");

/** read = no side effects. write = changes something outside Dash AI (never auto-executed yet). */
export const ToolRisk = z.enum(["read", "write"]);
export type ToolRisk = z.infer<typeof ToolRisk>;

/**
 * Outcome of one tool call. Anything other than "ok" and "duplicate" is reported to the model as an
 * error. "duplicate": the call was not run because it repeats one already handled (same call id in
 * this response, or the same action for the same user message on a tool that runs at most once).
 */
export const ToolCallStatus = z.enum([
  "ok",
  "duplicate",
  "invalid_arguments",
  "denied",
  "unknown_tool",
  "timeout",
  "error",
  "cancelled",
]);
export type ToolCallStatus = z.infer<typeof ToolCallStatus>;

export const PluginScope = z.object({ id: ScopeId, description: z.string(), risk: ToolRisk });
export type PluginScope = z.infer<typeof PluginScope>;

export const PluginToolInfo = z.object({
  name: ToolName,
  /** The name providers see: `${plugin}__${tool}`. */
  qualifiedName: z.string(),
  description: z.string(),
  scope: ScopeId,
  risk: ToolRisk,
  /** False when the tool exists but this server will not run it yet (e.g. write tools). */
  executable: z.boolean(),
});
export type PluginToolInfo = z.infer<typeof PluginToolInfo>;

export const PluginInfo = z.object({
  id: PluginId,
  name: z.string(),
  description: z.string(),
  version: z.string(),
  /** builtin ships with Dash AI and needs no external service; external talks to a third-party service. */
  kind: z.enum(["builtin", "external"]),
  scopes: z.array(PluginScope),
  tools: z.array(PluginToolInfo),
  /** This user's choice. Plugins are off until the user turns them on. */
  enabled: z.boolean(),
  grantedScopes: z.array(ScopeId),
});
export type PluginInfo = z.infer<typeof PluginInfo>;

export const PluginsResponse = z.object({
  /** Server-wide kill switch (TOOLS_ENABLED). When false no tool is ever offered to a model. */
  toolsEnabled: z.boolean(),
  plugins: z.array(PluginInfo),
});
export type PluginsResponse = z.infer<typeof PluginsResponse>;

export const UpdatePluginRequest = z.object({
  enabled: z.boolean(),
  /** Defaults to every read scope of the plugin. Write scopes must be listed explicitly. */
  grantedScopes: z.array(ScopeId).max(32).optional(),
});
export type UpdatePluginRequest = z.infer<typeof UpdatePluginRequest>;

/** Audit metadata for one tool call. Never contains arguments or results. */
export const ToolActivity = z.object({
  conversationId: Id,
  messageId: Id,
  callId: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/),
  /** Diagnostics only: omitted by production servers. */
  provider: ProviderId.optional(),
  plugin: z.string(),
  tool: z.string(),
  status: ToolCallStatus,
  durationMs: z.number().int().nonnegative(),
  argBytes: z.number().int().nonnegative(),
  resultChars: z.number().int().nonnegative(),
  createdAt: IsoDateTime,
});
export type ToolActivity = z.infer<typeof ToolActivity>;

export const ToolActivityResponse = z.object({ activity: z.array(ToolActivity) });
export type ToolActivityResponse = z.infer<typeof ToolActivityResponse>;

/** Per-user plugin choice, as exported with the user's data. */
export const PluginSetting = z.object({
  pluginId: PluginId,
  enabled: z.boolean(),
  grantedScopes: z.array(ScopeId),
  updatedAt: IsoDateTime,
});
export type PluginSetting = z.infer<typeof PluginSetting>;

/** `${plugin}__${tool}`: the provider-safe name of a tool (≤64 chars, [a-zA-Z0-9_-]). */
export const qualifiedToolName = (plugin: string, tool: string): string => `${plugin}__${tool}`;
