import type { ApiError, ErrorCode, ErrorResponse } from "@dash-ai/contracts";
import type { z } from "zod";

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  document_unreadable: 422,
  rate_limited: 429,
  too_many_streams: 429,
  cancelled: 499,
  internal_error: 500,
  provider_error: 502,
  provider_not_configured: 503,
  no_provider_available: 503,
  provider_timeout: 504,
};

const RETRYABLE: ReadonlySet<ErrorCode> = new Set([
  "rate_limited",
  "too_many_streams",
  "internal_error",
  "provider_timeout",
]);

/** An error that is safe to show to the client. Messages must never contain user content. */
export class AppError extends Error {
  readonly statusCode: number;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    readonly code: ErrorCode,
    message: string,
    options: { retryable?: boolean; retryAfterSeconds?: number; statusCode?: number } = {},
  ) {
    super(message);
    this.name = "AppError";
    this.statusCode = options.statusCode ?? STATUS[code];
    this.retryable = options.retryable ?? RETRYABLE.has(code);
    this.retryAfterSeconds = options.retryAfterSeconds;
  }

  toApiError(): ApiError {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }

  toResponse(): ErrorResponse {
    return { error: this.toApiError() };
  }
}

/** A neutral, retryable "try again in a moment" (overload, shutdown, shared state unreachable). */
export const busyError = (): AppError =>
  new AppError("rate_limited", "DASH AI is busy right now. Please try again in a moment.", { statusCode: 503, retryAfterSeconds: 2 });

/** Parses a request part with a zod schema, returning a 400 that lists paths but never echoes input values. */
export function parseOrThrow<S extends z.ZodType>(schema: S, value: unknown, what = "request"): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues
      .slice(0, 5)
      .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
      .join("; ");
    throw new AppError("bad_request", `Invalid ${what}. ${detail}`);
  }
  return result.data;
}
