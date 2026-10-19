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
      /** Input tokens served from the provider's prompt cache, when it reports them (internal accounting). */
      cachedInputTokens?: number | null;
      /** The provider's own cost for the request in USD, when its API returns one (internal accounting). */
      providerCostUsd?: number | null;
    };

/** One AI provider behind a common streaming interface. */
export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly model: string;
  /** True for fake adapters. Their output must always be labelled as a demonstration. */
  readonly demo: boolean;
  stream(request: ProviderRequest): AsyncIterable<ProviderChunk>;
  /**
   * The most output tokens this adapter ever asks `model` for, when the adapter lowers
   * maxOutputTokens to a known model limit (undefined: it sends maxOutputTokens unchanged). Spend
   * limits reserve this instead of MAX_OUTPUT_TOKENS, so it must never be below what is sent.
   */
  outputTokenCap?(model: string): number | undefined;
}

export type ProviderErrorCode = "provider_error" | "provider_timeout" | "rate_limited" | "cancelled";

/** A provider failure with a user-safe message (never includes prompt or provider response text). */
export class ProviderError extends Error {
  /** How long the provider asked callers to wait (Retry-After), when it said so. */
  readonly retryAfterMs: number | undefined;
  /** The provider reported its quota or balance for this account as used up (not a momentary rate limit). */
  readonly quotaExhausted: boolean;

  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly httpStatus?: number,
    signals: { retryAfterMs?: number; quotaExhausted?: boolean } = {},
  ) {
    super(message);
    this.name = "ProviderError";
    this.retryAfterMs = signals.retryAfterMs;
    this.quotaExhausted = signals.quotaExhausted ?? false;
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
  error.retryable || error.quotaExhausted || error.httpStatus === 401 || error.httpStatus === 403 || error.httpStatus === 404;

const EMPTY_USAGE: Usage = { inputTokens: null, outputTokens: null };
export const emptyUsage = (): Usage => ({ ...EMPTY_USAGE });

interface SdkLikeError {
  name?: string;
  status?: number;
  /** Provider error code carried by SDK errors raised from in-stream error events. */
  code?: string | null;
  /** Response headers (SDK API errors carry them). */
  headers?: unknown;
  /** Provider error body (SDK API errors carry the parsed body; only its type/code are read). */
  error?: unknown;
}

const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

/** Retry-After (seconds or an HTTP date) or retry-after-ms from SDK error headers, bounded. */
export function retryAfterFrom(headers: unknown, now: number = Date.now()): number | undefined {
  const get = (name: string): string | null => {
    if (!headers || typeof headers !== "object") return null;
    if (typeof (headers as { get?: unknown }).get === "function") return (headers as Headers).get(name);
    const value = (headers as Record<string, unknown>)[name];
    return typeof value === "string" ? value : null;
  };
  const ms = Number(get("retry-after-ms"));
  if (Number.isFinite(ms) && ms > 0) return Math.min(ms, MAX_RETRY_AFTER_MS);
  const raw = get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  const date = Date.parse(raw);
  return Number.isFinite(date) && date > now ? Math.min(date - now, MAX_RETRY_AFTER_MS) : undefined;
}

/** Provider codes that mean "this account's quota or balance is used up", not a momentary rate limit. */
const QUOTA_CODES = /^(insufficient_quota|quota_exceeded|billing_hard_limit_reached|credit_balance_too_low|out_of_credits)$/;

function errorCode(e: SdkLikeError): string | null {
  if (typeof e.code === "string") return e.code;
  const body = e.error as { code?: unknown; type?: unknown; error?: { code?: unknown; type?: unknown } } | undefined;
  const candidates = [body?.code, body?.type, body?.error?.code, body?.error?.type];
  const found = candidates.find((c): c is string => typeof c === "string");
  return found ?? null;
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
  // The OpenAI and Anthropic SDKs leave `name` as "Error" on their error classes: read the class too.
  const names = [e.name ?? "", (err as { constructor?: { name?: string } } | null)?.constructor?.name ?? ""];
  if (names.some((n) => n === "AbortError" || n === "APIUserAbortError")) {
    return new ProviderError("cancelled", "Generation was stopped.", false);
  }
  if (names.some((n) => n === "APIConnectionTimeoutError" || n === "TimeoutError")) {
    return new ProviderError("provider_timeout", `${displayName} took too long to respond.`, true);
  }
  const status = typeof e.status === "number" ? e.status : undefined;
  const code = errorCode(e);
  const retryAfterMs = retryAfterFrom(e.headers);
  if (code !== null && QUOTA_CODES.test(code)) {
    // Retrying the same provider cannot help; another provider may take over (failoverAllowed).
    return new ProviderError("rate_limited", `${displayName} reported this account's quota as used up.`, false, status, { retryAfterMs, quotaExhausted: true });
  }
  if (status === 429 || code === "rate_limit_exceeded") {
    return new ProviderError("rate_limited", `${displayName} is receiving too many requests. Try again shortly.`, true, status, { retryAfterMs });
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
    return new ProviderError("provider_error", `${displayName} is temporarily unavailable. Try again.`, true, status, { retryAfterMs });
  }
  return new ProviderError("provider_error", `Could not reach ${displayName}. Try again.`, true, status);
}
