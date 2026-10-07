import { z } from "zod";
import { Id, IsoDateTime } from "./common.js";
import { NotificationKind } from "./automations.js";

/**
 * Push notifications for DASH Automates. Push is a delivery convenience: automations run and their
 * results and in-app notices are stored whether or not a device can be reached.
 *
 * A device registration belongs to the signed-in session that made it. Signing out (this device or
 * everywhere), the session expiring and deleting the account all remove it on the server, so a device
 * never keeps receiving the previous account's notices. Push tokens are delivery credentials: they are
 * accepted here and never returned by any API.
 */

/** Platforms DASH AI can push to. Web Push is planned (docs/push-notifications.md). */
export const PushPlatform = z.enum(["android"]);
export type PushPlatform = z.infer<typeof PushPlatform>;

export const PUSH_LIMITS = {
  /** FCM registration tokens are ~160–200 characters; this leaves room without accepting junk. */
  maxTokenChars: 4096,
  maxAppVersionChars: 32,
} as const;

/** Registers (or refreshes) this session's device. Replaces any token the session registered before. */
export const RegisterPushDeviceRequest = z.object({
  platform: PushPlatform,
  token: z.string().trim().min(16).max(PUSH_LIMITS.maxTokenChars).regex(/^[A-Za-z0-9_:\-.]+$/, "Invalid push token"),
  appVersion: z
    .string()
    .trim()
    .max(PUSH_LIMITS.maxAppVersionChars)
    .regex(/^[A-Za-z0-9._+-]*$/, "Invalid app version")
    .optional(),
});
export type RegisterPushDeviceRequest = z.infer<typeof RegisterPushDeviceRequest>;

/** A registered device as its owner sees it. Never includes the push token. */
export const PushDevice = z.object({
  id: Id,
  platform: PushPlatform,
  appVersion: z.string().nullable(),
  /** True for the device registered by the session making this request. */
  current: z.boolean(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type PushDevice = z.infer<typeof PushDevice>;

export const PushDeviceResponse = z.object({ device: PushDevice });
export type PushDeviceResponse = z.infer<typeof PushDeviceResponse>;

export const PushDeviceListResponse = z.object({ devices: z.array(PushDevice) });
export type PushDeviceListResponse = z.infer<typeof PushDeviceListResponse>;

/** The account's push choices. `available` is false when this server has no push delivery configured. */
export const PushPreferences = z.object({
  /** Automates results and failures. Automations run either way. */
  automates: z.boolean(),
  available: z.boolean(),
});
export type PushPreferences = z.infer<typeof PushPreferences>;

export const UpdatePushPreferencesRequest = z.object({ automates: z.boolean() });
export type UpdatePushPreferencesRequest = z.infer<typeof UpdatePushPreferencesRequest>;

/**
 * The data a push carries (all string values, as FCM data messages require). Lock-screen safe: a fixed
 * title and body by event type, ids to open the right screen, and nothing from the prompt, the result
 * or the AI infrastructure. The app still loads the result through the normal, owner-checked API.
 */
export const PushPayload = z.object({
  /** Payload format version. */
  v: z.literal("1"),
  type: NotificationKind,
  /** The in-app notification id: also the device's de-duplication key. */
  notificationId: Id,
  automationId: Id,
  runId: Id,
  /** A short hash of the recipient account id, so a device signed in to another account drops it. */
  account: z.string().regex(/^[a-f0-9]{16}$/),
  title: z.string(),
  body: z.string(),
  createdAt: IsoDateTime,
});
export type PushPayload = z.infer<typeof PushPayload>;

/** The words people see. Fixed by event type: never the automation's name, prompt or result. */
export const PUSH_TEXT: Record<NotificationKind, { title: string; body: string }> = {
  "automation.ready": { title: "DASH AI", body: "Your scheduled result is ready." },
  "automation.failed": { title: "DASH AI", body: "A scheduled task needs your attention." },
};
