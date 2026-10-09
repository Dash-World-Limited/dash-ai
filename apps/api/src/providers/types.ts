import type { AssistantMode, FinishReason, ProviderId, Usage } from "@dash-ai/contracts";
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
  /**
   * Opaque, provider-owned record of this assistant turn exactly as the provider returned it (for
   * example Claude's thinking blocks, which must be replayed unmodified and in order, or OpenAI's
   * encrypted reasoning items). Only the adapter that produced it reads it, and the orchestrator only
   * ever sends it back to that same provider. Adapters fall back to rebuilding the turn from
   * `content` + `toolCalls` when it is absent or does not match.
   */
  continuation?: unknown;
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
 * Responses input items, Anthropic Messages content blocks, Bedrock Converse blocks), so tool state
 * never leaks between providers: one provider's tool turns are only ever replayed to that same provider.
 */
export type ProviderTurn = ProviderMessage | ProviderToolCallTurn | ProviderToolResultTurn;

export const isToolCallTurn = (t: ProviderTurn): t is ProviderToolCallTurn => t.role === "assistant" && "toolCalls" in t;
export const isToolResultTurn = (t: ProviderTurn): t is ProviderToolResultTurn => t.role === "tool";

/**
 * Provider-neutral routing metadata. Providers may use it only to choose between models they own;
 * the DASH Intelligence Router still decides which provider receives the request.
 */
export interface ProviderRoutingContext {
  task: string;
  mode?: AssistantMode;
  preference?: "balanced" | "quality" | "speed" | "economy";
  estimatedInputTokens?: number;
}

export interface ProviderRequest {
  system: string;
  messages: ProviderTurn[];
  /** Tools offered in this response. Omit when the user has none enabled. */
  tools?: NormalizedTool[];
  /**
   * "none" keeps `tools` exactly as before but tells the model it may not call one this round. Tool
   * use is switched off this way, never by dropping `tools`: Claude ties replayed thinking to the
   * tool set it was produced under, so changing the set mid-loop invalidates that thinking.
   * Defaults to "auto".
   */
  toolChoice?: "auto" | "none";
  maxOutputTokens: number;
  signal: AbortSignal;
  /** Internal-only task hints used by adaptive provider adapters such as Bedrock. */
  routing?: ProviderRoutingContext;
}

export type ProviderChunk =
  | { type: "text"; text: string }
  /** Structured tool requests, emitted once before the finish chunk. Only these are ever acted on. */
  | { type: "tool_calls"; calls: ModelToolCall[]; continuation?: unknown }
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

/**
 * Whether the next provider in DASH AI's route may take over after this failure (only ever before any
 * output or tool run). Retryable failures, and this provider refusing the server's own configuration:
 * its credentials (401/403) or the configured model (404), which another provider does not share.
 * Not a request the provider rejected as invalid, too long or against its policies (400/413/422):
 * that is about the request itself, so the person gets a neutral error instead of the same request
 * being shopped to another provider.
 */
export const failoverAllowed = (error: ProviderError): boolean =>
  error.retryable || error.httpStatus === 401 || error.httpStatus === 403 || error.httpStatus === 404;

const EMPTY_USAGE: Usage = { inputTokens: null, outputTokens: null };
export const emptyUsage = (): Usage => ({ ...EMPTY_USAGE });

interface SdkLikeError {
  name?: string;
  status?: number;
  /** Provider error code carried by SDK errors raised from in-stream error events. */
  code?: string | null;
}

/** Maps SDK/network errors to ProviderError without copying provider error text. */
export function toProviderError(displayName: string, err: unknown, signal?: AbortSignal): ProviderError {
  // An aborted request explains whatever the stream threw (SDKs may end silently or throw anything),
  // so the abort reason decides: a timeout is a timeout, anything else is the user's cancel.
  if (signal?.aborted) {
    return signal.reason === "timeout"
      ? new ProviderError("provider_timeout", `${displayName} took too long to respond.`, true)
      : new ProviderError("cancelled", "Generation was stopped.", false);
  }
  if (err instanceof ProviderError) return err;
  const e = (typeof err === "object" && err !== null ? err : {}) as SdkLikeError;
  const name = e.name ?? "";
  if (name === "AbortError" || name === "APIUserAbortError") {
    return new ProviderError("cancelled", "Generation was stopped.", false);
  }
  if (name === "APIConnectionTimeoutError" || name === "TimeoutError") {
    return new ProviderError("provider_timeout", `${displayName} took too long to respond.`, true);
  }
  const status = typeof e.status === "number" ? e.status : undefined;
  if (status === 429 || e.code === "rate_limit_exceeded") {
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
