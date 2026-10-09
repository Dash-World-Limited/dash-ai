import { z } from "zod";

/** Identifier format shared by every resource. UUIDs and similar opaque ids fit. */
export const Id = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, "Invalid id");
export type Id = z.infer<typeof Id>;

export const IsoDateTime = z.iso.datetime({ offset: true });

/**
 * The AI infrastructure providers the backend can talk to. INTERNAL: consumer clients never show
 * them. Production servers omit provider identity from consumer responses (PROVIDER_DETAILS=hidden).
 */
export const ProviderId = z.enum(["openai", "anthropic", "bedrock"]);
export type ProviderId = z.infer<typeof ProviderId>;

/**
 * How a request is routed. Consumer clients send "smart" (DASH AI decides). The explicit values are
 * engineering/diagnostic routes: a server with PROVIDER_DETAILS=hidden treats them as "smart".
 */
export const ModelChoice = z.enum(["smart", "openai", "claude", "compare"]);
export type ModelChoice = z.infer<typeof ModelChoice>;

/** Assistant modes. Each one changes the instructions and suggested prompts. */
export const AssistantMode = z.enum(["general", "business", "writing", "documents", "research"]);
export type AssistantMode = z.infer<typeof AssistantMode>;

export const MessageRole = z.enum(["user", "assistant"]);
export type MessageRole = z.infer<typeof MessageRole>;

export const ErrorCode = z.enum([
  "bad_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "too_many_streams",
  "payload_too_large",
  "unsupported_media_type",
  "provider_not_configured",
  "no_provider_available",
  "provider_error",
  "provider_timeout",
  "document_unreadable",
  "cancelled",
  "internal_error",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ApiError = z.object({
  code: ErrorCode,
  message: z.string(),
  retryable: z.boolean(),
});
export type ApiError = z.infer<typeof ApiError>;

/** Every non-2xx JSON response has this shape. */
export const ErrorResponse = z.object({
  error: ApiError,
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;

/** Hard limits enforced by the API and mirrored by the Android client. */
export const LIMITS = {
  maxMessageChars: 32_000,
  maxHistoryMessages: 60,
  maxHistoryChars: 200_000,
  maxAttachmentsPerMessage: 5,
  maxTitleChars: 120,
  maxDisplayNameChars: 80,
  minPasswordChars: 8,
  maxPasswordChars: 200,
  maxUploadBytes: 10 * 1024 * 1024,
  maxExtractedChars: 200_000,
} as const;
