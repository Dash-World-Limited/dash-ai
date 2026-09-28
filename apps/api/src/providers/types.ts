import type { FinishReason, ProviderId, Usage } from "@dash-ai/contracts";

export interface ProviderMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ProviderRequest {
  system: string;
  messages: ProviderMessage[];
  maxOutputTokens: number;
  signal: AbortSignal;
}

export type ProviderChunk =
  | { type: "text"; text: string }
  | { type: "finish"; finishReason: Exclude<FinishReason, "cancelled">; usage: Usage };

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
