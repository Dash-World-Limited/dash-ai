import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
  type BedrockRuntimeClientConfig,
  type ContentBlock,
  type ConverseStreamCommandInput,
  type ConverseStreamCommandOutput,
  type Message,
  type Tool,
  type ToolInputSchema,
} from "@aws-sdk/client-bedrock-runtime";
import type { Usage } from "@dash-ai/contracts";
import type { ModelToolCall, NormalizedTool } from "../tools/types.js";
import { NOVA_PROFILES, novaProfileFor, type NovaTier } from "./nova.js";
import {
  ProviderError,
  isToolCallTurn,
  isToolResultTurn,
  toProviderError,
  type ProviderAdapter,
  type ProviderChunk,
  type ProviderRequest,
  type ProviderRoutingContext,
  type ProviderTurn,
} from "./types.js";

export type BedrockModels = Partial<Record<NovaTier, string | undefined>>;

/**
 * How the server authenticates to Amazon Bedrock. `api_key`: a Bedrock API key sent as a bearer
 * token. `iam`: the AWS SDK's default credential chain (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY,
 * a shared profile, or a container or instance role), signed with SigV4.
 */
export type BedrockAuth = { kind: "api_key"; apiKey: string } | { kind: "iam" };

/** The one SDK call the adapter makes. Tests inject a stand-in; nothing here calls AWS in tests. */
export interface BedrockClientLike {
  send(command: ConverseStreamCommand, options?: { abortSignal?: AbortSignal }): Promise<ConverseStreamCommandOutput>;
}

export interface BedrockAdapterOptions {
  /** Injected client (tests). Production builds a BedrockRuntimeClient from the settings. */
  client?: BedrockClientLike;
  /** Extra SDK client settings (tests use a local request handler and endpoint). */
  clientConfig?: Partial<BedrockRuntimeClientConfig>;
}

const DISPLAY_NAME = "Amazon Bedrock";
const TOOLS_OFF =
  "Tool use is switched off for this reply. Answer the person directly with the information you already have, and do not request any tool.";

/**
 * Amazon Bedrock adapter (Converse streaming API through the official Bedrock Runtime SDK).
 *
 * It sits behind the same ProviderAdapter boundary as every other engine: the DASH Intelligence
 * Router decides whether Bedrock serves a request; this adapter then picks the Amazon Nova tier the
 * operator configured that fits the request. No Bedrock key, model id or provider wording reaches
 * consumers. Retries happen in the orchestrator, so the SDK makes exactly one attempt.
 */
export class BedrockAdapter implements ProviderAdapter {
  readonly id = "bedrock" as const;
  readonly displayName = DISPLAY_NAME;
  readonly demo = false;
  /** One stable value for status and logs. Each answer reports the tier it used as servedModel. */
  readonly model: string;

  private readonly client: BedrockClientLike;

