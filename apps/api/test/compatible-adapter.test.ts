import { describe, expect, it } from "vitest";
import { CompatibleProviderConfig, OpenAICompatibleAdapter, toChatMessages } from "../src/providers/compatible.js";
import { failoverAllowed, ProviderError, type ProviderChunk, type ProviderRequest } from "../src/providers/types.js";

// The generic OpenAI-compatible adapter (Chat Completions, streaming) against an in-process fetch:
// the real OpenAI SDK builds the request and parses the stream, nothing leaves the process.

const KEY = "test-compatible-key-not-real";
const CONFIG = CompatibleProviderConfig.parse({
  id: "example-free",
  displayName: "Example inference",
  baseUrl: "https://inference.example.test/v1",
  apiKeyEnv: "EXAMPLE_FREE_API_KEY",
  model: "example-model",
  contextTokens: 32_000,
  maxOutputTokens: 4_000,
  pricing: "free",
  privacy: "non_sensitive_only",
});

interface Seen {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

const sseBody = (events: unknown[]) =>
  events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";

const chunk = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) => ({
  id: "chatcmpl-1",
  object: "chat.completion.chunk",
  created: 1,
  model: "example-model-2026-01",
  choices: [{ index: 0, delta, finish_reason: finish }],
  ...extra,
});
const usageChunk = (usage: Record<string, unknown>) => ({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "example-model-2026-01", choices: [], usage });

