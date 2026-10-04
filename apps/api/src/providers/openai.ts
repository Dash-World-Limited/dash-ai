import OpenAI from "openai";
import type { Usage } from "@dash-ai/contracts";
import type { ModelToolCall, NormalizedTool } from "../tools/types.js";
import {
  ProviderError,
  emptyUsage,
  isToolCallTurn,
  isToolResultTurn,
  toProviderError,
  type ProviderAdapter,
  type ProviderChunk,
  type ProviderRequest,
  type ProviderTurn,
} from "./types.js";

type ResponseInput = OpenAI.Responses.ResponseInput;

/** Normalised tool definitions → OpenAI Responses API function tools. */
export function toOpenAITools(tools: readonly NormalizedTool[]): OpenAI.Responses.FunctionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
    // Non-strict: zod-derived schemas may have optional properties, which strict mode forbids.
    // The backend validates every call against the real schema anyway.
    strict: false,
  }));
}

/** Provider-neutral turns → Responses API input items (stateless: store is false). */
export function toOpenAIInput(turns: readonly ProviderTurn[]): ResponseInput {
  const input: ResponseInput = [];
  for (const turn of turns) {
    if (isToolResultTurn(turn)) {
      for (const r of turn.results) input.push({ type: "function_call_output", call_id: r.callId, output: r.content });
    } else if (isToolCallTurn(turn)) {
      if (turn.content) input.push({ role: "assistant", content: turn.content });
      for (const c of turn.toolCalls) input.push({ type: "function_call", call_id: c.id, name: c.name, arguments: c.argumentsJson });
    } else {
      input.push({ role: turn.role, content: turn.content });
    }
  }
  return input;
}

export interface SdkAdapterOptions {
  /** Injected fetch, used by tests to replay recorded provider streams without network access. */
  fetch?: typeof fetch;
  maxRetries?: number;
  baseURL?: string;
}

/** OpenAI adapter using the official SDK and the Responses API. */
export class OpenAIAdapter implements ProviderAdapter {
  readonly id = "openai" as const;
  readonly displayName = "OpenAI";
  readonly demo = false;
  private readonly client: OpenAI;

  constructor(
    apiKey: string,
    readonly model: string,
    options: SdkAdapterOptions = {},
  ) {
    this.client = new OpenAI({
      apiKey,
      maxRetries: options.maxRetries ?? 1,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    });
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderChunk> {
    let usage: Usage = emptyUsage();
    let refused = false;
    try {
      const stream = await this.client.responses.create(
        {
          model: this.model,
          instructions: request.system,
          input: toOpenAIInput(request.messages),
          ...(request.tools && request.tools.length > 0 ? { tools: toOpenAITools(request.tools), tool_choice: "auto" as const } : {}),
          max_output_tokens: request.maxOutputTokens,
          stream: true,
          // Do not ask OpenAI to retain the response for later retrieval.
          store: false,
        },
        { signal: request.signal },
      );
      for await (const event of stream) {
        switch (event.type) {
          case "response.output_text.delta":
            if (event.delta) yield { type: "text", text: event.delta };
            break;
          case "response.refusal.delta":
            refused = true;
            if (event.delta) yield { type: "text", text: event.delta };
            break;
          case "response.completed": {
            usage = readUsage(event.response.usage);
            const calls = readToolCalls(event.response.output);
            if (calls.length > 0) yield { type: "tool_calls", calls };
            yield {
              type: "finish",
              finishReason: refused ? "refusal" : "stop",
              usage,
              servedModel: event.response.model ?? null,
            };
            return;
          }
          case "response.incomplete": {
            usage = readUsage(event.response.usage);
            const reason = event.response.incomplete_details?.reason;
            yield {
              type: "finish",
              finishReason: reason === "max_output_tokens" ? "length" : reason === "content_filter" ? "refusal" : "stop",
              usage,
              servedModel: event.response.model ?? null,
            };
            return;
          }
          case "response.failed":
            throw new ProviderError("provider_error", "OpenAI could not complete the response.", true);
          case "error":
            throw new ProviderError("provider_error", "OpenAI reported an error while streaming.", true);
          default:
            break;
        }
      }
      yield { type: "finish", finishReason: refused ? "refusal" : "stop", usage };
    } catch (err) {
      throw toProviderError(this.displayName, err, request.signal);
    }
  }
}

/** Function calls from a completed response, exactly as the model emitted them. */
function readToolCalls(output: OpenAI.Responses.ResponseOutputItem[] | undefined): ModelToolCall[] {
  const calls: ModelToolCall[] = [];
  for (const item of output ?? []) {
    if (item.type === "function_call") calls.push({ id: item.call_id, name: item.name, argumentsJson: item.arguments ?? "" });
  }
  return calls;
}

function readUsage(u: { input_tokens?: number; output_tokens?: number } | null | undefined): Usage {
  return {
    inputTokens: typeof u?.input_tokens === "number" ? u.input_tokens : null,
    outputTokens: typeof u?.output_tokens === "number" ? u.output_tokens : null,
  };
}