  constructor(
    auth: BedrockAuth,
    region: string,
    /** The configured tier ids (internal; used by the live smoke run). */
    readonly models: BedrockModels,
    options: BedrockAdapterOptions = {},
  ) {
    const configured = (Object.keys(NOVA_PROFILES) as NovaTier[]).map((t) => models[t]).filter((m): m is string => Boolean(m));
    if (configured.length === 0) throw new Error("Bedrock needs at least one configured model.");
    this.model = models.lite ?? models.nova2Lite ?? models.micro!;
    this.client =
      options.client ??
      new BedrockRuntimeClient({
        region,
        maxAttempts: 1,
        ...(auth.kind === "api_key"
          ? { token: { token: auth.apiKey }, authSchemePreference: ["httpBearerAuth"] }
          : { authSchemePreference: ["sigv4"] }),
        ...options.clientConfig,
      });
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderChunk> {
    const toolsOffered = Boolean(request.tools && request.tools.length > 0);
    const model = this.pickModel(request.routing, toolsOffered);
    const names = new ToolNames([
      ...(request.tools ?? []).map((t) => t.name),
      ...request.messages.flatMap((m) => (isToolCallTurn(m) ? m.toolCalls.map((c) => c.name) : isToolResultTurn(m) ? m.results.map((r) => r.name) : [])),
    ]);
    const toolsOff = toolsOffered && request.toolChoice === "none";
    const input: ConverseStreamCommandInput = {
      modelId: model,
      system: [{ text: toolsOff ? `${request.system}\n\n${TOOLS_OFF}` : request.system }],
      messages: toBedrockMessages(request.messages, names),
      inferenceConfig: {
        maxTokens: Math.min(request.maxOutputTokens, this.outputTokenCap(model)),
        // Nova's guidance for tool use is greedy decoding.
        ...(toolsOffered ? { temperature: 0 } : {}),
      },
      // Converse has no "none" tool choice, and it requires the tool list whenever the conversation
      // holds tool calls or results. With tool use off the list stays and the instruction above
      // asks for a direct answer; the orchestrator never acts on tool calls from such a round.
      ...(toolsOffered ? { toolConfig: { tools: toBedrockTools(request.tools!, names), toolChoice: { auto: {} } } } : {}),
    };

    let response: ConverseStreamCommandOutput;
    try {
      response = await this.client.send(new ConverseStreamCommand(input), { abortSignal: request.signal });
    } catch (err) {
      throw toBedrockError(err, request.signal);
    }
    if (!response.stream) throw new ProviderError("provider_error", "Amazon Bedrock returned no response stream.", true);

    const calls = new Map<number, { id: string; name: string; input: string }>();
    let usage: Usage = { inputTokens: null, outputTokens: null };
    let stopReason: string | undefined;
    try {
      for await (const event of response.stream) {
        if (event.contentBlockStart?.start?.toolUse) {
          const start = event.contentBlockStart.start.toolUse;
          calls.set(event.contentBlockStart.contentBlockIndex ?? calls.size, {
            id: start.toolUseId ?? `bedrock-call-${calls.size + 1}`,
            name: names.original(start.name ?? ""),
            input: "",
          });
        } else if (event.contentBlockDelta?.delta) {
          const delta = event.contentBlockDelta.delta;
          if (typeof delta.text === "string" && delta.text !== "") yield { type: "text", text: delta.text };
          else if (delta.toolUse?.input !== undefined) {
            const call = calls.get(event.contentBlockDelta.contentBlockIndex ?? -1);
            if (call) call.input += delta.toolUse.input;
          }
          // reasoningContent (Nova 2 thinking) is internal and never forwarded.
        } else if (event.messageStop) {
          stopReason = event.messageStop.stopReason;
        } else if (event.metadata?.usage) {
          usage = {
            inputTokens: typeof event.metadata.usage.inputTokens === "number" ? event.metadata.usage.inputTokens : null,
            outputTokens: typeof event.metadata.usage.outputTokens === "number" ? event.metadata.usage.outputTokens : null,
          };
        } else {
          const failure =
            event.throttlingException ??
            event.serviceUnavailableException ??
            event.internalServerException ??
            event.modelStreamErrorException ??
            event.validationException;
          if (failure) throw failure;
        }
      }
    } catch (err) {
      throw toBedrockError(err, request.signal);
    }

    if (calls.size > 0) {
      const toolCalls: ModelToolCall[] = [...calls.values()].map((c) => ({ id: c.id, name: c.name, argumentsJson: c.input.trim() === "" ? "{}" : c.input }));
      yield { type: "tool_calls", calls: toolCalls };
    }
    yield { type: "finish", finishReason: mapStopReason(stopReason), usage, servedModel: model };
  }

  /** Nova's own output limit for the tier (5,000 tokens for an unrecognised id: the smallest tier's). */
  outputTokenCap(model: string): number {
    return novaProfileFor(model)?.maxOutputTokens ?? 5_000;
  }

  /**
   * Micro handles cheap, simple work; Lite is the default; Nova 2 Lite takes quality-preferred,
   * long, document, research and report work and requests that offer tools. A tier the operator
   * did not configure, or one too small for the input, falls through to the next configured one.
   */
  private pickModel(routing: ProviderRoutingContext | undefined, toolsOffered: boolean): string {
    const estimated = routing?.estimatedInputTokens ?? 0;
    const fits = (tier: NovaTier): string | undefined => {
      const id = this.models[tier];
      return id && estimated <= NOVA_PROFILES[tier].contextTokens ? id : undefined;
    };
    const task = routing?.task;
    const heavy =
      routing?.preference === "quality" ||
      estimated > 100_000 ||
      toolsOffered ||
      task === "documents" ||
      task === "research" ||
      task === "reports" ||
      routing?.mode === "documents" ||
      routing?.mode === "research";
    if (heavy && fits("nova2Lite")) return fits("nova2Lite")!;
    const light = routing?.preference === "economy" || (task === "automation" && routing?.preference !== "quality");
    if (light && !heavy && fits("micro")) return fits("micro")!;
    return fits("lite") ?? fits("nova2Lite") ?? fits("micro") ?? this.model;
  }
}

/**
 * Bedrock-safe tool names. DASH names are `plugin__tool` and plugin ids may contain "-"; each
 * request maps every name to letters, digits and "_" (unique, at most 64 characters) and maps the
 * model's tool calls back, so the tool layer only ever sees DASH's own names.
 */
export class ToolNames {
  private readonly aliases = new Map<string, string>();
  private readonly originals = new Map<string, string>();

  constructor(names: Iterable<string>) {
    for (const name of names) this.alias(name);
  }

  alias(name: string): string {
    const existing = this.aliases.get(name);
    if (existing) return existing;
    let base = name.replace(/[^A-Za-z0-9_]/g, "_");
    if (!/^[A-Za-z]/.test(base)) base = `t_${base}`;
    base = base.slice(0, 64);
    let alias = base;
    for (let n = 2; this.originals.has(alias); n++) alias = `${base.slice(0, 64 - `_${n}`.length)}_${n}`;
    this.aliases.set(name, alias);
    this.originals.set(alias, name);
    return alias;
  }

