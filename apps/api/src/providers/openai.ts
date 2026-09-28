import OpenAI from "openai";
import type { Usage } from "@dash-ai/contracts";
import {
  ProviderError,
  emptyUsage,
  toProviderError,
  type ProviderAdapter,
  type ProviderChunk,
  type ProviderRequest,
} from "./types.js";

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
          input: request.messages.map((m) => ({ role: m.role, content: m.content })),
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
          case "response.completed":
            usage = readUsage(event.response.usage);
            yield { type: "finish", finishReason: refused ? "refusal" : "stop", usage };
            return;
          case "response.incomplete": {
            usage = readUsage(event.response.usage);
            const reason = event.response.incomplete_details?.reason;
            yield {
              type: "finish",
              finishReason: reason === "max_output_tokens" ? "length" : reason === "content_filter" ? "refusal" : "stop",
              usage,
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

function readUsage(u: { input_tokens?: number; output_tokens?: number } | null | undefined): Usage {
  return {
    inputTokens: typeof u?.input_tokens === "number" ? u.input_tokens : null,
    outputTokens: typeof u?.output_tokens === "number" ? u.output_tokens : null,
  };
}
