import { createSign } from "node:crypto";
import type { PushPayload } from "@dash-ai/contracts";
import type { PushSendOptions, PushSendResult, PushTarget, PushTransport } from "./types.js";

/** The parts of a Google service-account key file FCM needs. Secret: it contains a private key. */
export interface FcmServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
}

export class FcmConfigError extends Error {}

/**
 * Reads FCM_SERVICE_ACCOUNT: the service-account JSON key file, raw or base64-encoded. Errors never
 * quote the value.
 */
export function parseServiceAccount(raw: string): FcmServiceAccount {
  const text = raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new FcmConfigError("FCM_SERVICE_ACCOUNT is not a service-account JSON key (raw or base64).");
  }
  const str = (k: string) => (typeof json[k] === "string" && (json[k] as string).length > 0 ? (json[k] as string) : undefined);
  const projectId = str("project_id");
  const clientEmail = str("client_email");
  const privateKey = str("private_key");
  if (!projectId || !clientEmail || !privateKey) {
    throw new FcmConfigError("FCM_SERVICE_ACCOUNT is missing project_id, client_email or private_key.");
  }
  return { projectId, clientEmail, privateKey, tokenUri: str("token_uri") ?? "https://oauth2.googleapis.com/token" };
}

const b64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");

export interface FcmOptions {
  account: FcmServiceAccount;
  /** Overridable for tests (a local server standing in for Google). */
  fetch?: typeof fetch;
  sendBaseUrl?: string;
  now?: () => number;
}

/**
 * Android push through Firebase Cloud Messaging (HTTP v1 API), without a vendor SDK: an OAuth access
 * token is minted from the service account (a signed JWT, cached until shortly before it expires) and
 * each delivery is one data-only message, so the app decides what to show (and whether the push is for
 * the account signed in). FCM never sees result text: only the fixed title and body and ids.
 */
export class FcmTransport implements PushTransport {
  readonly platform = "android" as const;
  readonly name = "fcm";
  private accessToken: { value: string; expiresAt: number } | null = null;
  private readonly fetchFn: typeof fetch;
  private readonly sendUrl: string;
  private readonly now: () => number;

  constructor(private readonly options: FcmOptions) {
    this.fetchFn = options.fetch ?? fetch;
    this.sendUrl = `${options.sendBaseUrl ?? "https://fcm.googleapis.com"}/v1/projects/${encodeURIComponent(options.account.projectId)}/messages:send`;
    this.now = options.now ?? Date.now;
  }

  private assertion(): string {
    const { account } = this.options;
    const iat = Math.floor(this.now() / 1000);
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64url(
      JSON.stringify({
        iss: account.clientEmail,
        scope: "https://www.googleapis.com/auth/firebase.messaging",
        aud: account.tokenUri,
        iat,
        exp: iat + 3600,
      }),
    );
    const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(account.privateKey);
    return `${header}.${claims}.${b64url(signature)}`;
  }

  private async token(signal: AbortSignal): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt - 300_000 > this.now()) return this.accessToken.value;
    const res = await this.fetchFn(this.options.account.tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: this.assertion() }).toString(),
      signal,
    });
    if (!res.ok) throw new FcmAuthError(res.status);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new FcmAuthError(res.status);
    this.accessToken = { value: body.access_token, expiresAt: this.now() + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }

  async send(target: PushTarget, payload: PushPayload, options: PushSendOptions): Promise<PushSendResult> {
    let access: string;
    try {
      access = await this.token(options.signal);
    } catch (err) {
      // The credential itself was refused: no attempt will work until configuration changes, but it may be
      // a transient outage of the token endpoint, so it is retried within the usual bound.
      return { ok: false, kind: "retryable", code: err instanceof FcmAuthError ? `auth_${err.status}` : "network" };
    }
    let res: Response;
    try {
      res = await this.fetchFn(this.sendUrl, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${access}` },
        body: JSON.stringify({
          message: {
            token: target.token,
            data: { ...payload },
            android: {
              priority: "high",
              ttl: `${options.ttlSeconds}s`,
              // A retried send replaces, rather than adds to, an undelivered one.
              collapse_key: payload.notificationId,
            },
          },
        }),
        signal: options.signal,
      });
    } catch {
      return { ok: false, kind: "retryable", code: "network" };
    }
    if (res.ok) return { ok: true };
    // A refused access token is minted again on the next attempt.
    if (res.status === 401) this.accessToken = null;
    return classifyFcmError(res.status, await res.json().catch(() => null), res.headers.get("retry-after"));
  }
}

class FcmAuthError extends Error {
  constructor(readonly status: number) {
    super(`FCM credential refused (HTTP ${status})`);
  }
}

/** Maps an FCM HTTP v1 error to the normalized outcome (https://firebase.google.com/docs/reference/fcm/rest/v1/ErrorCode). */
export function classifyFcmError(status: number, body: unknown, retryAfter: string | null): PushSendResult {
  const details = (body as { error?: { status?: string; details?: Array<{ errorCode?: string }> } } | null)?.error;
  const fcmCode = details?.details?.find((d) => typeof d.errorCode === "string")?.errorCode ?? details?.status ?? `http_${status}`;
  const seconds = retryAfter !== null && /^\d+$/.test(retryAfter) ? Number(retryAfter) : undefined;
  const code = String(fcmCode).toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 40);
  // The app was uninstalled or the token rotated, or the token belongs to another Firebase project.
  if (fcmCode === "UNREGISTERED" || fcmCode === "SENDER_ID_MISMATCH" || status === 404) return { ok: false, kind: "invalid_token", code };
  if (status === 429 || fcmCode === "QUOTA_EXCEEDED") {
    return { ok: false, kind: "retryable", code, ...(seconds !== undefined ? { retryAfterMs: seconds * 1000 } : {}) };
  }
  if (status >= 500 || fcmCode === "UNAVAILABLE" || fcmCode === "INTERNAL" || status === 401 || fcmCode === "THIRD_PARTY_AUTH_ERROR") {
    return { ok: false, kind: "retryable", code, ...(seconds !== undefined ? { retryAfterMs: seconds * 1000 } : {}) };
  }
  return { ok: false, kind: "permanent", code };
}
