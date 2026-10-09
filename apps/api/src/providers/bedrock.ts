import type { Usage } from "@dash-ai/contracts";
import type { ModelToolCall, NormalizedTool } from "../tools/types.js";
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

export interface BedrockModels {
  micro?: string;
  lite?: string;
  nova2Lite?: string;
}

export interface BedrockAdapterOptions {
  /** Injected fetch for tests. Production uses the platform fetch implementation. */
  fetch?: typeof fetch;
}

type BedrockContentBlock =
  | { text: string }
  | { toolUse: { toolUseId: string; name: string; input: Record<string, unknown> } }
  | { toolResult: { toolUseId: string; content: Array<{ text: string }>; status: "success" | "error" } };

interface BedrockMessage {
  role: "user" | "assistant";
  content: BedrockContentBlock[];
}

interface BedrockResponse {
  output?: { message?: { role?: string; content?: Array<{ text?: string; toolUse?: { toolUseId?: string; name?: string; input?: unknown } }> } };
  stopReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

/**
 * Amazon Bedrock adapter using the native Converse HTTP API with a Bedrock bearer API key.
 *
 * It intentionally sits behind the same ProviderAdapter boundary as every other engine. The DASH
 * Intelligence Router chooses Bedrock; this adapter then chooses the cheapest suitable Nova tier
 * that the operator configured. No Bedrock key, model id or provider wording reaches consumers.
 *
 * The first production slice uses Converse (one HTTP response) rather than ConverseStream. That
 * keeps the integration dependency-free while preserving the provider-neutral streaming contract:
 * the completed text is emitted as a normal text chunk. Moving to ConverseStream later changes only
 * this adapter, not the app, router, storage or public API.
 */
export class BedrockAdapter implements ProviderAdapter {
  readonly id = "bedrock" as const;
  readonly displayName = "Amazon Bedrock";
  readonly demo = false;
  readonly model: string;

  private readonly request: typeof fetch;

  constructor(
    private readonly apiKey: string,
    private readonly region: string,
    private readonly models: BedrockModels,
    options: BedrockAdapterOptions = {},
  ) {
    const configured = [models.micro, models.lite, models.nova2Lite].filter((m): m is string => Boolean(m));
    if (configured.length === 0) throw new Error("Bedrock needs at least one configured model.");
    // ProviderStatus needs one stable value. Per-request storage uses the servedModel emitted below.
    this.model = models.lite ?? models.nova2Lite ?? models.micro!;
    this.request = options.fetch ?? fetch;
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderChunk> {
    const model = this.pickModel(request.routing, Boolean(request.tools?.length));
    const url = `https://bedrock-runtime.${this.region}.amazonaws.com/model/${encodeURIComponent(model)}/converse`;
    const body = {
      system: [{ text: request.system }],
      messages: toBedrockMessages(request.messages),
      inferenceConfig: {
        maxTokens: Math.min(request.maxOutputTokens, maxOutputTokens(model)),
        ...(request.tools && request.tools.length > 0 ? { temperature: 0 } : {}),
      },
      ...(request.tools && request.tools.length > 0 && request.toolChoice !== "none"
        ? { toolConfig: { tools: toBedrockTools(request.tools), toolChoice: { auto: {} } } }
        : {}),
    };

    try {
      const response = await this.request(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: request.signal,
      });
      if (!response.ok) throw fromHttpStatus(response.status);

      const payload = (await response.json()) as BedrockResponse;
      const blocks = payload.output?.message?.content ?? [];
      const calls: ModelToolCall[] = [];
      for (const block of blocks) {
        if (typeof block.text === "string" && block.text !== "") yield { type: "text", text: block.text };
        const tool = block.toolUse;
        if (tool?.toolUseId && tool.name) {
          calls.push({
            id: tool.toolUseId,
            name: tool.name,
            argumentsJson: JSON.stringify(isRecord(tool.input) ? tool.input : {}),
          });
        }
      }
      if (calls.length > 0) yield { type: "tool_calls", calls };

      const usage: Usage = {
        inputTokens: typeof payload.usage?.inputTokens === "number" ? payload.usage.inputTokens : null,
        outputTokens: typeof payload.usage?.outputTokens === "number" ? payload.usage.outputTokens : null,
      };
      yield {
        type: "finish",
        finishReason: mapStopReason(payload.stopReason),
        usage,
        servedModel: model,
      };
    } catch (err) {
      throw toProviderError(this.displayName, err, request.signal);
    }
  }

