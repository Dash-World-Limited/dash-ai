import {
  Id,
  RegisterPushDeviceRequest,
  UpdatePushPreferencesRequest,
  type PushDevice,
  type PushDeviceListResponse,
  type PushDeviceResponse,
  type PushPreferences,
} from "@dash-ai/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { currentUser } from "../auth/requireAuth.js";
import { AppError, parseOrThrow } from "../errors.js";
import { newId } from "../security/crypto.js";
import type { PushDeviceRecord } from "../store/store.js";
import type { RouteContext } from "./context.js";

const Params = z.object({ id: Id });

/** What an owner sees about a device: never the token, never the session. */
const toDevice = (d: PushDeviceRecord, currentSession: string | null): PushDevice => ({
  id: d.id,
  platform: d.platform,
  appVersion: d.appVersion,
  current: d.sessionHash === currentSession,
  createdAt: d.createdAt,
  updatedAt: d.updatedAt,
});

/**
 * Push registration and preferences. A device is registered by, and for, the signed-in session making
 * the request: no user id or session is ever taken from the body, so nobody can register a device for
 * another account, and signing out removes it.
 */
export function pushRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const auth = { preHandler: ctx.requireAuth };
  const session = (request: FastifyRequest): string => {
    if (!request.authTokenHash) throw new AppError("unauthorized", "Sign in to continue.");
    return request.authTokenHash;
  };

  /** Registers this device for the signed-in account, or refreshes its token (idempotent). */
  app.put("/v1/push/devices/current", auth, async (request: FastifyRequest): Promise<PushDeviceResponse> => {
    const user = currentUser(request);
    const body = parseOrThrow(RegisterPushDeviceRequest, request.body);
    const sessionHash = session(request);
    const device = await ctx.store.upsertPushDevice({
      id: newId(),
      userId: user.id,
      sessionHash,
      platform: body.platform,
      token: body.token,
      appVersion: body.appVersion || null,
      now: ctx.now().toISOString(),
    });
    if (!device) throw new AppError("unauthorized", "Your session has ended. Sign in again.");
    // The device id only: never the token.
    request.log.info({ event: "push_device_registered", pushDevice: device.id, platform: device.platform }, "push device registered");
    return { device: toDevice(device, sessionHash) };
  });

  /** This session's device, if it registered one. */
  app.get("/v1/push/devices/current", auth, async (request: FastifyRequest): Promise<PushDeviceResponse> => {
    const sessionHash = session(request);
    const device = await ctx.store.getPushDeviceForSession(sessionHash);
    if (!device) throw new AppError("not_found", "This device is not registered for notifications.");
    return { device: toDevice(device, sessionHash) };
  });

  /** Stops pushes to this device (notifications turned off on the phone, or before signing out). */
  app.delete("/v1/push/devices/current", auth, async (request: FastifyRequest, reply: FastifyReply) => {
    await ctx.store.deletePushDeviceForSession(session(request));
    reply.code(204);
  });

  app.get("/v1/push/devices", auth, async (request: FastifyRequest): Promise<PushDeviceListResponse> => {
    const devices = await ctx.store.listPushDevices(currentUser(request).id);
    return { devices: devices.map((d) => toDevice(d, request.authTokenHash)) };
  });

  /** Removes one of the account's devices (for example a lost phone). Another account's id is "not found". */
  app.delete("/v1/push/devices/:id", auth, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = parseOrThrow(Params, request.params, "device id");
    if (!(await ctx.store.deletePushDevice(currentUser(request).id, id))) throw new AppError("not_found", "Device not found.");
    reply.code(204);
  });

  app.get("/v1/push/preferences", auth, async (request: FastifyRequest): Promise<PushPreferences> => {
    const prefs = await ctx.store.getPushPreferences(currentUser(request).id);
    return { automates: prefs.automates, available: ctx.push.available };
  });

  /** Automates notifications on or off for the account. Automations keep running either way. */
  app.put("/v1/push/preferences", auth, async (request: FastifyRequest): Promise<PushPreferences> => {
    const userId = currentUser(request).id;
    const body = parseOrThrow(UpdatePushPreferencesRequest, request.body);
    await ctx.store.setPushPreferences(userId, { automates: body.automates });
    return { automates: body.automates, available: ctx.push.available };
  });
}
