import { ProviderId, type ProviderStatus } from "@dash-ai/contracts";
import type { AppConfig } from "../config.js";
import { AnthropicAdapter } from "./anthropic.js";
import { BedrockAdapter } from "./bedrock.js";
import { bedrockConfigured, bedrockProblems, looksLikePlaceholder } from "./credentials.js";
import { FakeAdapter } from "./fake.js";
import { OpenAIAdapter } from "./openai.js";
import type { ProviderAdapter } from "./types.js";

const DISPLAY: Record<ProviderId, string> = {
  openai: "OpenAI",
  anthropic: "Claude",
  bedrock: "Amazon Bedrock",
};

export { looksLikePlaceholder };

export class ProviderRegistry {
  constructor(
    private readonly adapters: Partial<Record<ProviderId, ProviderAdapter>>,
    readonly warnings: string[] = [],
  ) {}

  static fromConfig(config: AppConfig): ProviderRegistry {
    if (config.providerMode === "fake") {
      // Demo Mode intentionally stays the same two deterministic fake adapters. Bedrock is real
      // infrastructure only and remains unconfigured while PROVIDER_MODE=fake.
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
    const { openai, anthropic, bedrock } = config;

    if (openai.apiKey && openai.model) {
      // maxRetries 0: retries happen in one place, the orchestrator (bounded, cancellable, counted),
      // instead of multiplying SDK retries by orchestrator retries.
      adapters.openai = new OpenAIAdapter(openai.apiKey, openai.model, {
        encryptedReasoning: openai.encryptedReasoning,
        maxRetries: 0,
      });
    }
    if (!(openai.apiKey && openai.model) && (openai.apiKey || openai.model)) {
      warnings.push("OpenAI needs both OPENAI_API_KEY and OPENAI_MODEL.");
    }
    if (openai.apiKey && looksLikePlaceholder(openai.apiKey)) {
      warnings.push("OPENAI_API_KEY looks like a placeholder, not a real key: OpenAI will refuse requests.");
    }

    if (anthropic.apiKey && looksLikePlaceholder(anthropic.apiKey)) {
      warnings.push("ANTHROPIC_API_KEY looks like a placeholder, not a real key: Claude will refuse requests.");
    }
    if (anthropic.apiKey && anthropic.model) {
      adapters.anthropic = new AnthropicAdapter(anthropic.apiKey, anthropic.model, { maxRetries: 0 });
    } else if (anthropic.apiKey || anthropic.model) {
      warnings.push("Claude needs both ANTHROPIC_API_KEY and ANTHROPIC_MODEL.");
    }

    // Development and tests start anyway and report what is missing; production refuses to start
    // with the same problems (config.ts).
    for (const problem of bedrockProblems(bedrock)) warnings.push(`Amazon Bedrock: ${problem}`);
    if (bedrockConfigured(bedrock) && bedrockProblems(bedrock).length === 0) {
      adapters.bedrock = new BedrockAdapter(
        bedrock.auth === "iam" ? { kind: "iam" } : { kind: "api_key", apiKey: bedrock.apiKey! },
        bedrock.region!,
        bedrock.models,
      );
    }

    if (Object.keys(adapters).length === 0) {
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
    return ProviderId.options.map((id) => {
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
