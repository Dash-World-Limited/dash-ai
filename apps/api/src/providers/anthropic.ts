import Anthropic from "@anthropic-ai/sdk";
import type { FinishReason } from "@dash-ai/contracts";
import type { ModelToolCall, NormalizedTool } from "../tools/types.js";
import type { SdkAdapterOptions } from "./openai.js";
import {
  isToolCallTurn,
  isToolResultTurn,
  ProviderError,
  toProviderError,
  type ProviderAdapter,
  type ProviderChunk,
  type ProviderRequest,
  type ProviderTurn,
} from "./types.js";

/** Normalised tool definitions → Anthropic Messages API tools. */
export function toAnthropicTools(tools: readonly NormalizedTool[]): Anthropic.Messages.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Messages.Tool.InputSchema,
  }));
}

function parseInput(argumentsJson: string): Record<string, unknown> {
  try {
    const value: unknown = argumentsJson.trim() === "" ? {} : JSON.parse(argumentsJson);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    // The executor will reject the original text; the API just needs a JSON object to replay.
    return {};
  }
}

/** Provider-neutral turns → Messages API messages. Tool results travel in a user turn. */
export function toAnthropicMessages(turns: readonly ProviderTurn[]): Anthropic.Messages.MessageParam[] {
  const out: Anthropic.Messages.MessageParam[] = [];
  for (const turn of turns) {
    if (isToolResultTurn(turn)) {
      out.push({
        role: "user",
        content: turn.results.map((r) => ({
          type: "tool_result" as const,
          tool_use_id: r.callId,
          content: r.content,
          is_error: r.isError,
        })),
      });
    } else if (isToolCallTurn(turn)) {
      out.push({
        role: "assistant",
        content: [
          ...(turn.content ? [{ type: "text" as const, text: turn.content }] : []),
          ...turn.toolCalls.map((c) => ({ type: "tool_use" as const, id: c.id, name: c.name, input: parseInput(c.argumentsJson) })),
        ],
      });
    } else {
      out.push({ role: turn.role, content: turn.content });
    }
  }
  return out;
}

/** Anthropic Claude adapter using the official SDK and the Messages API. */
export class AnthropicAdapter implements ProviderAdapter {
  readonly id = "anthropic" as const;
  readonly displayName = "Claude";
  readonly demo = false;
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    readonly model: string,
    options: SdkAdapterOptions = {},
  ) {
    this.client = new Anthropic({
      apiKey,
      maxRetries: options.maxRetries ?? 1,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    });
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderChunk> {
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    let stopReason: string | null = null;
    let servedModel: string | null = null;
    const pendingTools = new Map<number, { id: string; name: string; json: string }>();
    const finishChunk = (): ProviderChunk[] => {
      const calls: ModelToolCall[] = [...pendingTools.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, t]) => ({ id: t.id, name: t.name, argumentsJson: t.json }));
      return [
        ...(calls.length > 0 ? [{ type: "tool_calls" as const, calls }] : []),
        { type: "finish", finishReason: mapStopReason(stopReason), usage: { inputTokens, outputTokens }, servedModel },
      ];
    };
    try {
      const stream = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: request.maxOutputTokens,
          system: request.system,
          messages: toAnthropicMessages(request.messages),
          ...(request.tools && request.tools.length > 0 ? { tools: toAnthropicTools(request.tools) } : {}),
          stream: true,
        },
        { signal: request.signal },
      );
      for await (const event of stream) {
        switch (event.type) {
          case "message_start":
            servedModel = event.message.model ?? null;
            inputTokens = event.message.usage.input_tokens ?? null;
            outputTokens = event.message.usage.output_tokens ?? null;
            break;
          case "content_block_start":
            if (event.content_block.type === "tool_use") {
              pendingTools.set(event.index, { id: event.content_block.id, name: event.content_block.name, json: "" });
            }
            break;
          case "content_block_delta":
            if (event.delta.type === "text_delta" && event.delta.text) {
              yield { type: "text", text: event.delta.text };
            } else if (event.delta.type === "input_json_delta") {
              const pending = pendingTools.get(event.index);
              if (pending) pending.json += event.delta.partial_json;
            }
            break;
          case "message_delta":
            stopReason = event.delta.stop_reason ?? stopReason;
            if (typeof event.usage.output_tokens === "number") outputTokens = event.usage.output_tokens;
            // Newer API versions report cumulative input tokens here too.
            if (typeof event.usage.input_tokens === "number") inputTokens = event.usage.input_tokens;
            break;
          case "message_stop":
            yield* finishChunk();
            return;
          default:
            break;
        }
      }
      // The SDK ends the iteration silently when the request is aborted: that is a cancellation.
      if (request.signal.aborted) throw request.signal.reason ?? new Error("aborted");
      // The connection ended without message_stop: never present a possibly cut-off answer as complete.
      throw new ProviderError("provider_error", "Claude's response ended unexpectedly. Try again.", true);
    } catch (err) {
      throw toProviderError(this.displayName, err, request.signal);
    }
  }
}

function mapStopReason(reason: string | null): Exclude<FinishReason, "cancelled"> {
  switch (reason) {
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "refusal":
      return "refusal";
    default:
      return "stop";
  }
}
