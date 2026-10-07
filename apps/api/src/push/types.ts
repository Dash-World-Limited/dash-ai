import type { PushPayload, PushPlatform } from "@dash-ai/contracts";

/**
 * A push transport delivers one normalized DASH AI notification to one device. The rest of DASH AI
 * never talks to a vendor SDK: it records notifications, and PushService hands due deliveries to the
 * transport registered for the device's platform (FCM for Android today; Web Push later; a fake one in
 * tests and local development).
 */
export interface PushTransport {
  readonly platform: PushPlatform;
  /** A short internal name for logs and metrics ("fcm", "fake"). Never shown to people. */
  readonly name: string;
  send(target: PushTarget, payload: PushPayload, options: PushSendOptions): Promise<PushSendResult>;
}

export interface PushTarget {
  /** The registration token or endpoint. A delivery credential: never logged. */
  token: string;
}

export interface PushSendOptions {
  /** How long the push service may hold the message for an offline device. */
  ttlSeconds: number;
  signal: AbortSignal;
}

/**
 * How one send ended, normalized across transports. `code` is a short internal label (never vendor
 * error text, never shown to people):
 * - invalid_token: the device can never receive again (uninstalled, token rotated): remove it.
 * - retryable: try again later (rate limited, the push service unavailable, a network error).
 * - permanent: this message will never be accepted (a malformed request, a configuration error).
 */
export type PushSendResult =
  | { ok: true }
  | { ok: false; kind: "invalid_token" | "retryable" | "permanent"; code: string; retryAfterMs?: number };
