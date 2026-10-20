import type { AppConfig } from "../config.js";
import type { Store } from "../store/store.js";
import { ToolExecutor } from "./executor.js";
import { builtinPlugin } from "./builtin.js";
import { OfferedTools, PluginRegistry } from "./registry.js";

/** Wires the registry, executor and per-user permissions together for the routes and orchestrator. */
export class ToolRuntime {
  readonly executor: ToolExecutor;

  constructor(
    readonly registry: PluginRegistry,
    readonly enabled: boolean,
    options: { defaultTimeoutMs: number; maxResultChars: number; maxRounds: number },
    private readonly store: Store,
  ) {
    this.executor = new ToolExecutor(registry, options, store);
    this.maxRounds = options.maxRounds;
    this.maxResultChars = options.maxResultChars;
  }

  readonly maxRounds: number;
  /** The bound on one tool result's characters (longer results are truncated). */
  readonly maxResultChars: number;

  /** Plugins shipped with Dash AI. External plugins (GitHub, Gmail, ...) are added by code, never by default. */
  static defaultRegistry(): PluginRegistry {
    return new PluginRegistry().register(builtinPlugin);
  }

  static fromConfig(config: AppConfig, store: Store, registry: PluginRegistry = ToolRuntime.defaultRegistry()): ToolRuntime {
    return new ToolRuntime(
      registry,
      config.tools.enabled,
      { defaultTimeoutMs: config.tools.timeoutMs, maxResultChars: config.tools.maxResultChars, maxRounds: config.tools.maxRounds },
      store,
    );
  }

  /** The tools this user's request may offer to a model right now. */
  async offeredFor(userId: string): Promise<OfferedTools> {
    if (!this.enabled) return OfferedTools.none;
    return this.registry.offeredFor(await this.store.getPluginSettings(userId));
  }
}
