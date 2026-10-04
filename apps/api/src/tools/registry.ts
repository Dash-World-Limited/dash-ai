import { z } from "zod";
import {
  PluginId,
  ScopeId,
  ToolName,
  qualifiedToolName,
  type PluginInfo,
  type PluginToolInfo,
} from "@dash-ai/contracts";
import type { NormalizedTool, PluginSettingRecord, ToolDefinition, ToolPlugin } from "./types.js";

/** Hard ceiling on any tool's runtime, whatever a plugin asks for. */
export const MAX_TOOL_TIMEOUT_MS = 120_000;
const MAX_PROVIDER_NAME = 64;

export class PluginRegistrationError extends Error {}

interface RegisteredTool {
  plugin: ToolPlugin;
  tool: ToolDefinition;
  qualifiedName: string;
  normalized: NormalizedTool;
}

/**
 * What one request may offer to a model. Built per request from the user's own settings:
 * the executor refuses anything that is not in here, whatever the model emits.
 */
export class OfferedTools {
  constructor(private readonly entries: ReadonlyMap<string, RegisteredTool>) {}

  get size(): number {
    return this.entries.size;
  }

  list(): NormalizedTool[] {
    return [...this.entries.values()].map((e) => e.normalized);
  }

  get(qualifiedName: string): RegisteredTool | undefined {
    return this.entries.get(qualifiedName);
  }

  /** Tools present in both sets: offered to the model AND still permitted right now. */
  intersect(other: OfferedTools): OfferedTools {
    return new OfferedTools(new Map([...this.entries].filter(([name]) => other.entries.has(name))));
  }

  static readonly none = new OfferedTools(new Map());
}

export type { RegisteredTool };

/**
 * Registry of every plugin this server knows about. Registration is code-only: nothing a model,
 * a user or a request emits can add a plugin or a tool.
 */
export class PluginRegistry {
  private readonly plugins = new Map<string, ToolPlugin>();
  private readonly tools = new Map<string, RegisteredTool>();

  register(plugin: ToolPlugin): this {
    const id = PluginId.safeParse(plugin.id);
    if (!id.success) throw new PluginRegistrationError(`Invalid plugin id "${plugin.id}".`);
    if (this.plugins.has(plugin.id)) throw new PluginRegistrationError(`Plugin "${plugin.id}" is already registered.`);
    const scopeIds = new Set<string>();
    for (const scope of plugin.scopes) {
      if (!ScopeId.safeParse(scope.id).success) throw new PluginRegistrationError(`Invalid scope "${scope.id}".`);
      if (scopeIds.has(scope.id)) throw new PluginRegistrationError(`Duplicate scope "${scope.id}".`);
      scopeIds.add(scope.id);
    }
    const staged: RegisteredTool[] = [];
    for (const tool of plugin.tools) {
      if (!ToolName.safeParse(tool.name).success) throw new PluginRegistrationError(`Invalid tool name "${tool.name}".`);
      const qualifiedName = qualifiedToolName(plugin.id, tool.name);
      if (qualifiedName.length > MAX_PROVIDER_NAME || qualifiedName.includes("___")) {
        throw new PluginRegistrationError(`Tool name "${qualifiedName}" is not a valid provider function name.`);
      }
      if (this.tools.has(qualifiedName) || staged.some((s) => s.qualifiedName === qualifiedName)) {
        throw new PluginRegistrationError(`Duplicate tool "${qualifiedName}".`);
      }
      if (!scopeIds.has(tool.scope)) {
        throw new PluginRegistrationError(`Tool "${qualifiedName}" uses undeclared scope "${tool.scope}".`);
      }
      const declared = plugin.scopes.find((s) => s.id === tool.scope)!;
      if (declared.risk === "read" && tool.risk === "write") {
        throw new PluginRegistrationError(`Tool "${qualifiedName}" writes but its scope "${tool.scope}" is read-only.`);
      }
      if (tool.description.trim().length === 0) throw new PluginRegistrationError(`Tool "${qualifiedName}" needs a description.`);
      if (tool.timeoutMs !== undefined && (tool.timeoutMs < 1 || tool.timeoutMs > MAX_TOOL_TIMEOUT_MS)) {
        throw new PluginRegistrationError(`Tool "${qualifiedName}" has an invalid timeout.`);
      }
      const inputSchema = z.toJSONSchema(tool.input, { target: "draft-2020-12", io: "input" }) as Record<string, unknown>;
      if (inputSchema.type !== "object") throw new PluginRegistrationError(`Tool "${qualifiedName}" input must be an object.`);
      delete inputSchema.$schema;
      staged.push({
        plugin,
        tool,
        qualifiedName,
        normalized: { name: qualifiedName, description: tool.description, inputSchema },
      });
    }
    this.plugins.set(plugin.id, plugin);
    for (const s of staged) this.tools.set(s.qualifiedName, s);
    return this;
  }

  listPlugins(): ToolPlugin[] {
    return [...this.plugins.values()];
  }

  getPlugin(id: string): ToolPlugin | undefined {
    return this.plugins.get(id);
  }

  /** Looks a tool up by the name a model emitted. Unknown names return undefined. */
  findTool(qualifiedName: string): RegisteredTool | undefined {
    return this.tools.get(qualifiedName);
  }

  /** Write tools are registered but not executable until a per-call confirmation flow exists. */
  static isExecutable(tool: ToolDefinition): boolean {
    return tool.risk === "read";
  }

  /**
   * Permission model. A tool is offered to a model only if ALL hold:
   *   1. its plugin is registered on this server,
   *   2. the user enabled that plugin,
   *   3. the user granted the tool's scope,
   *   4. the tool is read-only (write tools are not auto-executed in this milestone).
   */
  offeredFor(settings: readonly PluginSettingRecord[]): OfferedTools {
    const entries = new Map<string, RegisteredTool>();
    for (const setting of settings) {
      if (!setting.enabled) continue;
      const plugin = this.plugins.get(setting.pluginId);
      if (!plugin) continue;
      const granted = new Set(setting.grantedScopes);
      for (const tool of plugin.tools) {
        if (!granted.has(tool.scope) || !PluginRegistry.isExecutable(tool)) continue;
        const registered = this.tools.get(qualifiedToolName(plugin.id, tool.name));
        if (registered) entries.set(registered.qualifiedName, registered);
      }
    }
    return new OfferedTools(entries);
  }

  /** Describes every plugin together with one user's choices. */
  describe(settings: readonly PluginSettingRecord[]): PluginInfo[] {
    const byId = new Map(settings.map((s) => [s.pluginId, s]));
    return this.listPlugins().map((p) => {
      const setting = byId.get(p.id);
      const tools: PluginToolInfo[] = p.tools.map((t) => ({
        name: t.name,
        qualifiedName: qualifiedToolName(p.id, t.name),
        description: t.description,
        scope: t.scope,
        risk: t.risk,
        executable: PluginRegistry.isExecutable(t),
      }));
      return {
        id: p.id,
        name: p.name,
        description: p.description,
        version: p.version,
        kind: p.kind,
        scopes: p.scopes,
        tools,
        enabled: setting?.enabled ?? false,
        grantedScopes: setting?.enabled ? setting.grantedScopes : [],
      };
    });
  }
}
