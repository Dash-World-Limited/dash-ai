import type { FastifyBaseLogger } from "fastify";
import type { z } from "zod";
import type { PluginScope, ProviderId, ToolCallStatus, ToolRisk } from "@dash-ai/contracts";

/** Everything a tool handler may know about the call it is serving. */
export interface ToolContext {
  userId: string;
  conversationId: string;
  messageId: string;
  callId: string;
  provider: ProviderId;
  /** Aborted on timeout or when the user stops the response. Handlers should honour it. */
  signal: AbortSignal;
  now: () => Date;
  log: FastifyBaseLogger;
}

/** Throw from a handler to give the model a safe, specific message. Any other error becomes generic. */
export class ToolUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolUserError";
  }
}

/**
 * One capability a plugin offers. `input` is the single source of truth: it validates the model's
 * arguments at runtime and is converted to the JSON Schema each provider adapter sends.
 */
export interface ToolDefinition<S extends z.ZodObject = z.ZodObject> {
  /** Lowercase snake_case. The model sees `${pluginId}__${name}`. */
  name: string;
  /** What the model reads to decide when to use the tool. */
  description: string;
  /** Must be one of the plugin's declared scopes. The user has to grant it. */
  scope: string;
  /** "write" tools change things outside Dash AI. They are registered but never auto-executed yet. */
  risk: ToolRisk;
  input: S;
  /** Overrides the server default (TOOL_TIMEOUT_MS), never exceeds the hard cap. */
  timeoutMs?: number;
  execute(args: z.infer<S>, ctx: ToolContext): Promise<string | Record<string, unknown>>;
}

/** Keeps type inference for `args` while storing heterogeneous tools together. */
export const defineTool = <S extends z.ZodObject>(tool: ToolDefinition<S>): ToolDefinition => tool as unknown as ToolDefinition;

export interface ToolPlugin {
  /** Lowercase, hyphens allowed. Stable: it is stored in user settings and audit records. */
  id: string;
  name: string;
  description: string;
  version: string;
  /** builtin: runs inside Dash AI with no outside service. external: reaches a third-party service. */
  kind: "builtin" | "external";
  scopes: PluginScope[];
  tools: ToolDefinition[];
}

/** A tool as providers receive it, independent of any provider's wire format. */
export interface NormalizedTool {
  /** Qualified name: `${plugin}__${tool}`. */
  name: string;
  description: string;
  /** JSON Schema (draft 2020-12 object schema) derived from the zod input schema. */
  inputSchema: Record<string, unknown>;
}

/** A model's request to call a tool, as normalised by a provider adapter. Never trusted. */
export interface ModelToolCall {
  id: string;
  /** Qualified name exactly as the model emitted it. */
  name: string;
  /** Raw JSON text of the arguments exactly as the model emitted it. */
  argumentsJson: string;
}

export interface ToolExecution {
  callId: string;
  name: string;
  plugin: string;
  tool: string;
  status: ToolCallStatus;
  /** What the model is told. Success output, or a short safe description of the failure. */
  content: string;
  isError: boolean;
  durationMs: number;
  argBytes: number;
}

/** Audit row: metadata only, never arguments or results. */
export interface ToolInvocationRow {
  userId: string;
  conversationId: string;
  messageId: string;
  callId: string;
  provider: ProviderId;
  plugin: string;
  tool: string;
  status: ToolCallStatus;
  durationMs: number;
  argBytes: number;
  resultChars: number;
  createdAt: string;
}

export interface PluginSettingRecord {
  pluginId: string;
  enabled: boolean;
  grantedScopes: string[];
  updatedAt: string;
}