/** A fetch that answers in process and, like the real one, rejects (headers) or errors (body) on abort. */
function fakeFetch(reply: (seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const s: Seen = { url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> };
    seen.push(s);
    const signal = init?.signal;
    const aborted = () => Object.assign(new Error("aborted"), { name: "AbortError" });
    if (signal?.aborted) throw aborted();
    return await new Promise<Response>((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(aborted()), { once: true });
      Promise.resolve(reply(s)).then(resolve, reject);
    });
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

/** A streaming body that never sends anything and errors when the request is aborted. */
const hangingStream = (signal?: AbortSignal | null) =>
  new ReadableStream({
    start(controller) {
      signal?.addEventListener("abort", () => controller.error(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    },
  });

const stream = (events: unknown[]) => () => new Response(sseBody(events), { status: 200, headers: { "content-type": "text/event-stream" } });

const request = (over: Partial<ProviderRequest> = {}): ProviderRequest => ({
  system: "You are DASH AI.",
  messages: [{ role: "user", content: "Hello" }],
  maxOutputTokens: 16_000,
  signal: new AbortController().signal,
  ...over,
});

async function collect(source: AsyncIterable<ProviderChunk>) {
  const out: ProviderChunk[] = [];
  for await (const c of source) out.push(c);
  return out;
}

async function failure(source: AsyncIterable<ProviderChunk>): Promise<ProviderError> {
  try {
    for await (const _ of source) void _;
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderError);
    return err as ProviderError;
  }
  throw new Error("expected a failure");
}

describe("OpenAI-compatible adapter", () => {
  it("streams text, reports provider usage (cached tokens and the provider's own cost) and the served model", async () => {
    const f = fakeFetch(
      stream([
        chunk({ role: "assistant", content: "" }),
        chunk({ content: "Hello " }),
        chunk({ content: "there." }),
        chunk({}, "stop"),
        usageChunk({ prompt_tokens: 120, completion_tokens: 8, total_tokens: 128, prompt_tokens_details: { cached_tokens: 100 }, cost: 0.000042 }),
      ]),
    );
    const adapter = new OpenAICompatibleAdapter(CONFIG, KEY, { fetch: f.fetch });
    expect(await collect(adapter.stream(request()))).toEqual([
      { type: "text", text: "Hello " },
      { type: "text", text: "there." },
      {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 120, outputTokens: 8 },
        servedModel: "example-model-2026-01",
        cachedInputTokens: 100,
        providerCostUsd: 0.000042,
      },
    ]);
    const sent = f.seen[0]!;
    expect(sent.url).toBe("https://inference.example.test/v1/chat/completions");
    expect(sent.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(sent.body).toEqual({
      model: "example-model",
      messages: [
        { role: "system", content: "You are DASH AI." },
        { role: "user", content: "Hello" },
      ],
      stream: true,
      // The provider's own output ceiling wins over the server-wide one.
      max_tokens: 4_000,
      stream_options: { include_usage: true },
    });
  });

  it("reports unknown usage as null when the API sends none, and can omit stream_options", async () => {
    const f = fakeFetch(stream([chunk({ content: "Hi" }, "stop")]));
    const adapter = new OpenAICompatibleAdapter({ ...CONFIG, streamUsage: false }, KEY, { fetch: f.fetch });
    const chunks = await collect(adapter.stream(request()));
    expect(chunks.at(-1)).toMatchObject({ type: "finish", usage: { inputTokens: null, outputTokens: null }, providerCostUsd: null });
    expect(f.seen[0]!.body).not.toHaveProperty("stream_options");
  });

  it("assembles streamed tool calls, keeps the tool list when tool use is off, and replays tool turns", async () => {
    const f = fakeFetch(
      stream([
        chunk({ tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "dash-demo__text_stats", arguments: "" } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"text":' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '"a b c"}' } }] }),
        chunk({}, "tool_calls"),
      ]),
    );
    const adapter = new OpenAICompatibleAdapter(CONFIG, KEY, { fetch: f.fetch });
    const tools = [{ name: "dash-demo__text_stats", description: "Count words", inputSchema: { type: "object", properties: { text: { type: "string" } } } }];
    const chunks = await collect(adapter.stream(request({ tools, toolChoice: "auto" })));
    expect(chunks[0]).toEqual({ type: "tool_calls", calls: [{ id: "call-1", name: "dash-demo__text_stats", argumentsJson: '{"text":"a b c"}' }] });
    expect(f.seen[0]!.body).toMatchObject({ tool_choice: "auto", tools: [{ type: "function", function: { name: "dash-demo__text_stats", description: "Count words" } }] });

    await collect(adapter.stream(request({ tools, toolChoice: "none" })));
    expect(f.seen[1]!.body).toMatchObject({ tool_choice: "none", tools: [{ type: "function" }] });

    expect(
      toChatMessages("sys", [
        { role: "user", content: "Count" },
        { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "dash-demo__text_stats", argumentsJson: '{"text":"a b c"}' }] },
        { role: "tool", results: [{ callId: "call-1", name: "dash-demo__text_stats", content: "", isError: false }] },
      ]),
    ).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "Count" },
      { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "dash-demo__text_stats", arguments: '{"text":"a b c"}' } }] },
      { role: "tool", tool_call_id: "call-1", content: "(no output)" },
    ]);
  });

  it("maps finish reasons", async () => {
    for (const [reason, finish] of [
      ["length", "length"],
      ["content_filter", "refusal"],
      ["stop", "stop"],
    ] as const) {
      const adapter = new OpenAICompatibleAdapter(CONFIG, KEY, { fetch: fakeFetch(stream([chunk({ content: "x" }, reason)])).fetch });
      expect((await collect(adapter.stream(request()))).at(-1), reason).toMatchObject({ finishReason: finish });
    }
  });

  it("normalizes errors for the router: 429 with Retry-After, exhausted quota, 5xx, credentials, never the provider's text", async () => {
    const fail = (status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
      new OpenAICompatibleAdapter(CONFIG, KEY, {
        fetch: fakeFetch(() => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })).fetch,
      });
    const limited = await failure(fail(429, { error: { message: "SECRET-PROVIDER-TEXT", type: "rate_limit" } }, { "retry-after": "45" }).stream(request()));
    expect(limited).toMatchObject({ code: "rate_limited", retryable: true, httpStatus: 429, retryAfterMs: 45_000, quotaExhausted: false });
    const quota = await failure(fail(429, { error: { message: "SECRET-PROVIDER-TEXT", code: "insufficient_quota" } }).stream(request()));
    expect(quota).toMatchObject({ code: "rate_limited", retryable: false, quotaExhausted: true });
    expect(failoverAllowed(quota)).toBe(true);
    expect(await failure(fail(503, { error: { message: "SECRET-PROVIDER-TEXT" } }).stream(request()))).toMatchObject({ code: "provider_error", retryable: true, httpStatus: 503 });
    const denied = await failure(fail(401, { error: { message: "SECRET-PROVIDER-TEXT" } }).stream(request()));
    expect(denied).toMatchObject({ code: "provider_error", retryable: false, httpStatus: 401 });
    expect(failoverAllowed(denied)).toBe(true);
    for (const e of [limited, quota, denied]) expect(e.message).not.toContain("SECRET-PROVIDER-TEXT");
  });

  it("a cancel is a cancellation and an aborted request after a timeout is a timeout", async () => {
    const hang = () => fakeFetch(() => new Response(hangingStream(), { status: 200, headers: { "content-type": "text/event-stream" } }));
    const cancelled = new AbortController();
    const pending = failure(new OpenAICompatibleAdapter(CONFIG, KEY, { fetch: hang().fetch }).stream(request({ signal: cancelled.signal })));
    setTimeout(() => cancelled.abort("cancelled"), 20);
    expect((await pending).code).toBe("cancelled");
    const timedOut = new AbortController();
    const slow = failure(new OpenAICompatibleAdapter(CONFIG, KEY, { fetch: hang().fetch }).stream(request({ signal: timedOut.signal })));
    setTimeout(() => timedOut.abort("timeout"), 20);
    expect(await slow).toMatchObject({ code: "provider_timeout", retryable: true });
  });

  it("the provider's own time limit applies until the response starts", async () => {
    const started = Date.now();
    const slowHeaders = fakeFetch(
      () => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response(sseBody([chunk({ content: "late" }, "stop")]), { status: 200 })), 3_000)),
    );
    const timed = new OpenAICompatibleAdapter({ ...CONFIG, timeoutMs: 1_000 }, KEY, { fetch: slowHeaders.fetch });
    expect(await failure(timed.stream(request()))).toMatchObject({ code: "provider_timeout", retryable: true });
    expect(Date.now() - started).toBeLessThan(2_500);
  });
});
