import { describe, expect, it } from "vitest";
import { AnthropicAdapter } from "../src/providers/anthropic.js";
import { OpenAIAdapter } from "../src/providers/openai.js";
import type { ProviderAdapter, ProviderChunk } from "../src/providers/types.js";
import { scriptedProvider } from "./providerServer.js";

interface Captured {
  url: string;
  body: Record<string, unknown>;
  headers: Headers;
}

/** A fetch replacement that returns a recorded response and captures the outgoing request. */
function fakeFetch(respond: () => Response, captured: Captured[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    captured.push({
      url,
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      headers: new Headers(init?.headers),
    });
    return respond();
  }) as typeof fetch;
}

const sseResponse = (events: [string, unknown][]) =>
  new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

const jsonError = (status: number) =>
  new Response(JSON.stringify({ error: { type: "error", message: "provider says no: sk-secret-value" } }), {
    status,
    headers: { "content-type": "application/json" },
  });

async function run(adapter: ProviderAdapter, signal = new AbortController().signal) {
  const chunks: ProviderChunk[] = [];
  for await (const c of adapter.stream({
    system: "system prompt",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "plan please" },
    ],
    maxOutputTokens: 256,
    signal,
  })) {
    chunks.push(c);
  }
  return chunks;
}

describe("OpenAI adapter (official SDK, Responses API)", () => {
  const openaiStream = () =>
    sseResponse([
      ["response.created", { type: "response.created", sequence_number: 0, response: { id: "resp_1", status: "in_progress" } }],
      ["response.output_text.delta", { type: "response.output_text.delta", delta: "Hello", item_id: "i", output_index: 0, content_index: 0, sequence_number: 1, logprobs: [] }],
      ["response.output_text.delta", { type: "response.output_text.delta", delta: " world", item_id: "i", output_index: 0, content_index: 0, sequence_number: 2, logprobs: [] }],
      ["response.completed", { type: "response.completed", sequence_number: 3, response: { id: "resp_1", status: "completed", model: "served-model-x", usage: { input_tokens: 21, output_tokens: 2, total_tokens: 23 } } }],
    ]);

  it("streams text, reports usage and sends a privacy-preserving request", async () => {
    const captured: Captured[] = [];
    const adapter = new OpenAIAdapter("sk-test-not-a-real-key", "configured-model", {
      fetch: fakeFetch(openaiStream, captured),
      maxRetries: 0,
    });
    const chunks = await run(adapter);
    expect(chunks).toEqual([
      { type: "text", text: "Hello" },
      { type: "text", text: " world" },
      { type: "finish", finishReason: "stop", usage: { inputTokens: 21, outputTokens: 2 }, servedModel: "served-model-x" },
    ]);
    expect(captured[0]?.url).toMatch(/\/responses$/);
    expect(captured[0]?.body).toMatchObject({
      model: "configured-model",
      instructions: "system prompt",
      max_output_tokens: 256,
      stream: true,
      store: false,
    });
    expect((captured[0]?.body.input as unknown[]).length).toBe(3);
  });

  it("maps incomplete responses to a length finish", async () => {
    const adapter = new OpenAIAdapter("sk-test-not-a-real-key", "m", {
      maxRetries: 0,
      fetch: fakeFetch(
        () =>
          sseResponse([
            ["response.output_text.delta", { type: "response.output_text.delta", delta: "Part", item_id: "i", output_index: 0, content_index: 0, sequence_number: 1, logprobs: [] }],
            ["response.incomplete", { type: "response.incomplete", sequence_number: 2, response: { id: "r", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 5, output_tokens: 256, total_tokens: 261 } } }],
          ]),
        [],
      ),
    });
    expect((await run(adapter)).at(-1)).toEqual({
      type: "finish",
      finishReason: "length",
      usage: { inputTokens: 5, outputTokens: 256 },
      servedModel: null,
    });
  });

  it("maps HTTP errors without leaking provider text", async () => {
    for (const [status, code, retryable] of [
      [401, "provider_error", false],
      [429, "rate_limited", true],
      [500, "provider_error", true],
    ] as const) {
      const adapter = new OpenAIAdapter("sk-test-not-a-real-key", "m", {
        maxRetries: 0,
        fetch: fakeFetch(() => jsonError(status), []),
      });
      const error = await run(adapter).then(
        () => null,
        (e: unknown) => e as { code: string; retryable: boolean; message: string },
      );
      expect(error).toMatchObject({ code, retryable });
      expect(error?.message).not.toContain("sk-secret-value");
    }
  });

  it("never presents a stream that ended without a terminal event as complete", async () => {
    const adapter = new OpenAIAdapter("sk-test-not-a-real-key", "m", {
      maxRetries: 0,
      fetch: fakeFetch(
        () => sseResponse([["response.output_text.delta", { type: "response.output_text.delta", delta: "Cut o", item_id: "i", output_index: 0, content_index: 0, sequence_number: 1, logprobs: [] }]]),
        [],
      ),
    });
    await expect(run(adapter)).rejects.toMatchObject({ code: "provider_error", retryable: true });
  });

  it("maps in-stream failures by code without copying provider text", async () => {
    const failed = (code: string) =>
      new OpenAIAdapter("sk-test-not-a-real-key", "m", {
        maxRetries: 0,
        fetch: fakeFetch(
          () => sseResponse([["response.failed", { type: "response.failed", sequence_number: 1, response: { id: "r", status: "failed", error: { code, message: "leaky detail sk-secret-value" } } }]]),
          [],
        ),
      });
    for (const [code, expected] of [
      ["rate_limit_exceeded", { code: "rate_limited", retryable: true }],
      ["insufficient_quota", { code: "provider_error", retryable: false }],
      ["context_length_exceeded", { code: "provider_error", retryable: false }],
      ["server_error", { code: "provider_error", retryable: true }],
    ] as const) {
      const error = await run(failed(code)).then(() => null, (e: unknown) => e as { message: string });
      expect(error, code).toMatchObject(expected);
      expect(error?.message).not.toContain("sk-secret-value");
    }
    const streamError = new OpenAIAdapter("sk-test-not-a-real-key", "m", {
      maxRetries: 0,
      fetch: fakeFetch(() => sseResponse([["error", { type: "error", code: "rate_limit_exceeded", message: "x", param: null, sequence_number: 1 }]]), []),
    });
    await expect(run(streamError)).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("reports cancellation when the signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort("cancelled");
    const adapter = new OpenAIAdapter("sk-test-not-a-real-key", "m", {
      maxRetries: 0,
      fetch: fakeFetch(openaiStream, []),
    });
    await expect(run(adapter, controller.signal)).rejects.toMatchObject({ code: "cancelled" });
  });
});

