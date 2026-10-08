import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createVerify, generateKeyPairSync } from "node:crypto";
import {
  Automation,
  AutomationDetailResponse,
  DataExportResponse,
  NotificationListResponse,
  PushDeviceListResponse,
  PushDeviceResponse,
  PushPayload,
  PushPreferences,
  type AuthResponse,
} from "@dash-ai/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { containsProviderName } from "../src/chat/publicSurface.js";
import { ConfigError, configWarnings, loadConfig } from "../src/config.js";
import { FAKE_TRIGGERS } from "../src/providers/fake.js";
import { FakePushTransport } from "../src/push/fake.js";
import { FcmTransport, classifyFcmError, parseServiceAccount } from "../src/push/fcm.js";
import { accountTag, buildPushPayload } from "../src/push/payload.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import type { Store } from "../src/store/store.js";
import { LogCapture, makeApp, register, testConfig, USING_POSTGRES } from "./helpers.js";
import { createTestPgStore } from "./pgTestStore.js";

const at = (iso: string) => Date.parse(iso);
const TOKEN_A = "fcm-token-device-a:APA91bHPRgkFLJu6zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz_aaaaaaaa";
const TOKEN_B = "fcm-token-device-b:APA91bHPRgkFLJu6yyyyyyyyyyyyyyyyyyyyyyyyyyyyyy_bbbbbbbb";
const TOKEN_C = "fcm-token-device-c:APA91bHPRgkFLJu6xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx_cccccccc";
const PROMPT = "Summarise my private medical appointment notes for Tuesday.";

const opened: FastifyInstance[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

type Auth = { authorization: string };

async function setup(options: { env?: Record<string, string>; store?: Store; transport?: FakePushTransport | null; logs?: LogCapture } = {}) {
  const clock = { t: at("2026-10-07T06:00:00Z") };
  const fake = options.transport === null ? null : (options.transport ?? new FakePushTransport());
  const made = await makeApp({
    config: testConfig({ PROVIDER_DETAILS: "hidden", PUSH_RETRY_BASE_MS: "1000", ...(options.logs ? { LOG_LEVEL: "debug" } : {}), ...options.env }),
    store: options.store,
    now: () => new Date(clock.t),
    pushTransports: fake ? [fake] : [],
    logs: options.logs,
  });
  opened.push(made.app);
  const user = await register(made.app);
  return { ...made, clock, user, fake: fake! };
}

async function login(app: FastifyInstance, email: string): Promise<Auth> {
  const res = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password: "correct horse battery" } });
  expect(res.statusCode).toBe(200);
  return { authorization: `Bearer ${(res.json() as AuthResponse).token}` };
}

const registerDevice = (app: FastifyInstance, auth: Auth, token: string, extra: Record<string, unknown> = {}) =>
  app.inject({ method: "PUT", url: "/v1/push/devices/current", headers: auth, payload: { platform: "android", token, appVersion: "0.1.0", ...extra } });

async function createAutomation(app: FastifyInstance, auth: Auth, prompt = PROMPT) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/automations",
    headers: auth,
    payload: { name: "Clinic notes", prompt, mode: "general", schedule: { kind: "daily", time: "08:00" }, timeZone: "Africa/Lagos" },
  });
  expect(res.statusCode).toBe(201);
  return Automation.parse(res.json());
}

type Ctx = Awaited<ReturnType<typeof setup>>["context"];

/** Run now, then wait for the run and the push pass it triggers. */
async function runNow(app: FastifyInstance, context: Ctx, auth: Auth, automationId: string) {
  expect((await app.inject({ method: "POST", url: `/v1/automations/${automationId}/run`, headers: auth })).statusCode).toBe(202);
  await context.automations.idle();
  await context.push.idle();
}