  original(alias: string): string {
    return this.originals.get(alias) ?? alias;
  }
}

/**
 * Provider-neutral turns → Converse messages. Converse refuses blank text blocks and expects the
 * conversation to start with the person and alternate roles, so blank text is dropped, empty
 * messages disappear and neighbours with the same role are merged.
 */
export function toBedrockMessages(turns: readonly ProviderTurn[], names: ToolNames = new ToolNames([])): Message[] {
  const out: Message[] = [];
  const push = (role: "user" | "assistant", content: ContentBlock[]) => {
    if (content.length === 0) return;
    if (out.length === 0 && role === "assistant") return;
    const prev = out[out.length - 1];
    if (prev && prev.role === role) prev.content = [...(prev.content ?? []), ...content];
    else out.push({ role, content });
  };
  for (const turn of turns) {
    if (isToolResultTurn(turn)) {
      push(
        "user",
        turn.results.map((r) => ({
          toolResult: {
            toolUseId: r.callId,
            content: [{ text: r.content.trim() === "" ? "(no output)" : r.content }],
            status: r.isError ? "error" : "success",
          },
        })),
      );
    } else if (isToolCallTurn(turn)) {
      push("assistant", [
        ...(turn.content.trim() !== "" ? [{ text: turn.content }] : []),
        ...turn.toolCalls.map(
          (call): ContentBlock => ({
            toolUse: { toolUseId: call.id, name: names.alias(call.name), input: parseArguments(call.argumentsJson) as ToolInput },
          }),
        ),
      ]);
    } else {
      push(turn.role, turn.content.trim() === "" ? [] : [{ text: turn.content }]);
    }
  }
  return out;
}

/** DASH tool definitions → Converse tool specs (object schema: properties and required only). */
export function toBedrockTools(tools: readonly NormalizedTool[], names: ToolNames = new ToolNames([])): Tool[] {
  return tools.map(
    (tool): Tool => ({
      toolSpec: {
        name: names.alias(tool.name),
        description: tool.description,
        inputSchema: { json: compactObjectSchema(tool.inputSchema) as ToolInput } as ToolInputSchema,
      },
    }),
  );
}

/** The SDK types JSON documents as its own document type; plain JSON objects are what it sends. */
type ToolInput = NonNullable<ContentBlock.ToolUseMember["toolUse"]>["input"];

function compactObjectSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((v): v is string => typeof v === "string") : [];
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

function parseArguments(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapStopReason(reason: string | undefined): "stop" | "length" | "refusal" {
  if (reason === "max_tokens" || reason === "model_context_window_exceeded") return "length";
  if (reason === "content_filtered" || reason === "guardrail_intervened") return "refusal";
  return "stop";
}

interface AwsLikeError {
  name?: string;
  message?: string;
  $metadata?: { httpStatusCode?: number };
}

/**
 * Bedrock Runtime SDK errors → DASH provider errors. Only the error's type and HTTP status are
 * used; Bedrock's own message is never copied (one narrow check below reads it to recognise a
 * model id this account or Region cannot use, which is configuration, not the person's request).
 */
export function toBedrockError(err: unknown, signal?: AbortSignal): ProviderError {
  if (signal?.aborted || err instanceof ProviderError) return toProviderError(DISPLAY_NAME, err, signal);
  const e = (typeof err === "object" && err !== null ? err : {}) as AwsLikeError;
  const status = e.$metadata?.httpStatusCode;
  switch (e.name) {
    case "ThrottlingException":
    case "ServiceQuotaExceededException":
      return new ProviderError("rate_limited", "Amazon Bedrock is receiving too many requests. Try again shortly.", true, status ?? 429);
    case "ModelTimeoutException":
      return new ProviderError("provider_timeout", "Amazon Bedrock took too long to respond.", true, status ?? 408);
    case "ModelNotReadyException":
    case "InternalServerException":
    case "ServiceUnavailableException":
    case "ModelErrorException":
    case "ModelStreamErrorException":
      return new ProviderError("provider_error", "Amazon Bedrock is temporarily unavailable. Try again.", true, status ?? 503);
    case "AccessDeniedException":
      // Also what Bedrock answers when this account has no access to the configured model.
      return new ProviderError("provider_error", "Amazon Bedrock refused the server's credentials or model access.", false, status ?? 403);
    case "UnrecognizedClientException":
    case "InvalidSignatureException":
    case "ExpiredTokenException":
    case "CredentialsProviderError":
    case "TokenProviderError":
      return new ProviderError("provider_error", "Amazon Bedrock could not authenticate the server.", false, 401);
    case "ResourceNotFoundException":
      return new ProviderError("provider_error", "Amazon Bedrock does not have the configured model.", false, status ?? 404);
    case "ValidationException":
      if (/model identifier|on-demand throughput|inference profile|model id/i.test(e.message ?? "")) {
        return new ProviderError("provider_error", "Amazon Bedrock cannot use the configured model id here.", false, 404);
      }
      return new ProviderError("provider_error", "Amazon Bedrock could not process this request.", false, status ?? 400);
    default:
      return toProviderError(DISPLAY_NAME, status === undefined ? err : { name: e.name, status }, signal);
  }
}
