import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it } from "vitest";
import { InMemoryAttemptLedger } from "../src/intelligence/attemptLedgerMemory.js";
import { generateText } from "../src/intelligence/generate.js";
import { IntelligenceRouter } from "../src/intelligence/router.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { ProviderError, type ProviderAdapter, type ProviderChunk, type ProviderRequest } from "../src/providers/types.js";
import { testConfig } from "./helpers.js";

class SequenceAdapter implements ProviderAdapter {
  readonly displayName: string;
  readonly model: string;
  readonly demo = false;
  calls = 0;

  constructor(
    readonly id: "openai" | "anthropic",
    private readonly outcomes: Array<"rate_limited" | "success">,
  ) {
    this.displayName = id;
    this.model = `model-${id}`;
  }

  async *stream(_request: ProviderRequest): AsyncIterable<ProviderChunk> {
    const outcome = this.outcomes[this.calls++] ?? "success";
    if (outcome === "rate_limited") throw new ProviderError("rate_limited", "test", true, 429);
    yield { type: "text", text: `answer-${this.id}` };
    yield { type: "finish", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 5 }, servedModel: `served-${this.id}` };
  }
}

const log = {
  warn: () => undefined,
  info: () => undefined,
} as unknown as FastifyBaseLogger;

const request = {
  task: "automation" as const,
  mode: "general" as const,
  instructions: "Do the scheduled task.",
  prompt: "Prepare the result.",
  inferenceId: "inference-accounting-test",
  userId: "user-accounting-test",
};

describe("background inference attempt accounting", () => {
  it("records every retry separately and keeps the successful provider-reported usage", async () => {
    const config = testConfig({ PROVIDER_MAX_RETRIES: "1" });
    const openai = new SequenceAdapter("openai", ["rate_limited", "success"]);
    const providers = new ProviderRegistry({ openai });
    const router = new IntelligenceRouter(config.routerPolicy, () => providers.configured());
    const ledger = new InMemoryAttemptLedger();

    const result = await generateText({ providers, router, config, log, attemptLedger: ledger }, request);

    expect(result.provider).toBe("openai");
    expect(result.model).toBe("served-openai");
    const rows = ledger.list();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.attemptIndex, r.fallbackIndex, r.status, r.errorCode])).toEqual([
      [0, 0, "failure", "rate_limited"],
      [1, 0, "success", null],
    ]);
    expect(rows[0]).toMatchObject({ inferenceId: request.inferenceId, userId: request.userId, usageSource: "unknown" });
    expect(rows[1]).toMatchObject({
      inferenceId: request.inferenceId,
      userId: request.userId,
      configuredModel: "model-openai",
      servedModel: "served-openai",
      inputTokens: 10,
      outputTokens: 5,
      usageSource: "provider_reported",
    });
  });

  it("records a failed primary and the successful fallback as distinct provider attempts", async () => {
    const config = testConfig({ PROVIDER_MAX_RETRIES: "0" });
    const openai = new SequenceAdapter("openai", ["rate_limited"]);
    const anthropic = new SequenceAdapter("anthropic", ["success"]);
    const providers = new ProviderRegistry({ openai, anthropic });
    const router = new IntelligenceRouter(config.routerPolicy, () => providers.configured());
    const ledger = new InMemoryAttemptLedger();

    const result = await generateText(
      { providers, router, config, log, attemptLedger: ledger },
      { ...request, inferenceId: "inference-fallback-test" },
    );

    expect(result.provider).toBe("anthropic");
    expect(ledger.list().map((r) => [r.provider, r.fallbackIndex, r.attemptIndex, r.status])).toEqual([
      ["openai", 0, 0, "failure"],
      ["anthropic", 1, 0, "success"],
    ]);
  });
});
