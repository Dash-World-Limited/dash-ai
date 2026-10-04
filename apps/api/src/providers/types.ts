import type { FinishReason, ProviderId, Usage } from "@dash-ai/contracts";
import type { ModelToolCall, NormalizedTool } from "../tools/types.js";

export interface ProviderMessage {
  role: "user" | "assistant";
  content: string;
}

/** An assistant turn that asked for tools (its text, if any, came before the calls). */
export interface ProviderToolCallTurn {
  role: "assistant";
  content: string;
  toolCalls: ModelToolCall[];
}

export interface ProviderToolResult {
  callId: string;
  name: string;
  content: string;
  isError: boolean;
}

/** The backend's answers to the previous assistant turn's tool calls. */
export interface ProviderToolResultTurn {
  role: "tool";
  results: ProviderToolResult[];
}

/**
 * Provider-neutral conversation. Each adapter translates this to its own wire format (OpenAI
 * Responses input items, Anthropic Messages content blocks), so tool state never leaks between
 * providers: one provider's tool turns are only ever replayed to that same provider.
 */
export type ProviderTurn = ProviderMessage | ProviderToolCallTurn | ProviderToolResultTurn;

export const isToolCallTurn = (t: ProviderTurn): t is ProviderToolCallTurn => t.role === "assistant" && "toolCalls" in t;
export const isToolResultTurn = (t: ProviderTurn): t is ProviderToolResultTurn => t.role === "tool";

export interface ProviderRequest {
  system: string;
  messages: ProviderTurn[];
  /** Tools the model may call this round. Omit to disable tool calling. */
  tools?: NormalizedTool[];
  maxOutputTokens: number;
  signal: AbortSignal;
}

export type ProviderChunk =
  | { type: "text"; text: string }
  /** Structured tool requests, emitted once before the finish chunk. Only these are ever acted on. */
  | { type: "tool_calls"; calls: ModelToolCall[] }
  | {
      type: "finish";
      finishReason: Exclude<FinishReason, "cancelled">;
      usage: Usage;
      /** The model id the provider says actually served the request (may differ from the configured alias). */
      servedModel?: string | null;
    };

/** One AI provider behind a common streaming interface. */
export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly model: string;
  /** True for fake adapters. Their output must always be labelled as a demonstration. */
  readonly demo: boolean;
  stream(request: ProviderRequest): AsyncIterable<ProviderChunk>;
}

export type ProviderErrorCode = "provider_error" | "provider_timeout" | "rate_limited" | "cancelled";

/** A provider failure with a user-safe message (never includes prompt or provider response text). */
export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

const EMPTY_USAGE: Usage = { inputTokens: null, outputTokens: null };
export const emptyUsage = (): Usage => ({ ...EMPTY_USAGE });

interface SdkLikeError {
  name?: string;
  status?: number;
}

/** Maps SDK/network errors to ProviderError without copying provider error text. */
export function toProviderError(displayName: string, err: unknown, signal?: AbortSignal): ProviderError {
  if (err instanceof ProviderError) return err;
  if (signal?.aborted) {
    return signal.reason === "timeout"
      ? new ProviderError("provider_timeout", `${displayName} took too long to respond.`, true)
      : new ProviderError("cancelled", "Generation was stopped.", false);
  }
  const e = (typeof err === "object" && err !== null ? err : {}) as SdkLikeError;
  const name = e.name ?? "";
  if (name === "AbortError" || name === "APIUserAbortError") {
    return new ProviderError("cancelled", "Generation was stopped.", false);
  }
  if (name === "APIConnectionTimeoutError" || name === "TimeoutError") {
    return new ProviderError("provider_timeout", `${displayName} took too long to respond.`, true);
  }
  const status = typeof e.status === "number" ? e.status : undefined;
  if (status === 429) {
    return new ProviderError("rate_limited", `${displayName} is receiving too many requests. Try again shortly.`, true, status);
  }
  if (status === 401 || status === 403) {
    return new ProviderError(
      "provider_error",
      `${displayName} rejected the server's credentials. The server administrator needs to check the API key.`,
      false,
      status,
    );
  }
  if (status === 400 || status === 404 || status === 413 || status === 422) {
    return new ProviderError(
      "provider_error",
      `${displayName} could not process this request (it may be too long, or the configured model may be unavailable).`,
      false,
      status,
    );
  }
  if (status !== undefined && status >= 500) {
    return new ProviderError("provider_error", `${displayName} is temporarily unavailable. Try again.`, true, status);
  }
  return new ProviderError("provider_error", `Could not reach ${displayName}. Try again.`, true, status);
}