describe("Anthropic adapter (official SDK, Messages API)", () => {
  const anthropicStream = (stopReason = "end_turn") =>
    sseResponse([
      ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 30, output_tokens: 1 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["ping", { type: "ping" }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Bonjour" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " !" } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 4 } }],
      ["message_stop", { type: "message_stop" }],
    ]);

  it("streams text and usage and sends the system prompt separately", async () => {
    const captured: Captured[] = [];
    const adapter = new AnthropicAdapter("sk-ant-test-not-real", "configured-claude", {
      fetch: fakeFetch(() => anthropicStream(), captured),
      maxRetries: 0,
    });
    expect(await run(adapter)).toEqual([
      { type: "text", text: "Bonjour" },
      { type: "text", text: " !" },
      { type: "finish", finishReason: "stop", usage: { inputTokens: 30, outputTokens: 4 }, servedModel: "m" },
    ]);
    expect(captured[0]?.url).toMatch(/\/v1\/messages$/);
    expect(captured[0]?.body).toMatchObject({
      model: "configured-claude",
      max_tokens: 256,
      system: "system prompt",
      stream: true,
    });
    expect(captured[0]?.headers.get("x-api-key")).toBe("sk-ant-test-not-real");
  });

  it("never presents a stream that ended without message_stop as complete", async () => {
    const adapter = new AnthropicAdapter("k", "m", {
      maxRetries: 0,
      fetch: fakeFetch(
        () =>
          sseResponse([
            ["message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
            ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
            ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Cut o" } }],
          ]),
        [],
      ),
    });
    await expect(run(adapter)).rejects.toMatchObject({ code: "provider_error", retryable: true });
  });

  it("treats an in-stream error event as a retryable provider error without leaking its text", async () => {
    const adapter = new AnthropicAdapter("k", "m", {
      maxRetries: 0,
      fetch: fakeFetch(
        () =>
          sseResponse([
            ["message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
            ["error", { type: "error", error: { type: "overloaded_error", message: "Overloaded sk-secret-value" } }],
          ]),
        [],
      ),
    });
    const error = await run(adapter).then(() => null, (e: unknown) => e as { code: string; retryable: boolean; message: string });
    expect(error).toMatchObject({ code: "provider_error", retryable: true });
    expect(error?.message).not.toContain("sk-secret-value");
  });

  it("takes cumulative input tokens from message_delta when the API sends them", async () => {
    const adapter = new AnthropicAdapter("k", "m", {
      maxRetries: 0,
      fetch: fakeFetch(
        () =>
          sseResponse([
            ["message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } }],
            ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { input_tokens: 77, output_tokens: 9 } }],
            ["message_stop", { type: "message_stop" }],
          ]),
        [],
      ),
    });
    expect((await run(adapter)).at(-1)).toMatchObject({ usage: { inputTokens: 77, outputTokens: 9 } });
  });

  it("surfaces refusals and max-token stops", async () => {
    const refusal = new AnthropicAdapter("k", "m", { maxRetries: 0, fetch: fakeFetch(() => anthropicStream("refusal"), []) });
    expect((await run(refusal)).at(-1)).toMatchObject({ finishReason: "refusal" });
    const length = new AnthropicAdapter("k", "m", { maxRetries: 0, fetch: fakeFetch(() => anthropicStream("max_tokens"), []) });
    expect((await run(length)).at(-1)).toMatchObject({ finishReason: "length" });
  });

  it("maps HTTP errors", async () => {
    const adapter = new AnthropicAdapter("k", "m", { maxRetries: 0, fetch: fakeFetch(() => jsonError(529), []) });
    await expect(run(adapter)).rejects.toMatchObject({ code: "provider_error", retryable: true });
    const auth = new AnthropicAdapter("k", "m", { maxRetries: 0, fetch: fakeFetch(() => jsonError(401), []) });
    await expect(run(auth)).rejects.toMatchObject({ code: "provider_error", retryable: false });
  });
});

describe("aborting a live stream mid-flight", () => {
  // Regression: SDKs end a stream silently when the request is aborted. That must surface as a
  // cancellation (stopped message), never as a completed answer or a provider failure.
  const longAnswer = () => ({ kind: "text" as const, text: "", chunks: Array.from({ length: 200 }, (_, i) => `${i}\n`) });

  for (const [kind, make] of [
    ["openai", (f: typeof fetch) => new OpenAIAdapter("sk-test-not-a-real-key", "m", { fetch: f, maxRetries: 0 })],
    ["anthropic", (f: typeof fetch) => new AnthropicAdapter("sk-ant-test-not-real", "m", { fetch: f, maxRetries: 0 })],
  ] as const) {
    it(`${kind}: user cancel after the first text is a clean cancellation`, async () => {
      const provider = scriptedProvider(kind, longAnswer, "m", { chunkDelayMs: 2 });
      const controller = new AbortController();
      const seen: string[] = [];
      const consume = (async () => {
        for await (const chunk of make(provider.fetch).stream({ system: "s", messages: [{ role: "user", content: "x" }], maxOutputTokens: 64, signal: controller.signal })) {
          if (chunk.type === "text") {
            seen.push(chunk.text);
            if (seen.length === 1) controller.abort("cancelled");
          }
        }
      })();
      await expect(consume).rejects.toMatchObject({ code: "cancelled", retryable: false });
      expect(seen.length).toBeLessThan(200);
    });

    it(`${kind}: an abort with the timeout reason is reported as a timeout`, async () => {
      const provider = scriptedProvider(kind, longAnswer, "m", { chunkDelayMs: 2 });
      const controller = new AbortController();
      const consume = (async () => {
        for await (const chunk of make(provider.fetch).stream({ system: "s", messages: [{ role: "user", content: "x" }], maxOutputTokens: 64, signal: controller.signal })) {
          if (chunk.type === "text") controller.abort("timeout");
        }
      })();
      await expect(consume).rejects.toMatchObject({ code: "provider_timeout", retryable: true });
    });
  }
});
