import { createHash } from "node:crypto";
import { PUSH_TEXT, type PushPayload } from "@dash-ai/contracts";
import type { NotificationRecord } from "../store/store.js";

/**
 * A short, one-way tag of the recipient account. The device compares it with the account it is signed
 * in to and drops anything else (a push already in flight when the phone switched accounts).
 */
export function accountTag(userId: string): string {
  return createHash("sha256").update(`dash-ai:push-account:${userId}`).digest("hex").slice(0, 16);
}

/**
 * The only way a push payload is built. Lock-screen safe by construction: the title and body are
 * fixed by event type, and the rest is ids. The automation's name, prompt and result, error details
 * and anything about the AI infrastructure never enter a push.
 */
export function buildPushPayload(n: NotificationRecord): PushPayload {
  const text = PUSH_TEXT[n.kind];
  return {
    v: "1",
    type: n.kind,
    notificationId: n.id,
    automationId: n.automationId,
    runId: n.runId,
    account: accountTag(n.userId),
    title: text.title,
    body: text.body,
    createdAt: n.createdAt,
  };
}
