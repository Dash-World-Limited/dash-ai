import type { ConverseStreamCommand, ConverseStreamCommandOutput, ConverseStreamOutput } from "@aws-sdk/client-bedrock-runtime";
import { describe, expect, it } from "vitest";
import { BedrockAdapter, ToolNames, toBedrockError, toBedrockMessages, toBedrockTools, type BedrockModels } from "../src/providers/bedrock.js";
import { ProviderError, type ProviderChunk, type ProviderRequest } from "../src/providers/types.js";
import { event, exception, textAnswer, wireHandler, type WireReply } from "./bedrockWire.js";

// Amazon Bedrock is exercised two ways, neither of which reaches AWS: a stand-in for the SDK client
// (exact control over stream events), and the REAL Bedrock Runtime SDK talking to an in-process
// request handler that speaks AWS event-stream framing (auth, endpoint, wire format, HTTP errors).

const KEY = "ABSKTESTONLY0000000000000000000000000000";
const MODELS = {
  micro: "eu.amazon.nova-micro-v1:0",
  lite: "eu.amazon.nova-lite-v1:0",
  nova2Lite: "eu.amazon.nova-2-lite-v1:0",
};

const request = (overrides: Partial<ProviderRequest> = {}): ProviderRequest => ({
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

async function failure(source: AsyncIterable<ProviderChunk>): Promise<{ error: ProviderError; chunks: ProviderChunk[] }> {
  const chunks: ProviderChunk[] = [];
  try {
    for await (const chunk of source) chunks.push(chunk);
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderError);
    return { error: error as ProviderError, chunks };
  }
  throw new Error("expected the stream to fail");
}

/** A stand-in SDK client: records each command and replies with the given stream events or error. */
function stubClient(reply: (input: ConverseStreamCommand["input"]) => ConverseStreamOutput[] | Error) {
  const inputs: Array<ConverseStreamCommand["input"]> = [];
  return {
    inputs,
    client: {
      async send(command: ConverseStreamCommand): Promise<ConverseStreamCommandOutput> {
        inputs.push(command.input);
        const r = reply(command.input);
        if (r instanceof Error) throw r;
        return {
          $metadata: {},
          stream: (async function* () {
            for (const e of r) yield e;
          })(),
        };
      },
    },
  };
}

const text = (t: string, i = 0): ConverseStreamOutput => ({ contentBlockDelta: { contentBlockIndex: i, delta: { text: t } } });
const stop = (reason: string): ConverseStreamOutput => ({ messageStop: { stopReason: reason as never } });
const usage = (input: number, output: number): ConverseStreamOutput => ({ metadata: { usage: { inputTokens: input, outputTokens: output, totalTokens: input + output }, metrics: { latencyMs: 1 } } });
const awsError = (name: string, status?: number, message = "detail from AWS: SECRET-PROVIDER-TEXT") =>
  Object.assign(new Error(message), { name, ...(status === undefined ? {} : { $metadata: { httpStatusCode: status } }) });

function adapter(models: BedrockModels = MODELS, reply: Parameters<typeof stubClient>[0] = () => [text("ok"), stop("end_turn"), usage(1, 1)]) {
  const stub = stubClient(reply);
  return { adapter: new BedrockAdapter({ kind: "api_key", apiKey: KEY }, "eu-west-1", models, { client: stub.client }), inputs: stub.inputs };
}

describe("Amazon Bedrock adapter: request and response normalization", () => {
  it("streams text as it arrives and maps token usage and the served Nova tier", async () => {
    const { adapter: a, inputs } = adapter(MODELS, () => [
      { messageStart: { role: "assistant" } },
      text("Hello "),
      text("from DASH."),
      { contentBlockStop: { contentBlockIndex: 0 } },
      stop("end_turn"),
      usage(12, 4),
    ]);
    const chunks = await collect(a.stream(request({ routing: { task: "chat", mode: "general", estimatedInputTokens: 500 } })));
    expect(chunks).toEqual([
      { type: "text", text: "Hello " },
      { type: "text", text: "from DASH." },
      { type: "finish", finishReason: "stop", usage: { inputTokens: 12, outputTokens: 4 }, servedModel: MODELS.lite },
    ]);
    expect(inputs[0]).toEqual({
      modelId: MODELS.lite,
      system: [{ text: "You are DASH AI." }],
      messages: [{ role: "user", content: [{ text: "Hello" }] }],
      // Nova Lite's conservative output ceiling, below the server's MAX_OUTPUT_TOKENS.
      inferenceConfig: { maxTokens: 5_000 },
    });
  });

  it("maps stop reasons, and reports unknown usage as null rather than zero", async () => {
    for (const [reason, finish] of [
      ["end_turn", "stop"],
      ["tool_use", "stop"],
      ["max_tokens", "length"],
      ["model_context_window_exceeded", "length"],
      ["guardrail_intervened", "refusal"],
      ["content_filtered", "refusal"],
    ] as const) {
      const { adapter: a } = adapter(MODELS, () => [text("x"), stop(reason)]);
      const last = (await collect(a.stream(request()))).at(-1);
      expect(last, reason).toEqual({ type: "finish", finishReason: finish, usage: { inputTokens: null, outputTokens: null }, servedModel: MODELS.lite });
    }
  });

  it("never forwards Nova reasoning content", async () => {
    const { adapter: a } = adapter(MODELS, () => [
      { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: "internal thinking" } } } },
      text("Answer.", 1),
      stop("end_turn"),
    ]);
    const chunks = await collect(a.stream(request()));
    expect(chunks.filter((c) => c.type === "text")).toEqual([{ type: "text", text: "Answer." }]);
  });

  it("drops blank text, starts with the person and merges neighbours so Converse accepts the history", () => {
    expect(
      toBedrockMessages([
        { role: "assistant", content: "A greeting before the person spoke." },
        { role: "user", content: "First question" },
        { role: "assistant", content: "   " },
        { role: "user", content: "Second question" },
        { role: "assistant", content: "Answer" },
        { role: "user", content: "" },
      ]),
    ).toEqual([
      { role: "user", content: [{ text: "First question" }, { text: "Second question" }] },
      { role: "assistant", content: [{ text: "Answer" }] },
    ]);
  });

  it("keeps the max output within each Nova tier's conservative ceiling and the server limit", async () => {
    for (const [routing, model, max] of [
      [{ task: "chat", preference: "economy" as const }, MODELS.micro, 5_000],
      [{ task: "chat", preference: "balanced" as const }, MODELS.lite, 5_000],
      [{ task: "chat", preference: "quality" as const }, MODELS.nova2Lite, 16_000],
    ] as const) {
      const { adapter: a, inputs } = adapter();
      await collect(a.stream(request({ routing })));
      expect(inputs[0]).toMatchObject({ modelId: model, inferenceConfig: { maxTokens: max } });
    }
  });
});

