import type { ProviderId, ProviderStatus } from "@dash-ai/contracts";
import type { AppConfig } from "../config.js";
import { AnthropicAdapter } from "./anthropic.js";
import { FakeAdapter } from "./fake.js";
import { OpenAIAdapter } from "./openai.js";
import type { ProviderAdapter } from "./types.js";

const DISPLAY: Record<ProviderId, string> = { openai: "OpenAI", anthropic: "Claude" };

/**
 * Values copied from an example instead of a real secret ("your-key", "sk-...", "changeme"), or a key
 * with spaces inside it. Such a provider is still configured (the provider decides), but start-up
 * says why its requests will be refused. The key itself is never logged.
 */
export function looksLikePlaceholder(key: string): boolean {
  return /\s/.test(key) || /\.\.\.|^<|>$|your[-_ ]?(api[-_ ]?)?key|changeme|placeholder|^x{6,}$|^replace/i.test(key) || key.length < 16;
}

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
    if (openai.apiKey && openai.model) {
      // maxRetries 0: retries happen in one place, the orchestrator (bounded, cancellable, counted),
      // instead of multiplying SDK retries by orchestrator retries.
      adapters.openai = new OpenAIAdapter(openai.apiKey, openai.model, { encryptedReasoning: openai.encryptedReasoning, maxRetries: 0 });
    }
    if (!(openai.apiKey && openai.model) && (openai.apiKey || openai.model)) warnings.push("OpenAI needs both OPENAI_API_KEY and OPENAI_MODEL.");
    if (openai.apiKey && looksLikePlaceholder(openai.apiKey)) warnings.push("OPENAI_API_KEY looks like a placeholder, not a real key: OpenAI will refuse requests.");
    if (anthropic.apiKey && looksLikePlaceholder(anthropic.apiKey)) warnings.push("ANTHROPIC_API_KEY looks like a placeholder, not a real key: Claude will refuse requests.");
    if (anthropic.apiKey && anthropic.model) {
      adapters.anthropic = new AnthropicAdapter(anthropic.apiKey, anthropic.model, { maxRetries: 0 });
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
