import {
  Automation,
  AutomationDetailResponse,
  AutomationRunResponse,
  DataExportResponse,
  NotificationListResponse,
  type AutomationSchedule,
} from "@dash-ai/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { isValidTimeZone, nextRunAfter, zonedTimeToInstant } from "../src/automations/schedule.js";
import { newRun, previewOf } from "../src/automations/service.js";
import { containsProviderName } from "../src/chat/publicSurface.js";
import { FAKE_TRIGGERS } from "../src/providers/fake.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { toProviderError, type ProviderAdapter, type ProviderChunk, type ProviderRequest } from "../src/providers/types.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import type { Store } from "../src/store/store.js";
import { makeApp, register, testConfig, USING_POSTGRES } from "./helpers.js";
import { createTestPgStore } from "./pgTestStore.js";

const at = (iso: string) => Date.parse(iso);
const next = (schedule: AutomationSchedule, tz: string, after: string) => {
  const t = nextRunAfter(schedule, tz, at(after));
  return t === null ? null : new Date(t).toISOString();
};

describe("schedules are computed in the automation's own time zone", () => {
  it("daily, including the exact boundary", () => {
    // Africa/Lagos is UTC+1 all year.
    expect(next({ kind: "daily", time: "08:00" }, "Africa/Lagos", "2026-10-07T06:00:00Z")).toBe("2026-10-07T07:00:00.000Z");
    expect(next({ kind: "daily", time: "08:00" }, "Africa/Lagos", "2026-10-07T07:00:00Z")).toBe("2026-10-08T07:00:00.000Z");
    // Half-hour offsets.
    expect(next({ kind: "daily", time: "09:00" }, "Asia/Kolkata", "2026-10-07T00:00:00Z")).toBe("2026-10-07T03:30:00.000Z");
  });

  it("keeps the local hour across daylight-saving changes", () => {
    // New York springs forward on 2026-03-08: 08:00 is 13:00Z before and 12:00Z after.
    expect(next({ kind: "daily", time: "08:00" }, "America/New_York", "2026-03-07T00:00:00Z")).toBe("2026-03-07T13:00:00.000Z");
    expect(next({ kind: "daily", time: "08:00" }, "America/New_York", "2026-03-08T14:00:00Z")).toBe("2026-03-09T12:00:00.000Z");
    // London: 09:00 is 09:00Z in winter and 08:00Z in summer.
    expect(next({ kind: "daily", time: "09:00" }, "Europe/London", "2026-03-28T12:00:00Z")).toBe("2026-03-29T08:00:00.000Z");
  });

  it("runs a non-existent local time just after the gap, and a repeated one once (the first)", () => {
    // 02:30 does not exist in New York on 2026-03-08 (02:00 → 03:00): it runs at 03:30 EDT.
    expect(next({ kind: "daily", time: "02:30" }, "America/New_York", "2026-03-08T05:00:00Z")).toBe("2026-03-08T07:30:00.000Z");
    // 01:30 happens twice on 2026-11-01 (EDT then EST): the first one, 05:30Z.
    expect(next({ kind: "daily", time: "01:30" }, "America/New_York", "2026-11-01T04:00:00Z")).toBe("2026-11-01T05:30:00.000Z");
    // ...and the next run is the following day, not the repeated hour.
    expect(next({ kind: "daily", time: "01:30" }, "America/New_York", "2026-11-01T05:30:00Z")).toBe("2026-11-02T06:30:00.000Z");
  });

  it("weekly on chosen days and monthly with short months", () => {
    // Friday 2026-10-09 10:00 Lagos → next weekday is Monday the 12th.
    expect(next({ kind: "weekly", days: [1, 2, 3, 4, 5], time: "08:00" }, "Africa/Lagos", "2026-10-09T09:00:00Z")).toBe("2026-10-12T07:00:00.000Z");
    expect(next({ kind: "weekly", days: [0], time: "18:30" }, "UTC", "2026-10-07T00:00:00Z")).toBe("2026-10-11T18:30:00.000Z");
    expect(next({ kind: "monthly", day: 31, time: "07:00" }, "UTC", "2027-02-01T00:00:00Z")).toBe("2027-02-28T07:00:00.000Z");
    expect(next({ kind: "monthly", day: 31, time: "07:00" }, "UTC", "2027-02-28T07:00:00Z")).toBe("2027-03-31T07:00:00.000Z");
  });

  it("one-time schedules run once, never in the past", () => {
    expect(next({ kind: "once", date: "2026-12-01", time: "09:00" }, "Europe/London", "2026-10-07T00:00:00Z")).toBe("2026-12-01T09:00:00.000Z");
    expect(next({ kind: "once", date: "2026-01-01", time: "09:00" }, "Europe/London", "2026-10-07T00:00:00Z")).toBeNull();
  });

  it("validates zone names and converts wall-clock times", () => {
    expect(isValidTimeZone("Europe/London")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(new Date(zonedTimeToInstant({ year: 2026, month: 7, day: 1, hour: 12, minute: 0 }, "Australia/Sydney")).toISOString()).toBe("2026-07-01T02:00:00.000Z");
  });

  it("previews a result's first meaningful line", () => {
    expect(previewOf("\n## Weekly plan\n- one")).toBe("Weekly plan");
    expect(previewOf("**Bold** start")).toBe("Bold start");
  });
});

/** Waits until the test releases it; then answers. Lets tests observe a run while it is running. */
class GatedAdapter implements ProviderAdapter {
  readonly demo = false;
  readonly displayName: string;
  readonly model: string;
  readonly requests: ProviderRequest[] = [];
  private release!: () => void;
  private gate = new Promise<void>((r) => (this.release = r));
  constructor(readonly id: "openai" | "anthropic") {
    this.displayName = id === "openai" ? "OpenAI" : "Claude";
    this.model = `gated-${id}`;
  }
  open(): void {
    this.release();
  }
  async *stream(request: ProviderRequest): AsyncIterable<ProviderChunk> {
    this.requests.push(request);
    await this.gate;
    yield { type: "text", text: "# Morning brief\n\nThree priorities for today." };
    yield { type: "finish", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 8 } };
  }
}

