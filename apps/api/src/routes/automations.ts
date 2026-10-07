import {
  AUTOMATION_LIMITS,
  CreateAutomationRequest,
  Id,
  MarkNotificationsReadRequest,
  UpdateAutomationRequest,
  UpdateAutomationRunRequest,
  type Automation,
  type AutomationDetailResponse,
  type AutomationListResponse,
  type AutomationRunResponse,
  type NotificationListResponse,
} from "@dash-ai/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { currentUser } from "../auth/requireAuth.js";
import { isValidTimeZone, nextRunIso } from "../automations/schedule.js";
import { newRun, toRun, toRunSummary } from "../automations/service.js";
import { AppError, parseOrThrow } from "../errors.js";
import { newId } from "../security/crypto.js";
import type { AutomationRecord } from "../store/store.js";
import type { RouteContext } from "./context.js";

const Params = z.object({ id: Id });
const RunParams = z.object({ id: Id, runId: Id });

/**
 * DASH Automates API: define a task and a schedule, then review what DASH AI produced. Results are
 * only ever returned to their owner; nothing is posted anywhere automatically.
 */
export function automationRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const auth = { preHandler: ctx.requireAuth };
  // Run now and Regenerate spend AI capacity: they share the chat limit.
  const runLimit = { preHandler: [ctx.requireAuth, ctx.rateLimit("chat", (r) => `chat:${r.authUser?.id ?? r.ip}`)] };
  const service = ctx.automations;

  const load = async (request: FastifyRequest): Promise<AutomationRecord> => {
    const { id } = parseOrThrow(Params, request.params, "automation id");
    const automation = await ctx.store.getAutomation(currentUser(request).id, id);
    if (!automation) throw new AppError("not_found", "Automation not found.");
    return automation;
  };

  const checkTimeZone = (timeZone: string) => {
    if (!isValidTimeZone(timeZone)) throw new AppError("bad_request", "Choose a valid time zone.");
  };

  /** The next run for an active schedule; a one-time schedule in the past is refused. */
  const firstRun = (a: Pick<AutomationRecord, "schedule" | "timeZone">): string => {
    const next = nextRunIso(a.schedule, a.timeZone, ctx.now());
    if (!next) throw new AppError("bad_request", "That date and time has already passed in the chosen time zone.");
    return next;
  };

  const queue = async (automation: AutomationRecord, trigger: "manual" | "regenerate") => {
    if (!service.enabled) throw new AppError("no_provider_available", "DASH Automates is paused on this server. Try again later.");
    const run = newRun(automation, trigger, ctx.now());
    if (!(await ctx.store.enqueueRun(run))) throw new AppError("conflict", "This automation is already running. Its result will appear when it finishes.");
    service.poke();
    return run;
  };

  app.get("/v1/automations", auth, async (request: FastifyRequest): Promise<AutomationListResponse> => {
    const automations = await ctx.store.listAutomations(currentUser(request).id);
    return { automations: await Promise.all(automations.map((a) => service.view(a))) };
  });

  app.post("/v1/automations", auth, async (request: FastifyRequest, reply: FastifyReply): Promise<Automation> => {
    const user = currentUser(request);
    const body = parseOrThrow(CreateAutomationRequest, request.body);
    checkTimeZone(body.timeZone);
    if ((await ctx.store.countAutomations(user.id)) >= ctx.config.automations.maxPerUser) {
      throw new AppError("conflict", `You can keep up to ${ctx.config.automations.maxPerUser} automations. Delete one to add another.`);
    }
    const now = ctx.now().toISOString();
    const record: AutomationRecord = {
      id: newId(),
      userId: user.id,
      name: body.name,
      prompt: body.prompt,
      mode: body.mode,
      schedule: body.schedule,
      timeZone: body.timeZone,
      status: "active",
      nextRunAt: firstRun(body),
      createdAt: now,
      updatedAt: now,
    };
    if (!(await ctx.store.createAutomation(record))) throw new AppError("unauthorized", "Sign in to continue.");
    reply.code(201);
    return service.view(record);
  });

  app.get("/v1/automations/:id", auth, async (request: FastifyRequest): Promise<AutomationDetailResponse> => {
    const automation = await load(request);
    const runs = await ctx.store.listRuns(automation.userId, automation.id, AUTOMATION_LIMITS.maxRunsKept);
    return { automation: await service.view(automation), runs: runs.map(toRunSummary) };
  });

  app.patch("/v1/automations/:id", auth, async (request: FastifyRequest): Promise<Automation> => {
    const automation = await load(request);
    const body = parseOrThrow(UpdateAutomationRequest, request.body);
    if (body.timeZone !== undefined) checkTimeZone(body.timeZone);
    const updated: AutomationRecord = { ...automation, ...body, updatedAt: ctx.now().toISOString() };
    const timing = body.schedule !== undefined || body.timeZone !== undefined;
    if (timing && updated.status !== "paused") {
      // A new schedule starts fresh; a completed one-time automation given a new time becomes active again.
      updated.status = "active";
      updated.nextRunAt = firstRun(updated);
    }
    if (!(await ctx.store.updateAutomation(updated))) throw new AppError("not_found", "Automation not found.");
    service.poke();
    return service.view(updated);
  });

  app.post("/v1/automations/:id/pause", auth, async (request: FastifyRequest): Promise<Automation> => {
    const automation = await load(request);
    if (automation.status === "completed") throw new AppError("conflict", "This one-time automation has already run.");
    const updated: AutomationRecord = { ...automation, status: "paused", nextRunAt: null, updatedAt: ctx.now().toISOString() };
    await ctx.store.updateAutomation(updated);
    return service.view(updated);
  });

  app.post("/v1/automations/:id/resume", auth, async (request: FastifyRequest): Promise<Automation> => {
    const automation = await load(request);
    if (automation.status === "active") return service.view(automation);
    // Resuming never replays what was missed while paused: it continues from the next occurrence.
    const updated: AutomationRecord = { ...automation, status: "active", nextRunAt: firstRun(automation), updatedAt: ctx.now().toISOString() };
    await ctx.store.updateAutomation(updated);
    service.poke();
    return service.view(updated);
  });

  app.delete("/v1/automations/:id", auth, async (request: FastifyRequest, reply: FastifyReply) => {
    const automation = await load(request);
    await ctx.store.deleteAutomation(automation.userId, automation.id);
    reply.code(204);
  });

  /** Run now: queues a run immediately, whatever the schedule (paused and completed included). */
  app.post("/v1/automations/:id/run", runLimit, async (request: FastifyRequest, reply: FastifyReply): Promise<AutomationRunResponse> => {
    const run = await queue(await load(request), "manual");
    reply.code(202);
    return { run: toRun(run) };
  });

  app.get("/v1/automations/:id/runs/:runId", auth, async (request: FastifyRequest): Promise<AutomationRunResponse> => {
    const { id, runId } = parseOrThrow(RunParams, request.params, "run id");
    const run = await ctx.store.getRun(currentUser(request).id, id, runId);
    if (!run) throw new AppError("not_found", "Result not found. Older results are removed as new ones arrive.");
    return { run: toRun(run) };
  });

  /** Edit: the person's own changes replace the result text (Regenerate makes a fresh run). */
  app.patch("/v1/automations/:id/runs/:runId", auth, async (request: FastifyRequest): Promise<AutomationRunResponse> => {
    const { id, runId } = parseOrThrow(RunParams, request.params, "run id");
    const { content } = parseOrThrow(UpdateAutomationRunRequest, request.body);
    const userId = currentUser(request).id;
    if (!(await ctx.store.updateRunContent(userId, id, runId, content, ctx.now().toISOString()))) {
      throw new AppError("not_found", "Only a finished result can be edited.");
    }
    return { run: toRun((await ctx.store.getRun(userId, id, runId))!) };
  });

  /** Regenerate: a new run of the same automation (the earlier result is kept in its history). */
  app.post("/v1/automations/:id/runs/:runId/regenerate", runLimit, async (request: FastifyRequest, reply: FastifyReply): Promise<AutomationRunResponse> => {
    const { id, runId } = parseOrThrow(RunParams, request.params, "run id");
    const userId = currentUser(request).id;
    if (!(await ctx.store.getRun(userId, id, runId))) throw new AppError("not_found", "Result not found.");
    const automation = await ctx.store.getAutomation(userId, id);
    if (!automation) throw new AppError("not_found", "Automation not found.");
    const run = await queue(automation, "regenerate");
    reply.code(202);
    return { run: toRun(run) };
  });

  app.get("/v1/notifications", auth, async (request: FastifyRequest): Promise<NotificationListResponse> => {
    const userId = currentUser(request).id;
    return { notifications: await service.notificationsFor(userId, 50), unread: await ctx.store.countUnreadNotifications(userId) };
  });

  app.post("/v1/notifications/read", auth, async (request: FastifyRequest): Promise<{ updated: number }> => {
    const body = parseOrThrow(MarkNotificationsReadRequest, request.body ?? {});
    return { updated: await ctx.store.markNotificationsRead(currentUser(request).id, body.ids ?? null, ctx.now().toISOString()) };
  });
}
