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

type AssistantBlock = Anthropic.Messages.ContentBlockParam;

/**
 * The assistant content of a tool-use turn exactly as Claude returned it. Current Claude models think
 * by default, and the API requires a tool-use turn to be sent back with its thinking blocks unmodified
 * and in their original order; rebuilding the turn from text + tool_use would be rejected.
 */
interface ClaudeContinuation {
  provider: "anthropic";
  content: AssistantBlock[];
}

const isClaudeContinuation = (value: unknown, calls: readonly ModelToolCall[]): value is ClaudeContinuation => {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<ClaudeContinuation>;
  if (v.provider !== "anthropic" || !Array.isArray(v.content)) return false;
  // It must describe exactly these tool calls; otherwise rebuild rather than send something inconsistent.
  const ids = v.content.filter((b) => b.type === "tool_use").map((b) => (b as Anthropic.Messages.ToolUseBlockParam).id);
  return ids.length === calls.length && ids.every((id, i) => id === calls[i]!.id);
};

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
    } else if (isToolCallTurn(turn) && isClaudeContinuation(turn.continuation, turn.toolCalls)) {
      out.push({ role: "assistant", content: turn.continuation.content });
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
    let cacheTokens = 0;
    // Every content block of the response, by index, as it streams in.
    type Building =
      | { kind: "text"; text: string }
      | { kind: "thinking"; thinking: string; signature: string }
      | { kind: "redacted_thinking"; data: string }
      | { kind: "tool_use"; id: string; name: string; json: string }
      | { kind: "other" };
    const blocks = new Map<number, Building>();
    const finishChunk = (): ProviderChunk[] => {
      const ordered = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, b]) => b);
      const calls: ModelToolCall[] = ordered.flatMap((b) =>
        b.kind === "tool_use" ? [{ id: b.id, name: b.name, argumentsJson: b.json }] : [],
      );
      // Replaying is only exact if we understood every block; otherwise the turn is rebuilt instead.
      const exact = ordered.every((b) => b.kind !== "other");
      const continuation: ClaudeContinuation | undefined = exact
        ? {
            provider: "anthropic",
            content: ordered.flatMap((b): AssistantBlock[] => {
              switch (b.kind) {
                case "text":
                  return b.text === "" ? [] : [{ type: "text", text: b.text }];
                case "thinking":
                  return [{ type: "thinking", thinking: b.thinking, signature: b.signature }];
                case "redacted_thinking":
                  return [{ type: "redacted_thinking", data: b.data }];
                case "tool_use":
                  return [{ type: "tool_use", id: b.id, name: b.name, input: parseInput(b.json) }];
                default:
                  return [];
              }
            }),
          }
        : undefined;
      const usage = { inputTokens: inputTokens === null ? null : inputTokens + cacheTokens, outputTokens };
      return [
        ...(calls.length > 0 ? [{ type: "tool_calls" as const, calls, ...(continuation ? { continuation } : {}) }] : []),
        { type: "finish", finishReason: mapStopReason(stopReason), usage, servedModel },
      ];
    };
    try {
      const stream = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: request.maxOutputTokens,
          system: request.system,
          messages: toAnthropicMessages(request.messages),
          ...(request.tools && request.tools.length > 0
            ? { tools: toAnthropicTools(request.tools), ...(request.toolChoice === "none" ? { tool_choice: { type: "none" as const } } : {}) }
            : {}),
          stream: true,
        },
        { signal: request.signal },
      );
      for await (const event of stream) {
        switch (event.type) {
          case "message_start": {
            servedModel = event.message.model ?? null;
            const u = event.message.usage;
            inputTokens = u.input_tokens ?? null;
            outputTokens = u.output_tokens ?? null;
            // Billed input also includes prompt-cache writes and reads, which input_tokens excludes.
            cacheTokens = (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
            break;
          }
          case "content_block_start": {
            const b = event.content_block;
            if (b.type === "text") blocks.set(event.index, { kind: "text", text: b.text ?? "" });
            else if (b.type === "thinking") blocks.set(event.index, { kind: "thinking", thinking: b.thinking ?? "", signature: b.signature ?? "" });
            else if (b.type === "redacted_thinking") blocks.set(event.index, { kind: "redacted_thinking", data: b.data });
            else if (b.type === "tool_use") blocks.set(event.index, { kind: "tool_use", id: b.id, name: b.name, json: "" });
            else blocks.set(event.index, { kind: "other" });
            break;
          }
          case "content_block_delta": {
            const block = blocks.get(event.index);
            if (event.delta.type === "text_delta") {
              if (block?.kind === "text") block.text += event.delta.text;
              if (event.delta.text) yield { type: "text", text: event.delta.text };
            } else if (event.delta.type === "input_json_delta") {
              if (block?.kind === "tool_use") block.json += event.delta.partial_json;
            } else if (event.delta.type === "thinking_delta") {
              if (block?.kind === "thinking") block.thinking += event.delta.thinking;
            } else if (event.delta.type === "signature_delta") {
              if (block?.kind === "thinking") block.signature = event.delta.signature;
            }
            break;
          }
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