const opened: FastifyInstance[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

async function setup(options: { env?: Record<string, string>; providers?: ProviderRegistry; store?: Store; start?: string } = {}) {
  const clock = { t: at(options.start ?? "2026-10-07T06:00:00Z") };
  const made = await makeApp({
    config: testConfig({ PROVIDER_DETAILS: "hidden", ...options.env }),
    providers: options.providers,
    store: options.store,
    now: () => new Date(clock.t),
  });
  opened.push(made.app);
  const user = await register(made.app);
  return { ...made, clock, user };
}

const daily = { name: "Morning brief", prompt: "Write my morning brief.", mode: "business", schedule: { kind: "daily", time: "08:00" }, timeZone: "Africa/Lagos" };

async function create(app: FastifyInstance, auth: Record<string, string>, body: Record<string, unknown> = daily) {
  const res = await app.inject({ method: "POST", url: "/v1/automations", headers: auth, payload: body });
  return { res, automation: res.statusCode === 201 ? Automation.parse(res.json()) : undefined };
}

describe("DASH Automates API", () => {
  it("creates, lists, edits, pauses, resumes and deletes an automation", async () => {
    const { app, user } = await setup();
    const { res, automation } = await create(app, user.auth);
    expect(res.statusCode).toBe(201);
    expect(automation).toMatchObject({ status: "active", state: "scheduled", nextRunAt: "2026-10-07T07:00:00.000Z", lastRun: null, mode: "business" });
    const id = automation!.id;

    const list = (await app.inject({ method: "GET", url: "/v1/automations", headers: user.auth })).json() as { automations: unknown[] };
    expect(list.automations).toHaveLength(1);

    // A rename keeps the schedule; a new time recomputes the next run.
    const renamed = Automation.parse((await app.inject({ method: "PATCH", url: `/v1/automations/${id}`, headers: user.auth, payload: { name: "Daily brief" } })).json());
    expect(renamed).toMatchObject({ name: "Daily brief", nextRunAt: "2026-10-07T07:00:00.000Z" });
    const retimed = Automation.parse(
      (await app.inject({ method: "PATCH", url: `/v1/automations/${id}`, headers: user.auth, payload: { schedule: { kind: "daily", time: "06:30" }, timeZone: "Europe/London" } })).json(),
    );
    expect(retimed.nextRunAt).toBe("2026-10-08T05:30:00.000Z"); // 06:30 BST

    const paused = Automation.parse((await app.inject({ method: "POST", url: `/v1/automations/${id}/pause`, headers: user.auth })).json());
    expect(paused).toMatchObject({ status: "paused", state: "paused", nextRunAt: null });
    const resumed = Automation.parse((await app.inject({ method: "POST", url: `/v1/automations/${id}/resume`, headers: user.auth })).json());
    expect(resumed).toMatchObject({ status: "active", state: "scheduled", nextRunAt: "2026-10-08T05:30:00.000Z" });

    expect((await app.inject({ method: "DELETE", url: `/v1/automations/${id}`, headers: user.auth })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/v1/automations/${id}`, headers: user.auth })).statusCode).toBe(404);
  });

  it("refuses invalid zones, past one-time dates, bad schedules and too many automations", async () => {
    const { app, user } = await setup({ env: { AUTOMATIONS_MAX_PER_USER: "1" } });
    expect((await create(app, user.auth, { ...daily, timeZone: "Mars/Olympus_Mons" })).res.statusCode).toBe(400);
    expect((await create(app, user.auth, { ...daily, schedule: { kind: "once", date: "2026-10-01", time: "08:00" } })).res.statusCode).toBe(400);
    expect((await create(app, user.auth, { ...daily, schedule: { kind: "daily", time: "25:00" } })).res.statusCode).toBe(400);
    expect((await create(app, user.auth, { ...daily, schedule: { kind: "weekly", days: [], time: "08:00" } })).res.statusCode).toBe(400);
    expect((await create(app, user.auth)).res.statusCode).toBe(201);
    expect((await create(app, user.auth)).res.statusCode).toBe(409);
  });

  it("Run now generates server-side, stores the result, notifies, and the result can be viewed and edited", async () => {
    const { app, user, context } = await setup();
    const { automation } = await create(app, user.auth);
    const run = await app.inject({ method: "POST", url: `/v1/automations/${automation!.id}/run`, headers: user.auth });
    expect(run.statusCode).toBe(202);
    expect(AutomationRunResponse.parse(run.json()).run).toMatchObject({ status: "queued", trigger: "manual" });
    await context.automations.idle();

    const detail = AutomationDetailResponse.parse((await app.inject({ method: "GET", url: `/v1/automations/${automation!.id}`, headers: user.auth })).json());
    expect(detail.automation.state).toBe("ready");
    expect(detail.automation.lastRun).toMatchObject({ status: "ready", trigger: "manual", demo: true, error: null });
    expect(detail.automation.lastRun!.preview).toContain("Demonstration answer from DASH AI");
    expect(detail.runs).toHaveLength(1);
    // The schedule is untouched by a manual run.
    expect(detail.automation.nextRunAt).toBe("2026-10-07T07:00:00.000Z");

    const runId = detail.runs[0]!.id;
    const full = AutomationRunResponse.parse((await app.inject({ method: "GET", url: `/v1/automations/${automation!.id}/runs/${runId}`, headers: user.auth })).json());
    expect(full.run.content).toContain("Demonstration answer from DASH AI");

    const notes = NotificationListResponse.parse((await app.inject({ method: "GET", url: "/v1/notifications", headers: user.auth })).json());
    expect(notes.unread).toBe(1);
    expect(notes.notifications[0]).toMatchObject({ kind: "automation.ready", title: "Morning brief is ready", automationId: automation!.id, runId, readAt: null });
    await app.inject({ method: "POST", url: "/v1/notifications/read", headers: user.auth, payload: { ids: [notes.notifications[0]!.id] } });
    expect(NotificationListResponse.parse((await app.inject({ method: "GET", url: "/v1/notifications", headers: user.auth })).json()).unread).toBe(0);

    const edited = await app.inject({ method: "PATCH", url: `/v1/automations/${automation!.id}/runs/${runId}`, headers: user.auth, payload: { content: "My edited brief." } });
    expect(AutomationRunResponse.parse(edited.json()).run).toMatchObject({ content: "My edited brief.", preview: "My edited brief." });
    expect(AutomationRunResponse.parse(edited.json()).run.editedAt).not.toBeNull();

    // Regenerate makes a new run and keeps the edited one in history.
    const regen = await app.inject({ method: "POST", url: `/v1/automations/${automation!.id}/runs/${runId}/regenerate`, headers: user.auth });
    expect(regen.statusCode).toBe(202);
    await context.automations.idle();
    const after = AutomationDetailResponse.parse((await app.inject({ method: "GET", url: `/v1/automations/${automation!.id}`, headers: user.auth })).json());
    expect(after.runs.map((r) => [r.trigger, r.status])).toEqual([["regenerate", "ready"], ["manual", "ready"]]);
  });

  it("shows Running while a run is in progress and refuses a second one", async () => {
    const gated = { openai: new GatedAdapter("openai"), anthropic: new GatedAdapter("anthropic") };
    const { app, user, context } = await setup({ providers: new ProviderRegistry(gated) });
    const { automation } = await create(app, user.auth);
    expect((await app.inject({ method: "POST", url: `/v1/automations/${automation!.id}/run`, headers: user.auth })).statusCode).toBe(202);
    const busy = await app.inject({ method: "POST", url: `/v1/automations/${automation!.id}/run`, headers: user.auth });
    expect(busy.statusCode).toBe(409);
    await waitForRequest(gated);
    const running = Automation.parse((await app.inject({ method: "GET", url: `/v1/automations/${automation!.id}`, headers: user.auth })).json().automation);
    expect(running.state).toBe("running");
    expect(running.lastRun?.status).toBe("running");
    gated.openai.open();
    gated.anthropic.open();
    await context.automations.idle();
    const done = Automation.parse((await app.inject({ method: "GET", url: `/v1/automations/${automation!.id}`, headers: user.auth })).json().automation);
    expect(done).toMatchObject({ state: "ready", lastRun: { preview: "Morning brief" } });
    // The automation instructions reached the model with the person's local date and zone.
    const system = [...gated.openai.requests, ...gated.anthropic.requests][0]!.system;
    expect(system).toContain("DASH Automates");
    expect(system).toContain("(Africa/Lagos)");
  });

  it("a failed run shows Failed with a neutral reason and a failure notice", async () => {
    const { app, user, context } = await setup();
    const { automation } = await create(app, user.auth, { ...daily, prompt: `Brief ${FAKE_TRIGGERS.error}` });
    await app.inject({ method: "POST", url: `/v1/automations/${automation!.id}/run`, headers: user.auth });
    await context.automations.idle();
    const detail = await app.inject({ method: "GET", url: `/v1/automations/${automation!.id}`, headers: user.auth });
    const parsed = AutomationDetailResponse.parse(detail.json());
    expect(parsed.automation.state).toBe("failed");
    expect(parsed.automation.lastRun).toMatchObject({ status: "failed", error: "DASH AI couldn't complete this run." });
    const notes = await app.inject({ method: "GET", url: "/v1/notifications", headers: user.auth });
    expect(NotificationListResponse.parse(notes.json()).notifications[0]).toMatchObject({ kind: "automation.failed", title: "Morning brief didn't finish" });
    // Nothing a person receives names the AI infrastructure.
    for (const body of [detail.body, notes.body]) {
      expect(containsProviderName(body)).toBe(false);
      expect(body).not.toMatch(/"provider"|"model"/);
    }
    // A failed result cannot be edited.
    const runId = parsed.runs[0]!.id;
    expect((await app.inject({ method: "PATCH", url: `/v1/automations/${automation!.id}/runs/${runId}`, headers: user.auth, payload: { content: "x" } })).statusCode).toBe(404);
  });
});

/** A live-like provider: fails with an HTTP status (real SDK error mapping), hangs until DASH AI gives up, or answers. */
type Behaviour = number | "hang" | "answer";
class FlakyAdapter implements ProviderAdapter {
  readonly demo = false;
  readonly displayName: string;
  readonly model: string;
  calls = 0;
  behaviour: Behaviour = "answer";
  constructor(readonly id: "openai" | "anthropic") {
    this.displayName = id === "openai" ? "OpenAI" : "Claude";
    this.model = `flaky-${id}`;
  }
  async *stream(request: ProviderRequest): AsyncIterable<ProviderChunk> {
    this.calls += 1;
    if (this.behaviour === "hang") {
      await new Promise<void>((resolve) => request.signal?.addEventListener("abort", () => resolve(), { once: true }));
      throw new Error("aborted");
    }
    if (typeof this.behaviour === "number") throw toProviderError(this.displayName, { name: "APIError", status: this.behaviour });
    yield { type: "text", text: "# Morning brief\n\nWritten by the backup engine." };
    yield { type: "finish", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 8 } };
  }
}

describe("provider failures during a run stay inside DASH AI", () => {
  /** Runs one automation with DASH AI's first and second provider for it behaving as given. */
  async function runWith(first: Behaviour, second: Behaviour, env: Record<string, string> = {}) {
    const openai = new FlakyAdapter("openai");
    const anthropic = new FlakyAdapter("anthropic");
    const s = await setup({ providers: new ProviderRegistry({ openai, anthropic }), env: { PROVIDER_MAX_RETRIES: "0", ...env } });
    const route = s.context.router.route({ task: "automation", mode: "business" });
    if (!route.ok) throw new Error(`no route: ${route.reason}`);
    const [primary, backup] = route.providers.map((id) => (id === "openai" ? openai : anthropic));
    primary!.behaviour = first;
    backup!.behaviour = second;
    const { automation } = await create(s.app, s.user.auth);
    await s.app.inject({ method: "POST", url: `/v1/automations/${automation!.id}/run`, headers: s.user.auth });
    await s.context.automations.idle();
    const detail = await s.app.inject({ method: "GET", url: `/v1/automations/${automation!.id}`, headers: s.user.auth });
    const notes = await s.app.inject({ method: "GET", url: "/v1/notifications", headers: s.user.auth });
    const parsed = AutomationDetailResponse.parse(detail.json());
    const run = await s.app.inject({ method: "GET", url: `/v1/automations/${automation!.id}/runs/${parsed.runs[0]!.id}`, headers: s.user.auth });
    return {
      primary: primary!,
      backup: backup!,
      context: s.context,
      lastRun: parsed.automation.lastRun!,
      run: AutomationRunResponse.parse(run.json()).run,
      notice: NotificationListResponse.parse(notes.json()).notifications[0]!,
      bodies: [detail.body, notes.body, run.body],
    };
  }

  const neutral = (bodies: string[]) => {
    for (const body of bodies) {
      expect(containsProviderName(body), body).toBe(false);
      expect(body).not.toMatch(/"provider"|"model"|flaky-|credentials|API key|administrator/i);
    }
  };

  it("a provider that rejects the server's key, is down or rate limited is replaced by the next one", async () => {
    for (const status of [401, 403, 404, 429, 503]) {
      const r = await runWith(status, "answer");
      expect(r.lastRun, String(status)).toMatchObject({ status: "ready", error: null, demo: false });
      expect(r.run.content).toContain("Written by the backup engine.");
      expect([r.primary.calls, r.backup.calls]).toEqual([1, 1]);
      expect(r.notice).toMatchObject({ kind: "automation.ready" });
      expect(r.context.metrics.render()).toMatch(/dash_provider_fallbacks_total\{from="\w+",to="\w+",code="(provider_error|rate_limited)"\} 1/);
      neutral(r.bodies);
    }
  });

  it("a provider that stops responding times out and the next one finishes the run", async () => {
    const r = await runWith("hang", "answer", { PROVIDER_IDLE_TIMEOUT_MS: "500" });
    expect(r.lastRun).toMatchObject({ status: "ready", error: null });
    expect(r.context.metrics.render()).toMatch(/dash_provider_fallbacks_total\{from="\w+",to="\w+",code="provider_timeout"\} 1/);
    neutral(r.bodies);
  });

  it("when every provider fails, the run and its notice say so in DASH AI's words", async () => {
    for (const [first, second, error] of [
      [401, 401, "DASH AI couldn't complete this run."],
      [503, 500, "DASH AI couldn't complete this run."],
      [429, 429, "DASH AI was very busy when this ran."],
      ["hang", "hang", "DASH AI took too long to finish this run."],
    ] as const) {
      const r = await runWith(first, second, { PROVIDER_IDLE_TIMEOUT_MS: "500" });
      expect(r.lastRun, String(first)).toMatchObject({ status: "failed", error });
      expect(r.notice).toMatchObject({ kind: "automation.failed", title: "Morning brief didn't finish" });
      expect(r.notice.body).toBe(`${error} Open it to run it again.`);
      neutral(r.bodies);
    }
  });
});

describe("the server-side scheduler", () => {
  it("runs due automations on schedule and moves to the next occurrence", async () => {
    const { app, user, context, clock } = await setup();
    const { automation } = await create(app, user.auth);
    await context.automations.tick();
    await context.automations.idle();
    expect(AutomationDetailResponse.parse((await app.inject({ method: "GET", url: `/v1/automations/${automation!.id}`, headers: user.auth })).json()).runs).toHaveLength(0);

    clock.t = at("2026-10-07T07:00:30Z");
    await context.automations.tick();
    await context.automations.idle();
    const detail = AutomationDetailResponse.parse((await app.inject({ method: "GET", url: `/v1/automations/${automation!.id}`, headers: user.auth })).json());
    expect(detail.runs.map((r) => [r.trigger, r.status])).toEqual([["schedule", "ready"]]);
    expect(detail.automation).toMatchObject({ state: "ready", nextRunAt: "2026-10-08T07:00:00.000Z" });
  });

  it("runs a missed automation once after downtime, then continues from the next occurrence", async () => {
    const { app, user, context, clock } = await setup();
    const { automation } = await create(app, user.auth);
    clock.t = at("2026-10-10T12:00:00Z"); // three occurrences missed
    await context.automations.tick();
    await context.automations.idle();
    await context.automations.tick();
    await context.automations.idle();
    const detail = AutomationDetailResponse.parse((await app.inject({ method: "GET", url: `/v1/automations/${automation!.id}`, headers: user.auth })).json());
    expect(detail.runs).toHaveLength(1);
    expect(detail.automation.nextRunAt).toBe("2026-10-11T07:00:00.000Z");
  });

  it("completes a one-time automation after its run", async () => {
    const { app, user, context, clock } = await setup();
    const { automation } = await create(app, user.auth, { ...daily, schedule: { kind: "once", date: "2026-10-07", time: "09:00" } });
    clock.t = at("2026-10-07T08:00:00Z");
    await context.automations.tick();
    await context.automations.idle();
    const a = Automation.parse((await app.inject({ method: "GET", url: `/v1/automations/${automation!.id}`, headers: user.auth })).json().automation);
    expect(a).toMatchObject({ status: "completed", state: "completed", nextRunAt: null, lastRun: { status: "ready" } });
    // Saving the whole form back with only a new name keeps it completed (its time has passed).
    const renamed = await app.inject({
      method: "PATCH",
      url: `/v1/automations/${automation!.id}`,
      headers: user.auth,
      payload: { name: "Renamed", prompt: a.prompt, mode: a.mode, schedule: a.schedule, timeZone: a.timeZone },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ name: "Renamed", status: "completed", nextRunAt: null });
  });

  it("never runs paused automations", async () => {
    const { app, user, context, clock } = await setup();
    const { automation } = await create(app, user.auth);
    await app.inject({ method: "POST", url: `/v1/automations/${automation!.id}/pause`, headers: user.auth });
    clock.t = at("2026-10-09T00:00:00Z");
    await context.automations.tick();
    await context.automations.idle();
    expect(AutomationDetailResponse.parse((await app.inject({ method: "GET", url: `/v1/automations/${automation!.id}`, headers: user.auth })).json()).runs).toHaveLength(0);
  });

  it("drops a scheduled run that was queued before the automation was paused", async () => {
    const { app, user, context, clock } = await setup();
    const { automation } = await create(app, user.auth);
    const record = (await context.store.getAutomation(user.user.id, automation!.id))!;
    // As if every worker slot was busy when the occurrence was queued.
    const outcome = await context.store.scheduleRun({
      automationId: record.id,
      expectedNextRunAt: record.nextRunAt!,
      nextRunAt: new Date(Date.parse(record.nextRunAt!) + 86_400_000).toISOString(),
      updatedAt: new Date(clock.t).toISOString(),
      run: newRun(record, "schedule", new Date(clock.t)),
    });
    expect(outcome).toBe("queued");
    await app.inject({ method: "POST", url: `/v1/automations/${automation!.id}/pause`, headers: user.auth });
    await context.automations.tick();
    await context.automations.idle();
    expect(await context.store.listRuns(user.user.id, automation!.id, 10)).toEqual([]);
    expect(await context.store.countUnreadNotifications(user.user.id)).toBe(0);
    // Run now still works while paused.
    expect((await app.inject({ method: "POST", url: `/v1/automations/${automation!.id}/run`, headers: user.auth })).statusCode).toBe(202);
    await context.automations.idle();
    expect((await context.store.listRuns(user.user.id, automation!.id, 10)).map((r) => r.status)).toEqual(["ready"]);
  });

  it("two API instances sharing one database run each occurrence exactly once", async () => {
    const pg = USING_POSTGRES ? await createTestPgStore() : undefined;
    const store: Store = pg?.store ?? new MemoryStore();
    try {
      const a = await setup({ store });
      const b = await setup({ store, start: "2026-10-07T06:00:00Z" });
      const { automation } = await create(a.app, a.user.auth);
      a.clock.t = b.clock.t = at("2026-10-07T07:01:00Z");
      await Promise.all([a.context.automations.tick(), b.context.automations.tick(), a.context.automations.tick()]);
      await Promise.all([a.context.automations.idle(), b.context.automations.idle()]);
      const runs = await store.listRuns(a.user.user.id, automation!.id, 10);
      expect(runs.map((r) => r.status)).toEqual(["ready"]);
    } finally {
      for (const app of opened.splice(0)) await app.close();
      await pg?.dispose();
    }
  });

  it("recovers a run whose instance stopped mid-run (expired lease) as interrupted", async () => {
    const { app, user, context, clock } = await setup();
    const { automation } = await create(app, user.auth);
    const store = context.store;
    const record = (await store.getAutomation(user.user.id, automation!.id))!;
    await store.enqueueRun({ ...(await import("../src/automations/service.js")).newRun(record, "manual", new Date(clock.t)) });
    // Another instance claimed it and then disappeared.
    expect(await store.claimQueuedRun(new Date(clock.t).toISOString(), new Date(clock.t + 1_000).toISOString())).toBeDefined();
    clock.t += 60_000;
    await context.automations.tick();
    await context.automations.idle();
    const detail = AutomationDetailResponse.parse((await app.inject({ method: "GET", url: `/v1/automations/${automation!.id}`, headers: user.auth })).json());
    expect(detail.automation.lastRun).toMatchObject({ status: "failed", error: "This run was interrupted before it finished." });
  });

  it("refuses Run now when automations are switched off on the server", async () => {
    const { app, user } = await setup({ env: { AUTOMATIONS_ENABLED: "false" } });
    const { automation } = await create(app, user.auth);
    expect((await app.inject({ method: "POST", url: `/v1/automations/${automation!.id}/run`, headers: user.auth })).statusCode).toBe(503);
  });
});

describe("ownership, export and account deletion", () => {
  it("keeps every automation, result and notice private to its owner", async () => {
    const { app, user, context } = await setup();
    const other = await register(app);
    const { automation } = await create(app, user.auth);
    await app.inject({ method: "POST", url: `/v1/automations/${automation!.id}/run`, headers: user.auth });
    await context.automations.idle();
    const runId = AutomationDetailResponse.parse((await app.inject({ method: "GET", url: `/v1/automations/${automation!.id}`, headers: user.auth })).json()).runs[0]!.id;
    for (const [method, url] of [
      ["GET", `/v1/automations/${automation!.id}`],
      ["PATCH", `/v1/automations/${automation!.id}`],
      ["DELETE", `/v1/automations/${automation!.id}`],
      ["POST", `/v1/automations/${automation!.id}/run`],
      ["POST", `/v1/automations/${automation!.id}/pause`],
      ["POST", `/v1/automations/${automation!.id}/resume`],
      ["GET", `/v1/automations/${automation!.id}/runs/${runId}`],
      ["PATCH", `/v1/automations/${automation!.id}/runs/${runId}`],
      ["POST", `/v1/automations/${automation!.id}/runs/${runId}/regenerate`],
    ] as const) {
      const res = await app.inject({ method, url, headers: other.auth, payload: method === "PATCH" ? { name: "x", content: "x" } : undefined });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    expect(NotificationListResponse.parse((await app.inject({ method: "GET", url: "/v1/notifications", headers: other.auth })).json()).notifications).toHaveLength(0);
    await app.inject({ method: "POST", url: "/v1/notifications/read", headers: other.auth, payload: {} });
    expect(NotificationListResponse.parse((await app.inject({ method: "GET", url: "/v1/notifications", headers: user.auth })).json()).unread).toBe(1);
    expect((await app.inject({ method: "GET", url: "/v1/automations" })).statusCode).toBe(401);
  });

  it("exports automations with their results, and deleting the account removes them", async () => {
    const { app, user, context } = await setup();
    const { automation } = await create(app, user.auth);
    await app.inject({ method: "POST", url: `/v1/automations/${automation!.id}/run`, headers: user.auth });
    await context.automations.idle();
    const exported = DataExportResponse.parse((await app.inject({ method: "GET", url: "/v1/me/export", headers: user.auth })).json());
    expect(exported.automations).toHaveLength(1);
    expect(exported.automations[0]!.runs[0]!.content).toContain("Demonstration answer");
    expect((await app.inject({ method: "DELETE", url: "/v1/me", headers: user.auth })).statusCode).toBe(204);
    expect(await context.store.countAutomations(user.user.id)).toBe(0);
    expect(await context.store.listNotifications(user.user.id, 10)).toHaveLength(0);
  });
});

async function waitForRequest(adapters: Record<string, GatedAdapter>): Promise<void> {
  const start = Date.now();
  while (Object.values(adapters).every((a) => a.requests.length === 0)) {
    if (Date.now() - start > 5_000) throw new Error("no provider request");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe.runIf(USING_POSTGRES)("at rest (PostgreSQL)", () => {
  it("stores names, prompts and results only as ciphertext", async () => {
    const { app, user, context } = await setup();
    const { automation } = await create(app, user.auth, { ...daily, name: "Secret plan name", prompt: "Secret prompt text" });
    await app.inject({ method: "POST", url: `/v1/automations/${automation!.id}/run`, headers: user.auth });
    await context.automations.idle();
    const pool = (context.store as unknown as { pool: { query: (sql: string) => Promise<{ rows: unknown[] }> } }).pool;
    const raw = JSON.stringify([
      (await pool.query("SELECT * FROM automations")).rows,
      (await pool.query("SELECT * FROM automation_runs")).rows,
    ]);
    expect(raw).not.toContain("Secret plan name");
    expect(raw).not.toContain("Secret prompt text");
    expect(raw).not.toContain("Demonstration answer");
  });
});