describe("Amazon Bedrock adapter: Nova tier selection inside the adapter", () => {
  const served = async (models: BedrockModels, overrides: Partial<ProviderRequest>) => {
    const { adapter: a, inputs } = adapter(models);
    await collect(a.stream(request(overrides)));
    return inputs[0]!.modelId;
  };

  it("Lite by default; Nova 2 Lite for quality, documents, research, reports, long input or tools", async () => {
    expect(await served(MODELS, { routing: { task: "chat", mode: "general", preference: "balanced", estimatedInputTokens: 500 } })).toBe(MODELS.lite);
    expect(await served(MODELS, {})).toBe(MODELS.lite);
    for (const routing of [
      { task: "chat", preference: "quality" as const },
      { task: "documents" },
      { task: "research" },
      { task: "reports" },
      { task: "chat", mode: "documents" as const },
      { task: "chat", mode: "research" as const },
      { task: "chat", estimatedInputTokens: 120_000 },
    ]) {
      expect(await served(MODELS, { routing }), JSON.stringify(routing)).toBe(MODELS.nova2Lite);
    }
    expect(await served(MODELS, { tools: [{ name: "dash-demo__current_time", description: "Time", inputSchema: { type: "object", properties: {} } }] })).toBe(MODELS.nova2Lite);
  });

  it("Micro for economy and background automation, unless the work is heavy", async () => {
    expect(await served(MODELS, { routing: { task: "chat", preference: "economy" } })).toBe(MODELS.micro);
    expect(await served(MODELS, { routing: { task: "automation", preference: "balanced" } })).toBe(MODELS.micro);
    expect(await served(MODELS, { routing: { task: "automation", preference: "quality" } })).toBe(MODELS.nova2Lite);
    expect(await served(MODELS, { routing: { task: "automation", estimatedInputTokens: 150_000 } })).toBe(MODELS.nova2Lite);
  });

  it("falls through to configured tiers and never picks a tier too small for the input", async () => {
    expect(await served({ micro: MODELS.micro }, { routing: { task: "chat", preference: "quality" } })).toBe(MODELS.micro);
    expect(await served({ lite: MODELS.lite }, { routing: { task: "chat", preference: "economy" } })).toBe(MODELS.lite);
    expect(await served({ micro: MODELS.micro, lite: MODELS.lite }, { routing: { task: "documents" } })).toBe(MODELS.lite);
    // 200k tokens do not fit Micro (128k): Lite (300k) takes it even for an economy request.
    expect(await served({ micro: MODELS.micro, lite: MODELS.lite }, { routing: { task: "chat", preference: "economy", estimatedInputTokens: 200_000 } })).toBe(MODELS.lite);
  });
});