  /**
   * Micro handles cheap/simple work, Lite is the default, and Nova 2 Lite is the escalation path for
   * long context, document/research/report work, tool-heavy requests and explicit quality preference.
   * Missing tiers fall through to the next configured model rather than making the request unavailable.
   */
  private pickModel(routing: ProviderRoutingContext | undefined, toolsOffered: boolean): string {
    const { micro, lite, nova2Lite } = this.models;
    const task = routing?.task;
    const estimated = routing?.estimatedInputTokens ?? 0;
    if (
      nova2Lite &&
      (routing?.preference === "quality" || estimated > 100_000 || toolsOffered || task === "documents" || task === "research" || task === "reports")
    ) {
      return nova2Lite;
    }
    if (routing?.preference === "economy" && micro) return micro;
    if (task === "automation" && micro && routing?.preference !== "quality") return micro;
    return lite ?? nova2Lite ?? micro!;
  }
}

/** Provider-neutral turns → Bedrock Converse messages. */
export function toBedrockMessages(turns: readonly ProviderTurn[]): BedrockMessage[] {
  const messages: BedrockMessage[] = [];
  for (const turn of turns) {
    if (isToolResultTurn(turn)) {
      messages.push({
        role: "user",
        content: turn.results.map((r) => ({
          toolResult: {
            toolUseId: r.callId,
            content: [{ text: r.content }],
            status: r.isError ? "error" : "success",
          },
        })),
      });
      continue;
    }
    if (isToolCallTurn(turn)) {
      const content: BedrockContentBlock[] = [];
      if (turn.content) content.push({ text: turn.content });
      for (const call of turn.toolCalls) {
        content.push({
          toolUse: {
            toolUseId: call.id,
            name: call.name,
            input: parseArguments(call.argumentsJson),
          },
        });
      }
      messages.push({ role: "assistant", content });
      continue;
    }
    messages.push({ role: turn.role, content: [{ text: turn.content }] });
  }
  return messages;
}

/** Nova tool schemas accept the ordinary object-schema fields used by DASH tools. */
export function toBedrockTools(tools: readonly NormalizedTool[]): Array<{ toolSpec: { name: string; description: string; inputSchema: { json: Record<string, unknown> } } }> {
  return tools.map((tool) => ({
    toolSpec: {
      name: tool.name,
      description: tool.description,
      inputSchema: { json: compactObjectSchema(tool.inputSchema) },
    },
  }));
}

function compactObjectSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((v): v is string => typeof v === "string") : [];
  return {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
  };
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

function maxOutputTokens(model: string): number {
  if (model.includes("nova-2-lite")) return 64_000;
  if (model.includes("nova-micro")) return 10_000;
  if (model.includes("nova-lite")) return 5_000;
  return 5_000;
}

function mapStopReason(reason: string | undefined): "stop" | "length" | "refusal" {
  if (reason === "max_tokens") return "length";
  if (reason === "content_filtered" || reason === "guardrail_intervened") return "refusal";
  return "stop";
}

function fromHttpStatus(status: number): ProviderError {
  if (status === 429) return new ProviderError("rate_limited", "Amazon Bedrock is receiving too many requests. Try again shortly.", true, status);
  if (status === 408 || status === 504) return new ProviderError("provider_timeout", "Amazon Bedrock took too long to respond.", true, status);
  if (status === 401 || status === 403) {
    return new ProviderError("provider_error", "Amazon Bedrock rejected the server credentials.", false, status);
  }
  if (status === 400 || status === 404 || status === 413 || status === 422) {
    return new ProviderError("provider_error", "Amazon Bedrock could not process this request.", false, status);
  }
  if (status >= 500) return new ProviderError("provider_error", "Amazon Bedrock is temporarily unavailable.", true, status);
  return new ProviderError("provider_error", "Could not reach Amazon Bedrock.", true, status);
}
