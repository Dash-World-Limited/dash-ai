import { describe, expect, it } from "vitest";
import { BedrockAdapter, toBedrockMessages, toBedrockTools } from "../src/providers/bedrock.js";
import { ProviderError, type ProviderChunk, type ProviderRequest } from "../src/providers/types.js";

const KEY = "ABSKTESTONLY0000000000000000000000000000";
const MODELS = {
  micro: "eu.amazon.nova-micro-v1:0",
  lite: "eu.amazon.nova-lite-v1:0",
  nova2Lite: "eu.amazon.nova-2-lite-v1:0",
};

const baseRequest = (overrides: Partial<ProviderRequest> = {}): ProviderRequest => ({
  system: "You are DASH AI.",
  messages: [{ role: "user", content: "Hello" }],
  maxOutputTokens: 16_000,
  signal: new AbortController().signal,
  ...overrides,
});

async function collect(source: AsyncIterable<ProviderChunk>): Promise<ProviderChunk[]> {
  const chunks: ProviderChunk[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return chunks;
}

function successfulFetch(seen: { url?: string; body?: Record<string, unknown>; authorization?: string }) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    seen.url = String(input);
    seen.authorization = new Headers(init?.headers).get("authorization") ?? undefined;
    seen.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        output: { message: { role: "assistant", content: [{ text: "Bedrock answer" }] } },
        stopReason: "end_turn",
        usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

describe("Amazon Bedrock adapter", () => {
  it("uses Nova Lite for an ordinary balanced chat and normalizes text + usage", async () => {
    const seen: { url?: string; body?: Record<string, unknown>; authorization?: string } = {};
    const adapter = new BedrockAdapter(KEY, "eu-west-1", MODELS, { fetch: successfulFetch(seen) });
    const chunks = await collect(
      adapter.stream(
        baseRequest({ routing: { task: "chat", mode: "general", preference: "balanced", estimatedInputTokens: 500 } }),
      ),
    );

    expect(seen.url).toContain(encodeURIComponent(MODELS.lite));
    expect(seen.authorization).toBe(`Bearer ${KEY}`);
    expect(chunks).toEqual([
      { type: "text", text: "Bedrock answer" },
      { type: "finish", finishReason: "stop", usage: { inputTokens: 12, outputTokens: 4 }, servedModel: MODELS.lite },
    ]);
  });

  it("escalates to Nova 2 Lite for quality, documents, long input or tool work", async () => {
    for (const routing of [
      { task: "chat", preference: "quality" as const, estimatedInputTokens: 500 },
      { task: "documents", preference: "balanced" as const, estimatedInputTokens: 20_000 },
      { task: "chat", preference: "balanced" as const, estimatedInputTokens: 150_000 },
    ]) {
      const seen: { url?: string; body?: Record<string, unknown> } = {};
      const adapter = new BedrockAdapter(KEY, "eu-west-1", MODELS, { fetch: successfulFetch(seen) });
      await collect(adapter.stream(baseRequest({ routing })));
      expect(seen.url).toContain(encodeURIComponent(MODELS.nova2Lite));
    }

    const seen: { url?: string; body?: Record<string, unknown> } = {};
    const adapter = new BedrockAdapter(KEY, "eu-west-1", MODELS, { fetch: successfulFetch(seen) });
    await collect(
      adapter.stream(
        baseRequest({
          routing: { task: "chat", preference: "balanced", estimatedInputTokens: 500 },
          tools: [{ name: "clock__now", description: "Read time", inputSchema: { type: "object", properties: {} } }],
        }),
      ),
    );
    expect(seen.url).toContain(encodeURIComponent(MODELS.nova2Lite));
  });

  it("uses Nova Micro for economy and background automation when available", async () => {
    for (const routing of [
      { task: "chat", preference: "economy" as const, estimatedInputTokens: 500 },
      { task: "automation", preference: "balanced" as const, estimatedInputTokens: 500 },
    ]) {
      const seen: { url?: string; body?: Record<string, unknown> } = {};
      const adapter = new BedrockAdapter(KEY, "eu-west-1", MODELS, { fetch: successfulFetch(seen) });
      await collect(adapter.stream(baseRequest({ routing })));
      expect(seen.url).toContain(encodeURIComponent(MODELS.micro));
    }
  });

  it("normalizes tool definitions, calls and results without trusting provider payloads", async () => {
    expect(
      toBedrockTools([
        {
          name: "weather__lookup",
          description: "Look up weather",
          inputSchema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
            additionalProperties: false,
          },
        },
      ]),
    ).toEqual([
      {
        toolSpec: {
          name: "weather__lookup",
          description: "Look up weather",
          inputSchema: { json: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
        },
      },
    ]);

    const messages = toBedrockMessages([
      { role: "assistant", content: "Checking.", toolCalls: [{ id: "call-1", name: "weather__lookup", argumentsJson: '{"city":"Asaba"}' }] },
      { role: "tool", results: [{ callId: "call-1", name: "weather__lookup", content: "31 C", isError: false }] },
    ]);
    expect(messages[0]).toMatchObject({ role: "assistant" });
    expect(messages[1]).toEqual({
      role: "user",
      content: [{ toolResult: { toolUseId: "call-1", content: [{ text: "31 C" }], status: "success" } }],
    });
  });

  it("maps throttling and credential failures to DASH provider errors", async () => {
    const failing = (status: number) =>
      (async () => new Response("{}", { status })) as typeof fetch;

    for (const [status, code, retryable] of [
      [429, "rate_limited", true],
      [403, "provider_error", false],
      [503, "provider_error", true],
    ] as const) {
      const adapter = new BedrockAdapter(KEY, "eu-west-1", MODELS, { fetch: failing(status) });
      try {
        await collect(adapter.stream(baseRequest()));
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderError);
        expect((error as ProviderError).code).toBe(code);
        expect((error as ProviderError).retryable).toBe(retryable);
        expect((error as ProviderError).httpStatus).toBe(status);
      }
    }
  });
});