describe("Amazon Bedrock adapter: tools", () => {
  const TOOLS = [
    {
      name: "dash-demo__text_stats",
      description: "Count words",
      inputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
    },
  ];

  it("gives tools Bedrock-safe names and maps the model's calls back to DASH's own names", async () => {
    const { adapter: a, inputs } = adapter(MODELS, () => [
      { contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: "tooluse-1", name: "dash_demo__text_stats" } } } },
      { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{"text":' } } } },
      { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '"alpha beta"}' } } } },
      { contentBlockStop: { contentBlockIndex: 1 } },
      stop("tool_use"),
      usage(30, 9),
    ]);
    const chunks = await collect(a.stream(request({ tools: TOOLS, toolChoice: "auto" })));
    expect(chunks).toEqual([
      { type: "tool_calls", calls: [{ id: "tooluse-1", name: "dash-demo__text_stats", argumentsJson: '{"text":"alpha beta"}' }] },
      { type: "finish", finishReason: "stop", usage: { inputTokens: 30, outputTokens: 9 }, servedModel: MODELS.nova2Lite },
    ]);
    expect(inputs[0]).toMatchObject({
      inferenceConfig: { temperature: 0 },
      toolConfig: {
        tools: [{ toolSpec: { name: "dash_demo__text_stats", description: "Count words", inputSchema: { json: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } } } }],
        toolChoice: { auto: {} },
      },
    });
  });

  it("replays tool calls and results to Bedrock, and keeps the tool list when tool use is switched off", async () => {
    const { adapter: a, inputs } = adapter();
    await collect(
      a.stream(
        request({
          tools: TOOLS,
          toolChoice: "none",
          messages: [
            { role: "user", content: "Count the words." },
            { role: "assistant", content: "", toolCalls: [{ id: "tooluse-1", name: "dash-demo__text_stats", argumentsJson: '{"text":"alpha beta"}' }] },
            { role: "tool", results: [{ callId: "tooluse-1", name: "dash-demo__text_stats", content: "", isError: false }] },
          ],
        }),
      ),
    );
    const sent = inputs[0]!;
    expect(sent.messages).toEqual([
      { role: "user", content: [{ text: "Count the words." }] },
      { role: "assistant", content: [{ toolUse: { toolUseId: "tooluse-1", name: "dash_demo__text_stats", input: { text: "alpha beta" } } }] },
      { role: "user", content: [{ toolResult: { toolUseId: "tooluse-1", content: [{ text: "(no output)" }], status: "success" } }] },
    ]);
    // Converse has no "none" choice and needs the tool list while tool blocks are in the history.
    expect(sent.toolConfig?.tools).toHaveLength(1);
    expect(sent.system![0]!.text).toMatch(/^You are DASH AI\.\n\nTool use is switched off for this reply/);
  });

  it("keeps aliases unique and within 64 characters", () => {
    const names = new ToolNames(["a-b__x", "a_b__x", `${"p".repeat(40)}__${"t".repeat(40)}`]);
    expect(names.alias("a-b__x")).toBe("a_b__x");
    expect(names.alias("a_b__x")).toBe("a_b__x_2");
    expect(names.original("a_b__x_2")).toBe("a_b__x");
    expect(names.alias(`${"p".repeat(40)}__${"t".repeat(40)}`)).toHaveLength(64);
    expect(toBedrockTools([{ name: "9-tool", description: "d", inputSchema: {} }])[0]!.toolSpec!.name).toBe("t_9_tool");
  });
});

