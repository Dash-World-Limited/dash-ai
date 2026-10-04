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
    } else if (isToolCallTurn(turn) && isOpenAIContinuation(turn.continuation, turn.toolCalls)) {
      input.push(...turn.continuation.items);
    } else if (isToolCallTurn(turn)) {
      if (turn.content) input.push({ role: "assistant", content: turn.content });
      for (const c of turn.toolCalls) input.push({ type: "function_call", call_id: c.id, name: c.name, arguments: c.argumentsJson });
    } else {
      input.push({ role: turn.role, content: turn.content });
    }
  }
  return input;
}

/**
 * OpenAI's own output items for a tool-use turn (encrypted reasoning, message, function_call), replayed
 * verbatim so a reasoning model keeps its reasoning between tool rounds while `store` stays false.
 */
interface OpenAIContinuation {
  provider: "openai";
  items: OpenAI.Responses.ResponseInputItem[];
}

const isOpenAIContinuation = (value: unknown, calls: readonly ModelToolCall[]): value is OpenAIContinuation => {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<OpenAIContinuation>;
  if (v.provider !== "openai" || !Array.isArray(v.items)) return false;
  const ids = v.items.filter((i) => i.type === "function_call").map((i) => (i as OpenAI.Responses.ResponseFunctionToolCall).call_id);
  return ids.length === calls.length && ids.every((id, n) => id === calls[n]!.id);
};

export interface SdkAdapterOptions {
  /** Injected fetch, used by tests to replay recorded provider streams without network access. */
  fetch?: typeof fetch;
  maxRetries?: number;
  baseURL?: string;
  /**
   * OpenAI only: request encrypted reasoning items in tool rounds and replay them (OPENAI_ENCRYPTED_REASONING).
   * Off by default until verified against the live API with the configured model.
   */
  encryptedReasoning?: boolean;
}

/** OpenAI adapter using the official SDK and the Responses API. */
export class OpenAIAdapter implements ProviderAdapter {
  readonly id = "openai" as const;
  readonly displayName = "OpenAI";
  readonly demo = false;
  private readonly client: OpenAI;
  private readonly encryptedReasoning: boolean;

  constructor(
    apiKey: string,
    readonly model: string,
    options: SdkAdapterOptions = {},
  ) {
    this.encryptedReasoning = options.encryptedReasoning ?? false;
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
          ...(request.tools && request.tools.length > 0 ? { tools: toOpenAITools(request.tools), tool_choice: request.toolChoice ?? "auto" } : {}),
          ...(request.tools && request.tools.length > 0 && this.encryptedReasoning ? { include: ["reasoning.encrypted_content" as const] } : {}),
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
            if (calls.length > 0) {
              const continuation = readContinuation(event.response.output);
              yield { type: "tool_calls", calls, ...(continuation ? { continuation } : {}) };
            }
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
            throw mapStreamFailure(event.response.error?.code);
          case "error":
            throw mapStreamFailure(event.code);
          default:
            break;
        }
      }
      // The SDK ends the iteration silently when the request is aborted: that is a cancellation.
      if (request.signal.aborted) throw request.signal.reason ?? new Error("aborted");
      // The connection ended without a terminal event: the answer may be cut off, so never present
      // it as complete.
      throw new ProviderError("provider_error", "OpenAI's response ended unexpectedly. Try again.", true);
    } catch (err) {
      throw toProviderError(this.displayName, err, request.signal);
    }
  }
}

/** Maps an in-stream failure code to a safe error. Provider message text is never copied. */
function mapStreamFailure(code: string | null | undefined): ProviderError {
  if (code === "rate_limit_exceeded") {
    return new ProviderError("rate_limited", "OpenAI is receiving too many requests. Try again shortly.", true);
  }
  if (code === "insufficient_quota" || code === "invalid_api_key") {
    return new ProviderError(
      "provider_error",
      "OpenAI rejected the server's credentials or quota. The server administrator needs to check the account.",
      false,
    );
  }
  if (code === "context_length_exceeded") {
    return new ProviderError("provider_error", "This request is too long for OpenAI. Start a new chat.", false);
  }
  return new ProviderError("provider_error", "OpenAI could not complete the response.", true);
}

/** Function calls from a completed response, exactly as the model emitted them. */
function readToolCalls(output: OpenAI.Responses.ResponseOutputItem[] | undefined): ModelToolCall[] {
  const calls: ModelToolCall[] = [];
  for (const item of output ?? []) {
    if (item.type === "function_call") calls.push({ id: item.call_id, name: item.name, argumentsJson: item.arguments ?? "" });
  }
  return calls;
}

/**
 * Only when the response carries encrypted reasoning is an exact replay both possible and useful; without
 * it (store is false) reasoning items cannot be referenced, so the turn is rebuilt from text + calls.
 */
function readContinuation(output: OpenAI.Responses.ResponseOutputItem[] | undefined): OpenAIContinuation | undefined {
  const items = output ?? [];
  const hasEncryptedReasoning = items.some((i) => i.type === "reasoning" && typeof i.encrypted_content === "string" && i.encrypted_content !== "");
  if (!hasEncryptedReasoning) return undefined;
  const replayable = items.filter((i) => i.type === "reasoning" || i.type === "message" || i.type === "function_call");
  return { provider: "openai", items: replayable as OpenAI.Responses.ResponseInputItem[] };
}

function readUsage(u: { input_tokens?: number; output_tokens?: number } | null | undefined): Usage {
  return {
    inputTokens: typeof u?.input_tokens === "number" ? u.input_tokens : null,
    outputTokens: typeof u?.output_tokens === "number" ? u.output_tokens : null,
  };
}
