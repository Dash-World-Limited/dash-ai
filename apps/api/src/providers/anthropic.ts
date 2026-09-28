import Anthropic from "@anthropic-ai/sdk";
import type { FinishReason } from "@dash-ai/contracts";
import type { SdkAdapterOptions } from "./openai.js";
import { toProviderError, type ProviderAdapter, type ProviderChunk, type ProviderRequest } from "./types.js";

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
    try {
      const stream = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: request.maxOutputTokens,
          system: request.system,
          messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
          stream: true,
        },
        { signal: request.signal },
      );
      for await (const event of stream) {
        switch (event.type) {
          case "message_start":
            inputTokens = event.message.usage.input_tokens ?? null;
            outputTokens = event.message.usage.output_tokens ?? null;
            break;
          case "content_block_delta":
            if (event.delta.type === "text_delta" && event.delta.text) {
              yield { type: "text", text: event.delta.text };
            }
            break;
          case "message_delta":
            stopReason = event.delta.stop_reason ?? stopReason;
            if (typeof event.usage.output_tokens === "number") outputTokens = event.usage.output_tokens;
            break;
          case "message_stop":
            yield { type: "finish", finishReason: mapStopReason(stopReason), usage: { inputTokens, outputTokens } };
            return;
          default:
            break;
        }
      }
      yield { type: "finish", finishReason: mapStopReason(stopReason), usage: { inputTokens, outputTokens } };
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