describe("Amazon Bedrock adapter: errors, timeouts and rate limits", () => {
  it("maps Bedrock Runtime errors to DASH codes, retryability and status, without Bedrock's wording", () => {
    for (const [name, status, code, retryable, httpStatus] of [
      ["ThrottlingException", 429, "rate_limited", true, 429],
      ["ServiceQuotaExceededException", 400, "rate_limited", true, 400],
      ["ModelTimeoutException", 408, "provider_timeout", true, 408],
      ["ModelNotReadyException", 429, "provider_error", true, 429],
      ["InternalServerException", 500, "provider_error", true, 500],
      ["ServiceUnavailableException", 503, "provider_error", true, 503],
      ["ModelErrorException", 424, "provider_error", true, 424],
      ["ModelStreamErrorException", undefined, "provider_error", true, 503],
      ["AccessDeniedException", 403, "provider_error", false, 403],
      ["UnrecognizedClientException", 403, "provider_error", false, 401],
      ["ExpiredTokenException", 403, "provider_error", false, 401],
      ["CredentialsProviderError", undefined, "provider_error", false, 401],
      ["ResourceNotFoundException", 404, "provider_error", false, 404],
      ["ValidationException", 400, "provider_error", false, 400],
    ] as const) {
      const error = toBedrockError(awsError(name, status));
      expect([error.code, error.retryable, error.httpStatus], name).toEqual([code, retryable, httpStatus]);
      expect(error.message).not.toContain("SECRET-PROVIDER-TEXT");
    }
  });

  it("treats a model id this account or Region cannot use as configuration (another provider may take over)", () => {
    for (const message of [
      "Invocation of model ID amazon.nova-lite-v1:0 with on-demand throughput isn't supported. Retry your request with the ID or ARN of an inference profile.",
      "The provided model identifier is invalid.",
    ]) {
      const error = toBedrockError(awsError("ValidationException", 400, message));
      expect([error.code, error.retryable, error.httpStatus]).toEqual(["provider_error", false, 404]);
      expect(error.message).not.toContain("amazon.nova");
    }
  });

  it("a cancel is a cancellation and an idle or overall timeout is a timeout, whatever the SDK throws", () => {
    const cancelled = new AbortController();
    cancelled.abort("cancelled");
    expect(toBedrockError(awsError("AbortError"), cancelled.signal).code).toBe("cancelled");
    const timedOut = new AbortController();
    timedOut.abort("timeout");
    expect(toBedrockError(awsError("AbortError"), timedOut.signal)).toMatchObject({ code: "provider_timeout", retryable: true });
    expect(toBedrockError(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }))).toMatchObject({ code: "provider_error", retryable: true });
  });

  it("errors before the stream, inside the stream, and a missing stream all surface as ProviderError", async () => {
    const before = adapter(MODELS, () => awsError("ThrottlingException", 429));
    expect((await failure(before.adapter.stream(request()))).error).toMatchObject({ code: "rate_limited", retryable: true });

    const inside = adapter(MODELS, () => [text("Partial"), { throttlingException: { name: "ThrottlingException", message: "slow down" } as never }]);
    const mid = await failure(inside.adapter.stream(request()));
    expect(mid.chunks).toEqual([{ type: "text", text: "Partial" }]);
    expect(mid.error).toMatchObject({ code: "rate_limited", retryable: true });

    const empty = new BedrockAdapter({ kind: "api_key", apiKey: KEY }, "eu-west-1", MODELS, {
      client: { send: async () => ({ $metadata: {} }) as ConverseStreamCommandOutput },
    });
    expect((await failure(empty.stream(request()))).error).toMatchObject({ code: "provider_error", retryable: true });
  });
});

