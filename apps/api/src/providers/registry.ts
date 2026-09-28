import type { ProviderId, ProviderStatus } from "@dash-ai/contracts";
import type { AppConfig } from "../config.js";
import { AnthropicAdapter } from "./anthropic.js";
import { FakeAdapter } from "./fake.js";
import { OpenAIAdapter } from "./openai.js";
import type { ProviderAdapter } from "./types.js";

const DISPLAY: Record<ProviderId, string> = { openai: "OpenAI", anthropic: "Claude" };

export class ProviderRegistry {
  constructor(
    private readonly adapters: Partial<Record<ProviderId, ProviderAdapter>>,
    readonly warnings: string[] = [],
  ) {}

  static fromConfig(config: AppConfig): ProviderRegistry {
    if (config.providerMode === "fake") {
      return new ProviderRegistry(
        {
          openai: new FakeAdapter("openai", config.fakeStreamDelayMs),
          anthropic: new FakeAdapter("anthropic", config.fakeStreamDelayMs),
        },
        ["PROVIDER_MODE=fake: fake demonstration adapters are active; no real provider will be called."],
      );
    }
    const adapters: Partial<Record<ProviderId, ProviderAdapter>> = {};
    const warnings: string[] = [];
    const { openai, anthropic } = config;
    if (openai.apiKey && openai.model) adapters.openai = new OpenAIAdapter(openai.apiKey, openai.model);
    else if (openai.apiKey || openai.model) warnings.push("OpenAI needs both OPENAI_API_KEY and OPENAI_MODEL.");
    if (anthropic.apiKey && anthropic.model) {
      adapters.anthropic = new AnthropicAdapter(anthropic.apiKey, anthropic.model);
    } else if (anthropic.apiKey || anthropic.model) {
      warnings.push("Claude needs both ANTHROPIC_API_KEY and ANTHROPIC_MODEL.");
    }
    if (!adapters.openai && !adapters.anthropic) {
      warnings.push("No AI provider is configured. Chat requests will fail until one is configured.");
    }
    return new ProviderRegistry(adapters, warnings);
  }

  get(id: ProviderId): ProviderAdapter | undefined {
    return this.adapters[id];
  }

  configured(): Set<ProviderId> {
    return new Set((Object.keys(this.adapters) as ProviderId[]).filter((id) => this.adapters[id]));
  }

  status(): ProviderStatus[] {
    return (["openai", "anthropic"] as const).map((id) => {
      const adapter = this.adapters[id];
      return {
        id,
        displayName: DISPLAY[id],
        configured: Boolean(adapter),
        model: adapter?.model ?? null,
        mode: adapter ? (adapter.demo ? "fake" : "live") : "unconfigured",
      };
    });
  }
}