describe("device registration", () => {
  it("registers this session's device without ever returning the token, and refreshes it in place", async () => {
    const { app, user, context } = await setup();
    const res = await registerDevice(app, user.auth, TOKEN_A);
    expect(res.statusCode).toBe(200);
    const { device } = PushDeviceResponse.parse(res.json());
    expect(device).toMatchObject({ platform: "android", appVersion: "0.1.0", current: true });
    expect(res.body).not.toContain(TOKEN_A);

    // Idempotent: the same token again keeps the same registration.
    const again = PushDeviceResponse.parse((await registerDevice(app, user.auth, TOKEN_A, { appVersion: "0.1.1" })).json());
    expect(again.device).toMatchObject({ id: device.id, appVersion: "0.1.1" });

    // Token refresh: the session's new token replaces the old one (one device per session).
    const refreshed = PushDeviceResponse.parse((await registerDevice(app, user.auth, TOKEN_B)).json());
    const stored = await context.store.listPushDevices(user.user.id);
    expect(stored.map((d) => d.token)).toEqual([TOKEN_B]);
    expect(stored[0]!.id).toBe(refreshed.device.id);

    const current = await app.inject({ method: "GET", url: "/v1/push/devices/current", headers: user.auth });
    expect(PushDeviceResponse.parse(current.json()).device.id).toBe(refreshed.device.id);
    expect(current.body).not.toContain(TOKEN_B);
  });

  it("keeps several devices per account (one per signed-in session) and lists them without tokens", async () => {
    const { app, user } = await setup();
    const phone2 = await login(app, user.user.email);
    expect((await registerDevice(app, user.auth, TOKEN_A)).statusCode).toBe(200);
    expect((await registerDevice(app, phone2, TOKEN_B)).statusCode).toBe(200);
    const list = await app.inject({ method: "GET", url: "/v1/push/devices", headers: user.auth });
    const { devices } = PushDeviceListResponse.parse(list.json());
    expect(devices).toHaveLength(2);
    expect(devices.filter((d) => d.current)).toHaveLength(1);
    expect(list.body).not.toContain(TOKEN_A);
    expect(list.body).not.toContain(TOKEN_B);
    expect(list.body).not.toMatch(/token|session/i);
  });

  it("validates input and requires a signed-in session", async () => {
    const { app, user } = await setup();
    expect((await registerDevice(app, user.auth, "short")).statusCode).toBe(400);
    expect((await registerDevice(app, user.auth, "has spaces and <script> in it, which is not a token")).statusCode).toBe(400);
    expect((await registerDevice(app, user.auth, TOKEN_A, { platform: "ios" })).statusCode).toBe(400);
    expect((await registerDevice(app, user.auth, TOKEN_A, { appVersion: "x".repeat(40) })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/v1/push/devices/current", payload: { platform: "android", token: TOKEN_A } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/v1/push/devices" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/v1/push/preferences" })).statusCode).toBe(401);
  });

  it("revokes this device, or one of the account's devices by id", async () => {
    const { app, user, context } = await setup();
    const phone2 = await login(app, user.user.email);
    await registerDevice(app, user.auth, TOKEN_A);
    const other = PushDeviceResponse.parse((await registerDevice(app, phone2, TOKEN_B)).json()).device;
    expect((await app.inject({ method: "DELETE", url: "/v1/push/devices/current", headers: user.auth })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/v1/push/devices/current", headers: user.auth })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/v1/push/devices/${other.id}`, headers: user.auth })).statusCode).toBe(204);
    expect(await context.store.listPushDevices(user.user.id)).toEqual([]);
    expect((await app.inject({ method: "DELETE", url: `/v1/push/devices/${other.id}`, headers: user.auth })).statusCode).toBe(404);
  });
});

describe("account isolation", () => {
  it("a device is always registered for the caller's own account, whatever the body says", async () => {
    const { app, user, context } = await setup();
    const b = await register(app);
    const res = await registerDevice(app, user.auth, TOKEN_A, { userId: b.user.id, sessionHash: "x".repeat(64) });
    expect(res.statusCode).toBe(200);
    expect((await context.store.listPushDevices(user.user.id)).map((d) => d.token)).toEqual([TOKEN_A]);
    expect(await context.store.listPushDevices(b.user.id)).toEqual([]);
  });

  it("nobody can list or remove another account's devices", async () => {
    const { app, user, context } = await setup();
    const b = await register(app);
    const bDevice = PushDeviceResponse.parse((await registerDevice(app, b.auth, TOKEN_B)).json()).device;
    const list = PushDeviceListResponse.parse((await app.inject({ method: "GET", url: "/v1/push/devices", headers: user.auth })).json());
    expect(list.devices).toEqual([]);
    expect((await app.inject({ method: "DELETE", url: `/v1/push/devices/${bDevice.id}`, headers: user.auth })).statusCode).toBe(404);
    expect(await context.store.listPushDevices(b.user.id)).toHaveLength(1);
  });

  it("signing in to another account on the same phone moves the token: the previous account stops reaching it", async () => {
    const { app, user, context, fake } = await setup();
    const b = await register(app);
    await registerDevice(app, user.auth, TOKEN_A);
    const automation = await createAutomation(app, user.auth);
    // Same phone, same token, now registered by account B (A never signed out, e.g. app data kept).
    await registerDevice(app, b.auth, TOKEN_A);
    expect(await context.store.listPushDevices(user.user.id)).toEqual([]);
    expect((await context.store.listPushDevices(b.user.id)).map((d) => d.token)).toEqual([TOKEN_A]);
    await runNow(app, context, user.auth, automation.id);
    expect(fake.attempts).toEqual([]);
  });

  it("nobody can trigger a push with another account's automation or run", async () => {
    const { app, user, context, fake } = await setup();
    const b = await register(app);
    await registerDevice(app, b.auth, TOKEN_B);
    const automation = await createAutomation(app, user.auth);
    // B tries to run, read and regenerate A's automation: all "not found", nothing runs, nothing is pushed.
    expect((await app.inject({ method: "POST", url: `/v1/automations/${automation.id}/run`, headers: b.auth })).statusCode).toBe(404);
    await runNow(app, context, user.auth, automation.id);
    const runId = AutomationDetailResponse.parse((await app.inject({ method: "GET", url: `/v1/automations/${automation.id}`, headers: user.auth })).json()).runs[0]!.id;
    expect((await app.inject({ method: "POST", url: `/v1/automations/${automation.id}/runs/${runId}/regenerate`, headers: b.auth })).statusCode).toBe(404);
    // The ids a push carries do not open the result for anyone else (deep links rely on this check).
    expect((await app.inject({ method: "GET", url: `/v1/automations/${automation.id}/runs/${runId}`, headers: b.auth })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/v1/automations/${automation.id}`, headers: b.auth })).statusCode).toBe(404);
    expect(fake.attempts.map((p) => p.token)).not.toContain(TOKEN_B);
  });
});

describe("Automates pushes", () => {
  it("a finished run pushes a lock-screen-safe notice to each of the owner's devices, once", async () => {
    const { app, user, context, fake } = await setup();
    const phone2 = await login(app, user.user.email);
    await registerDevice(app, user.auth, TOKEN_A);
    await registerDevice(app, phone2, TOKEN_B);
    const automation = await createAutomation(app, user.auth);
    await runNow(app, context, user.auth, automation.id);

    expect(fake.sent.map((p) => p.token).sort()).toEqual([TOKEN_A, TOKEN_B]);
    const notes = NotificationListResponse.parse((await app.inject({ method: "GET", url: "/v1/notifications", headers: user.auth })).json());
    const detail = AutomationDetailResponse.parse((await app.inject({ method: "GET", url: `/v1/automations/${automation.id}`, headers: user.auth })).json());
    for (const push of fake.sent) {
      expect(PushPayload.parse(push.payload)).toEqual({
        v: "1",
        type: "automation.ready",
        notificationId: notes.notifications[0]!.id,
        automationId: automation.id,
        runId: detail.runs[0]!.id,
        account: accountTag(user.user.id),
        title: "DASH AI",
        body: "Your scheduled result is ready.",
        createdAt: notes.notifications[0]!.createdAt,
      });
      const text = JSON.stringify(push.payload);
      // Nothing from the prompt, the result, the automation's name or the AI infrastructure.
      expect(text).not.toContain("medical");
      expect(text).not.toContain("Clinic notes");
      expect(text).not.toContain("Demonstration");
      expect(containsProviderName(text)).toBe(false);
      expect(text).not.toMatch(/model|provider|gpt|claude|gemini|openai|anthropic/i);
      expect(push.ttlSeconds).toBe(86_400);
    }
    // Delivered: nothing is pending, and more passes send nothing again.
    await context.push.tick();
    expect(fake.sent).toHaveLength(2);
    expect((await context.store.listPushDeliveries(user.user.id)).map((d) => [d.status, d.attempts])).toEqual([["sent", 1], ["sent", 1]]);
  });

  it("a failed run pushes the neutral attention notice (no error details)", async () => {
    const { app, user, context, fake } = await setup();
    await registerDevice(app, user.auth, TOKEN_A);
    const automation = await createAutomation(app, user.auth, `Brief ${FAKE_TRIGGERS.error}`);
    await runNow(app, context, user.auth, automation.id);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]!.payload).toMatchObject({ type: "automation.failed", title: "DASH AI", body: "A scheduled task needs your attention." });
    expect(JSON.stringify(fake.sent[0]!.payload)).not.toMatch(/error|couldn't|timeout|provider/i);
  });

  it("scheduled runs push too", async () => {
    const { app, user, context, clock, fake } = await setup();
    await registerDevice(app, user.auth, TOKEN_A);
    await createAutomation(app, user.auth);
    clock.t = at("2026-10-07T07:00:30Z");
    await context.automations.tick();
    await context.automations.idle();
    await context.push.idle();
    expect(fake.sent.map((p) => p.payload.type)).toEqual(["automation.ready"]);
  });

  it("with Automates notifications off nothing is pushed, and automations still run and notify in the app", async () => {
    const { app, user, context, clock, fake } = await setup();
    await registerDevice(app, user.auth, TOKEN_A);
    expect(PushPreferences.parse((await app.inject({ method: "GET", url: "/v1/push/preferences", headers: user.auth })).json())).toEqual({ automates: true, available: true });
    const off = await app.inject({ method: "PUT", url: "/v1/push/preferences", headers: user.auth, payload: { automates: false } });
    expect(PushPreferences.parse(off.json())).toEqual({ automates: false, available: true });
    const automation = await createAutomation(app, user.auth);
    await runNow(app, context, user.auth, automation.id);
    expect(fake.attempts).toEqual([]);
    const detail = AutomationDetailResponse.parse((await app.inject({ method: "GET", url: `/v1/automations/${automation.id}`, headers: user.auth })).json());
    expect(detail.automation.state).toBe("ready");
    expect(NotificationListResponse.parse((await app.inject({ method: "GET", url: "/v1/notifications", headers: user.auth })).json()).unread).toBe(1);

    // Turning it off after a push was queued stops that push too.
    await app.inject({ method: "PUT", url: "/v1/push/preferences", headers: user.auth, payload: { automates: true } });
    fake.script = () => ({ ok: false, kind: "retryable", code: "unavailable" });
    await runNow(app, context, user.auth, automation.id);
    expect(fake.attempts).toHaveLength(1);
    await app.inject({ method: "PUT", url: "/v1/push/preferences", headers: user.auth, payload: { automates: false } });
    fake.script = () => ({ ok: true });
    clock.t += 60_000;
    await context.push.tick();
    expect(fake.sent).toEqual([]);
    expect((await context.store.listPushDeliveries(user.user.id)).map((d) => d.lastError)).toContain("disabled");
  });

  it("without a configured push service, automations and in-app notices work and nothing is queued", async () => {
    const { app, user, context } = await setup({ transport: null });
    await registerDevice(app, user.auth, TOKEN_A);
    expect(PushPreferences.parse((await app.inject({ method: "GET", url: "/v1/push/preferences", headers: user.auth })).json()).available).toBe(false);
    const automation = await createAutomation(app, user.auth);
    await runNow(app, context, user.auth, automation.id);
    expect(AutomationDetailResponse.parse((await app.inject({ method: "GET", url: `/v1/automations/${automation.id}`, headers: user.auth })).json()).automation.state).toBe("ready");
    expect(await context.store.listPushDeliveries(user.user.id)).toEqual([]);
  });
});

describe("delivery, retry and failure", () => {
  it("retries a temporary failure with growing backoff, then sends once", async () => {
    const { app, user, context, clock, fake } = await setup();
    await registerDevice(app, user.auth, TOKEN_A);
    let failures = 2;
    fake.script = () => (failures-- > 0 ? { ok: false, kind: "retryable", code: "unavailable" } : { ok: true });
    const automation = await createAutomation(app, user.auth);
    await runNow(app, context, user.auth, automation.id);
    expect(fake.attempts).toHaveLength(1);
    let [d] = await context.store.listPushDeliveries(user.user.id);
    expect(d).toMatchObject({ status: "pending", attempts: 1, lastError: "unavailable" });
    const firstDelay = Date.parse(d!.nextAttemptAt!) - clock.t;
    expect(firstDelay).toBeGreaterThanOrEqual(800);
    expect(firstDelay).toBeLessThanOrEqual(1_200);

    // Not due yet: nothing is sent.
    await context.push.tick();
    expect(fake.attempts).toHaveLength(1);

    clock.t += 1_500;
    await context.push.tick();
    [d] = await context.store.listPushDeliveries(user.user.id);
    expect(d).toMatchObject({ status: "pending", attempts: 2 });
    const secondDelay = Date.parse(d!.nextAttemptAt!) - clock.t;
    expect(secondDelay).toBeGreaterThanOrEqual(1_600);

    clock.t += 3_000;
    await context.push.tick();
    [d] = await context.store.listPushDeliveries(user.user.id);
    expect(d).toMatchObject({ status: "sent", attempts: 3 });
    expect(fake.sent).toHaveLength(1);
  });

  it("gives up after the attempt limit; the result and the in-app notice stay, and nothing is regenerated", async () => {
    const { app, user, context, clock, fake } = await setup({ env: { PUSH_MAX_ATTEMPTS: "3" } });
    await registerDevice(app, user.auth, TOKEN_A);
    fake.script = () => ({ ok: false, kind: "retryable", code: "unavailable", retryAfterMs: 2_000 });
    const automation = await createAutomation(app, user.auth);
    await runNow(app, context, user.auth, automation.id);
    for (let i = 0; i < 6; i++) {
      clock.t += 60_000;
      await context.push.tick();
    }
    expect(fake.attempts).toHaveLength(3);
    expect(await context.store.listPushDeliveries(user.user.id)).toMatchObject([{ status: "failed", attempts: 3, lastError: "unavailable" }]);
    const detail = AutomationDetailResponse.parse((await app.inject({ method: "GET", url: `/v1/automations/${automation.id}`, headers: user.auth })).json());
    expect(detail.runs.map((r) => r.status)).toEqual(["ready"]);
    expect(NotificationListResponse.parse((await app.inject({ method: "GET", url: "/v1/notifications", headers: user.auth })).json()).unread).toBe(1);
  });

  it("a permanent failure is not retried", async () => {
    const { app, user, context, clock, fake } = await setup();
    await registerDevice(app, user.auth, TOKEN_A);
    fake.script = () => ({ ok: false, kind: "permanent", code: "invalid_argument" });
    await runNow(app, context, user.auth, (await createAutomation(app, user.auth)).id);
    clock.t += 3_600_000;
    await context.push.tick();
    expect(fake.attempts).toHaveLength(1);
    expect(await context.store.listPushDeliveries(user.user.id)).toMatchObject([{ status: "failed", lastError: "invalid_argument" }]);
  });

  it("removes a device whose token the push service reports as unusable", async () => {
    const { app, user, context, fake } = await setup();
    const phone2 = await login(app, user.user.email);
    await registerDevice(app, user.auth, TOKEN_A);
    await registerDevice(app, phone2, TOKEN_B);
    fake.script = (target) => (target.token === TOKEN_A ? { ok: false, kind: "invalid_token", code: "unregistered" } : { ok: true });
    await runNow(app, context, user.auth, (await createAutomation(app, user.auth)).id);
    expect((await context.store.listPushDevices(user.user.id)).map((d) => d.token)).toEqual([TOKEN_B]);
    expect(fake.sent.map((p) => p.token)).toEqual([TOKEN_B]);
  });

  it("a transport that throws counts as a temporary failure and never breaks the run", async () => {
    const { app, user, context, fake } = await setup();
    await registerDevice(app, user.auth, TOKEN_A);
    fake.script = () => {
      throw new Error(`socket hang up for ${TOKEN_A}`);
    };
    const automation = await createAutomation(app, user.auth);
    await runNow(app, context, user.auth, automation.id);
    expect(await context.store.listPushDeliveries(user.user.id)).toMatchObject([{ status: "pending", lastError: "transport_error" }]);
    expect(AutomationDetailResponse.parse((await app.inject({ method: "GET", url: `/v1/automations/${automation.id}`, headers: user.auth })).json()).automation.state).toBe("ready");
  });

  it("does not push a notice the person has already read in the app, or one that is too old", async () => {
    const { app, user, context, clock, fake } = await setup();
    await registerDevice(app, user.auth, TOKEN_A);
    fake.script = () => ({ ok: false, kind: "retryable", code: "unavailable" });
    const automation = await createAutomation(app, user.auth);
    await runNow(app, context, user.auth, automation.id);
    await app.inject({ method: "POST", url: "/v1/notifications/read", headers: user.auth, payload: {} });
    fake.script = () => ({ ok: true });
    clock.t += 60_000;
    await context.push.tick();
    expect(fake.sent).toEqual([]);
    expect((await context.store.listPushDeliveries(user.user.id))[0]).toMatchObject({ status: "failed", lastError: "already_read" });

    fake.script = () => ({ ok: false, kind: "retryable", code: "unavailable" });
    await runNow(app, context, user.auth, automation.id);
    fake.script = () => ({ ok: true });
    clock.t += 2 * 86_400_000;
    await context.push.tick();
    expect(fake.sent).toEqual([]);
    expect((await context.store.listPushDeliveries(user.user.id)).map((d) => d.lastError)).toContain("expired");
  });

  it("a delivery claimed by an instance that then stopped is sent again by another (its lease expired)", async () => {
    const { app, user, context, clock, fake } = await setup({ transport: new FakePushTransport() });
    await registerDevice(app, user.auth, TOKEN_A);
    fake.script = () => ({ ok: false, kind: "retryable", code: "unavailable" });
    await runNow(app, context, user.auth, (await createAutomation(app, user.auth)).id);
    clock.t += 60_000;
    // Another instance claims it and disappears before recording the outcome.
    expect(await context.store.claimPushDeliveries(new Date(clock.t).toISOString(), new Date(clock.t + 1_000).toISOString(), 10)).toHaveLength(1);
    fake.script = () => ({ ok: true });
    await context.push.tick();
    expect(fake.sent).toEqual([]);
    clock.t += 2_000;
    await context.push.tick();
    expect(fake.sent).toHaveLength(1);
  });
});

describe("duplicate protection across instances", () => {
  it("two API instances sharing one database push each finished run once per device", async () => {
    const pg = USING_POSTGRES ? await createTestPgStore() : undefined;
    const store: Store = pg?.store ?? new MemoryStore();
    try {
      const fakeA = new FakePushTransport();
      const fakeB = new FakePushTransport();
      const a = await setup({ store, transport: fakeA });
      const b = await setup({ store, transport: fakeB });
      await registerDevice(a.app, a.user.auth, TOKEN_A);
      const phone2 = await login(a.app, a.user.user.email);
      await registerDevice(b.app, phone2, TOKEN_B);
      const automation = await createAutomation(a.app, a.user.auth);
      a.clock.t = b.clock.t = at("2026-10-07T07:01:00Z");
      // Both schedulers and both push services race for the same occurrence and deliveries.
      await Promise.all([a.context.automations.tick(), b.context.automations.tick()]);
      await Promise.all([a.context.automations.idle(), b.context.automations.idle()]);
      await Promise.all([a.context.push.tick(), b.context.push.tick(), a.context.push.tick(), b.context.push.tick()]);
      await Promise.all([a.context.push.idle(), b.context.push.idle()]);
      const sent = [...fakeA.sent, ...fakeB.sent];
      expect(sent.map((p) => p.token).sort()).toEqual([TOKEN_A, TOKEN_B]);
      expect(new Set(sent.map((p) => p.payload.notificationId)).size).toBe(1);
      expect((await store.listRuns(a.user.user.id, automation.id, 10)).map((r) => r.status)).toEqual(["ready"]);
    } finally {
      for (const app of opened.splice(0)) await app.close();
      await pg?.dispose();
    }
  });
});

describe("sign-out, expiry and account deletion", () => {
  it("signing out removes this device's registration: the account's later results are not pushed to it", async () => {
    const { app, user, context, fake } = await setup();
    const phone2 = await login(app, user.user.email);
    await registerDevice(app, user.auth, TOKEN_A);
    await registerDevice(app, phone2, TOKEN_B);
    expect((await app.inject({ method: "POST", url: "/v1/auth/logout", headers: phone2 })).statusCode).toBe(204);
    expect((await context.store.listPushDevices(user.user.id)).map((d) => d.token)).toEqual([TOKEN_A]);
    await runNow(app, context, user.auth, (await createAutomation(app, user.auth)).id);
    expect(fake.sent.map((p) => p.token)).toEqual([TOKEN_A]);
  });

  it("a push already queued is dropped when its device signs out before it is sent", async () => {
    const { app, user, context, clock, fake } = await setup();
    const phone2 = await login(app, user.user.email);
    await registerDevice(app, phone2, TOKEN_B);
    fake.script = () => ({ ok: false, kind: "retryable", code: "unavailable" });
    await runNow(app, context, user.auth, (await createAutomation(app, user.auth)).id);
    await app.inject({ method: "POST", url: "/v1/auth/logout", headers: phone2 });
    fake.script = () => ({ ok: true });
    clock.t += 60_000;
    await context.push.tick();
    expect(fake.sent).toEqual([]);
    expect(await context.store.listPushDeliveries(user.user.id)).toEqual([]);
  });

  it("signing out everywhere removes every device", async () => {
    const { app, user, context } = await setup();
    const phone2 = await login(app, user.user.email);
    await registerDevice(app, user.auth, TOKEN_A);
    await registerDevice(app, phone2, TOKEN_B);
    expect((await app.inject({ method: "POST", url: "/v1/auth/logout-all", headers: user.auth })).statusCode).toBe(204);
    expect(await context.store.listPushDevices(user.user.id)).toEqual([]);
  });

  it("an expired session's device is not pushed to, and is removed with the session", async () => {
    const { app, user, context, clock, fake } = await setup({ env: { SESSION_TTL_DAYS: "1" } });
    await registerDevice(app, user.auth, TOKEN_A);
    const automation = await createAutomation(app, user.auth);
    const record = (await context.store.getAutomation(user.user.id, automation.id))!;
    clock.t += 2 * 86_400_000;
    // The session has expired; the run happens on the server regardless.
    const { newRun } = await import("../src/automations/service.js");
    await context.store.enqueueRun(newRun(record, "manual", new Date(clock.t)));
    await context.automations.tick();
    await context.automations.idle();
    await context.push.idle();
    expect(fake.attempts).toEqual([]);
    await context.store.purgeExpiredSessions(new Date(clock.t));
    expect(await context.store.listPushDevices(user.user.id)).toEqual([]);
  });

  it("deleting the account removes its devices and deliveries; export never includes tokens", async () => {
    const { app, user, context, fake } = await setup();
    await registerDevice(app, user.auth, TOKEN_A);
    fake.script = () => ({ ok: false, kind: "retryable", code: "unavailable" });
    await runNow(app, context, user.auth, (await createAutomation(app, user.auth)).id);
    const exported = await app.inject({ method: "GET", url: "/v1/me/export", headers: user.auth });
    DataExportResponse.parse(exported.json());
    expect(exported.body).not.toContain(TOKEN_A);
    expect(exported.body).not.toMatch(/pushDevice|push_device/);
    expect((await app.inject({ method: "DELETE", url: "/v1/me", headers: user.auth })).statusCode).toBe(204);
    expect(await context.store.listPushDevices(user.user.id)).toEqual([]);
    expect(await context.store.listPushDeliveries(user.user.id)).toEqual([]);
  });

  it("re-registering after the session ended is refused", async () => {
    const { app, user } = await setup();
    await app.inject({ method: "POST", url: "/v1/auth/logout", headers: user.auth });
    expect((await registerDevice(app, user.auth, TOKEN_A)).statusCode).toBe(401);
  });
});

describe("logs", () => {
  it("never contain a push token, even when sends fail", async () => {
    const logs = new LogCapture();
    const { app, user, context, clock, fake } = await setup({ logs });
    const phone2 = await login(app, user.user.email);
    await registerDevice(app, user.auth, TOKEN_A);
    await registerDevice(app, phone2, TOKEN_C);
    fake.script = (t) => (t.token === TOKEN_A ? { ok: false, kind: "retryable", code: "unavailable" } : { ok: false, kind: "invalid_token", code: "unregistered" });
    await runNow(app, context, user.auth, (await createAutomation(app, user.auth)).id);
    clock.t += 3_600_000;
    await context.push.tick();
    expect(logs.text).toContain("push device registered");
    expect(logs.text).toContain("push device removed");
    for (const token of [TOKEN_A, TOKEN_C]) {
      expect(logs.text).not.toContain(token);
      expect(logs.text).not.toContain(token.slice(0, 24));
    }
    expect(logs.text).not.toContain("medical");
  });
});

describe.runIf(USING_POSTGRES)("push tokens at rest (PostgreSQL)", () => {
  it("are stored only as ciphertext plus a hash", async () => {
    const pg = await createTestPgStore();
    try {
      const { app, user } = await setup({ store: pg.store });
      await registerDevice(app, user.auth, TOKEN_A);
      const { rows } = await pg.store.pool.query<{ token_enc: Buffer; token_hash: string }>("SELECT token_enc, token_hash FROM push_devices");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.token_enc.toString("latin1")).not.toContain(TOKEN_A.slice(0, 20));
      expect(rows[0]!.token_hash).toMatch(/^[a-f0-9]{64}$/);
      const dump = JSON.stringify((await pg.store.pool.query("SELECT * FROM push_devices")).rows);
      expect(dump).not.toContain(TOKEN_A.slice(0, 20));
    } finally {
      for (const app of opened.splice(0)) await app.close();
      await pg.dispose();
    }
  });
});

describe("payload and configuration", () => {
  it("builds payloads only from fixed text and ids", () => {
    const payload = buildPushPayload({
      id: "note-0001", userId: "user-0001", kind: "automation.failed", automationId: "auto-0001", runId: "run-00001",
      createdAt: "2026-10-07T07:00:00.000Z", readAt: null,
    });
    expect(PushPayload.parse(payload)).toMatchObject({ title: "DASH AI", body: "A scheduled task needs your attention.", account: accountTag("user-0001") });
    expect(accountTag("user-0001")).not.toBe(accountTag("user-0002"));
    expect(accountTag("user-0001")).not.toContain("user");
  });

  it("requires a valid service account for FCM, and warns about the fake transport in production", () => {
    expect(() => loadConfig({ PUSH_TRANSPORT: "fcm" })).toThrow(ConfigError);
    expect(() => loadConfig({ PUSH_TRANSPORT: "fcm", FCM_SERVICE_ACCOUNT: "bm90IGpzb24=" })).toThrow(/FCM_SERVICE_ACCOUNT/);
    expect(() => loadConfig({ PUSH_TRANSPORT: "fcm", FCM_SERVICE_ACCOUNT: '{"project_id":"p"}' })).toThrow(/missing/);
    const ok = loadConfig({ PUSH_TRANSPORT: "fcm", FCM_SERVICE_ACCOUNT: Buffer.from(JSON.stringify(serviceAccount())).toString("base64") });
    expect(ok.push.fcm).toMatchObject({ projectId: "dash-test", clientEmail: "push@dash-test.iam.gserviceaccount.com" });
    expect(loadConfig({}).push.transport).toBe("none");
    expect(configWarnings(loadConfig({ NODE_ENV: "production", PROVIDER_MODE: "fake", DATABASE_URL: "postgres://x", RATE_LIMIT_BACKEND: "redis", REDIS_URL: "rediss://x", PUSH_TRANSPORT: "fake" })).join(" ")).toMatch(/PUSH_TRANSPORT=fake/);
  });
});

// ---- FCM HTTP v1 transport against a local stand-in for Google --------------------------------

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
function serviceAccount(tokenUri = "https://oauth2.googleapis.com/token") {
  return {
    type: "service_account",
    project_id: "dash-test",
    client_email: "push@dash-test.iam.gserviceaccount.com",
    private_key: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    token_uri: tokenUri,
  };
}

async function body(req: IncomingMessage): Promise<string> {
  let s = "";
  for await (const c of req) s += c;
  return s;
}

describe("FCM transport", () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  async function fakeGoogle(send: (status: { n: number }) => { status: number; body?: unknown; headers?: Record<string, string> }) {
    const seen = { tokenRequests: [] as string[], sends: [] as Array<{ auth: string; body: unknown; path: string }>, n: 0 };
    server = createServer((req, res) => {
      void (async () => {
        const text = await body(req);
        if (req.url === "/token") {
          seen.tokenRequests.push(text);
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: "ya29.test-access", expires_in: 3600 }));
          return;
        }
        seen.n += 1;
        seen.sends.push({ auth: String(req.headers.authorization), body: JSON.parse(text), path: req.url ?? "" });
        const r = send({ n: seen.n });
        res.writeHead(r.status, { "content-type": "application/json", ...r.headers }).end(JSON.stringify(r.body ?? {}));
      })();
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    const transport = new FcmTransport({ account: parseServiceAccount(JSON.stringify(serviceAccount(`${base}/token`))), sendBaseUrl: base });
    return { seen, transport };
  }

  const payload = buildPushPayload({
    id: "note-0001", userId: "user-0001", kind: "automation.ready", automationId: "auto-0001", runId: "run-00001",
    createdAt: "2026-10-07T07:00:00.000Z", readAt: null,
  });
  const opts = () => ({ ttlSeconds: 86_400, signal: AbortSignal.timeout(5_000) });

  it("signs a service-account JWT, caches the access token, and sends a data-only high-priority message", async () => {
    const { seen, transport } = await fakeGoogle(() => ({ status: 200, body: { name: "projects/dash-test/messages/1" } }));
    expect(await transport.send({ token: TOKEN_A }, payload, opts())).toEqual({ ok: true });
    expect(await transport.send({ token: TOKEN_B }, payload, opts())).toEqual({ ok: true });
    expect(seen.tokenRequests).toHaveLength(1);
    const form = new URLSearchParams(seen.tokenRequests[0]);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [h, c, sig] = form.get("assertion")!.split(".");
    const claims = JSON.parse(Buffer.from(c!, "base64url").toString()) as Record<string, unknown>;
    expect(claims).toMatchObject({ iss: "push@dash-test.iam.gserviceaccount.com", scope: "https://www.googleapis.com/auth/firebase.messaging" });
    expect(createVerify("RSA-SHA256").update(`${h}.${c}`).verify(keys.publicKey, Buffer.from(sig!, "base64url"))).toBe(true);

    expect(seen.sends[0]!.path).toBe("/v1/projects/dash-test/messages:send");
    expect(seen.sends[0]!.auth).toBe("Bearer ya29.test-access");
    const message = (seen.sends[0]!.body as { message: Record<string, unknown> }).message;
    expect(message).toEqual({
      token: TOKEN_A,
      data: payload,
      android: { priority: "high", ttl: "86400s", collapse_key: payload.notificationId },
    });
    // Data-only: no "notification" block, so the app decides what (and whether) to show.
    expect(message).not.toHaveProperty("notification");
  });

  it("maps FCM errors to normalized outcomes", async () => {
    const replies = [
      { status: 404, body: { error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } } },
      { status: 429, body: { error: { status: "RESOURCE_EXHAUSTED", details: [{ errorCode: "QUOTA_EXCEEDED" }] } }, headers: { "retry-after": "30" } },
      { status: 503, body: { error: { status: "UNAVAILABLE" } } },
      { status: 400, body: { error: { status: "INVALID_ARGUMENT", details: [{ errorCode: "INVALID_ARGUMENT" }] } } },
      { status: 403, body: { error: { status: "PERMISSION_DENIED", details: [{ errorCode: "SENDER_ID_MISMATCH" }] } } },
    ];
    const { transport } = await fakeGoogle(({ n }) => replies[n - 1]!);
    expect(await transport.send({ token: TOKEN_A }, payload, opts())).toEqual({ ok: false, kind: "invalid_token", code: "unregistered" });
    expect(await transport.send({ token: TOKEN_A }, payload, opts())).toEqual({ ok: false, kind: "retryable", code: "quota_exceeded", retryAfterMs: 30_000 });
    expect(await transport.send({ token: TOKEN_A }, payload, opts())).toMatchObject({ ok: false, kind: "retryable" });
    expect(await transport.send({ token: TOKEN_A }, payload, opts())).toEqual({ ok: false, kind: "permanent", code: "invalid_argument" });
    expect(await transport.send({ token: TOKEN_A }, payload, opts())).toMatchObject({ ok: false, kind: "invalid_token" });
    expect(classifyFcmError(500, null, null)).toMatchObject({ kind: "retryable", code: "http_500" });
  });

  it("an unreachable push service is a temporary failure", async () => {
    const transport = new FcmTransport({ account: parseServiceAccount(JSON.stringify(serviceAccount("http://127.0.0.1:9/token"))), sendBaseUrl: "http://127.0.0.1:9" });
    expect(await transport.send({ token: TOKEN_A }, payload, opts())).toMatchObject({ ok: false, kind: "retryable" });
  });
});