describe("Amazon Bedrock adapter through the real Bedrock Runtime SDK (in-process HTTP, no AWS)", () => {
  const sdkAdapter = (reply: (r: { path: string }) => WireReply, auth: "api_key" | "iam" = "api_key") => {
    const wire = wireHandler(reply);
    const a = new BedrockAdapter(auth === "api_key" ? { kind: "api_key", apiKey: KEY } : { kind: "iam" }, "eu-west-1", MODELS, {
      clientConfig: {
        requestHandler: wire.handler as never,
        ...(auth === "iam" ? { credentials: { accessKeyId: "TESTONLYACCESSKEYID", secretAccessKey: "test-only-secret" } } : {}),
      },
    });
    return { adapter: a, requests: wire.requests };
  };

  it("calls ConverseStream on the regional endpoint with the API key as a bearer token, once", async () => {
    const { adapter: a, requests } = sdkAdapter(() => ({ kind: "stream", frames: textAnswer(["Hello ", "there"]) }));
    const chunks = await collect(a.stream(request({ routing: { task: "chat" } })));
    expect(chunks).toEqual([
      { type: "text", text: "Hello " },
      { type: "text", text: "there" },
      { type: "finish", finishReason: "stop", usage: { inputTokens: 12, outputTokens: 4 }, servedModel: MODELS.lite },
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "POST",
      hostname: "bedrock-runtime.eu-west-1.amazonaws.com",
      path: `/model/${encodeURIComponent(MODELS.lite)}/converse-stream`,
      body: { messages: [{ role: "user", content: [{ text: "Hello" }] }], system: [{ text: "You are DASH AI." }], inferenceConfig: { maxTokens: 5_000 } },
    });
    expect(requests[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("signs with SigV4 for the configured Region when BEDROCK_AUTH=iam", async () => {
    const { adapter: a, requests } = sdkAdapter(() => ({ kind: "stream", frames: textAnswer(["ok"]) }), "iam");
    await collect(a.stream(request()));
    expect(requests[0]!.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=TESTONLYACCESSKEYID\/\d{8}\/eu-west-1\/bedrock\/aws4_request/);
  });

  it("streams tool calls through the SDK's event-stream decoding", async () => {
    const { adapter: a } = sdkAdapter(() => ({
      kind: "stream",
      frames: [
        event("messageStart", { role: "assistant" }),
        event("contentBlockStart", { contentBlockIndex: 0, start: { toolUse: { toolUseId: "tu-1", name: "dash_demo__text_stats" } } }),
        event("contentBlockDelta", { contentBlockIndex: 0, delta: { toolUse: { input: '{"text":"a b c"}' } } }),
        event("contentBlockStop", { contentBlockIndex: 0 }),
        event("messageStop", { stopReason: "tool_use" }),
        event("metadata", { usage: { inputTokens: 40, outputTokens: 12, totalTokens: 52 }, metrics: { latencyMs: 9 } }),
      ],
    }));
    const chunks = await collect(
      a.stream(request({ tools: [{ name: "dash-demo__text_stats", description: "Count words", inputSchema: { type: "object", properties: {} } }] })),
    );
    expect(chunks[0]).toEqual({ type: "tool_calls", calls: [{ id: "tu-1", name: "dash-demo__text_stats", argumentsJson: '{"text":"a b c"}' }] });
    expect(chunks.at(-1)).toMatchObject({ type: "finish", usage: { inputTokens: 40, outputTokens: 12 }, servedModel: MODELS.nova2Lite });
  });

  it("maps HTTP errors and in-stream exceptions from the wire, never copying Bedrock's message", async () => {
    for (const [status, type, code, retryable] of [
      [429, "ThrottlingException", "rate_limited", true],
      [403, "AccessDeniedException", "provider_error", false],
      [503, "ServiceUnavailableException", "provider_error", true],
      [400, "ValidationException", "provider_error", false],
    ] as const) {
      const { adapter: a } = sdkAdapter(() => ({ kind: "error", status, type, message: "SECRET-PROVIDER-TEXT" }));
      const { error } = await failure(a.stream(request()));
      expect([error.code, error.retryable, error.httpStatus], type).toEqual([code, retryable, status]);
      expect(error.message).not.toContain("SECRET-PROVIDER-TEXT");
    }
    const { adapter: a } = sdkAdapter(() => ({
      kind: "stream",
      frames: [event("messageStart", { role: "assistant" }), event("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "Par" } }), exception("throttlingException", "SECRET-PROVIDER-TEXT")],
    }));
    const mid = await failure(a.stream(request()));
    expect(mid.chunks).toEqual([{ type: "text", text: "Par" }]);
    expect(mid.error).toMatchObject({ code: "rate_limited", retryable: true });
  });
});
