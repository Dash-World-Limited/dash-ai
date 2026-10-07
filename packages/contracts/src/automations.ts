import { z } from "zod";
import { AssistantMode, Id, IsoDateTime } from "./common.js";

/**
 * DASH Automates: a person defines a task and a schedule; the server runs it (the phone does not need
 * to be awake), DASH AI generates the result, stores it and notifies the person, who can then view,
 * edit, regenerate, copy, download or share it. Results are never posted anywhere automatically.
 */

export const AUTOMATION_LIMITS = {
  maxNameChars: 80,
  maxPromptChars: 8_000,
  /** Results kept per automation (older runs are removed when a new one starts). */
  maxRunsKept: 30,
  maxResultChars: 100_000,
} as const;

/** "HH:MM", 24-hour, in the automation's own time zone. */
export const LocalTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour)");
export type LocalTime = z.infer<typeof LocalTime>;

/** 0 = Sunday … 6 = Saturday (the JavaScript and ISO-week-agnostic convention). */
export const Weekday = z.number().int().min(0).max(6);

/**
 * When an automation runs, in its own IANA time zone (so "every day at 08:00" stays 08:00 across
 * daylight-saving changes). "once" is a local date and time.
 */
export const AutomationSchedule = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("once"), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"), time: LocalTime }),
  z.object({ kind: z.literal("daily"), time: LocalTime }),
  z.object({
    kind: z.literal("weekly"),
    days: z.array(Weekday).min(1).max(7).refine((d) => new Set(d).size === d.length, "Days must not repeat"),
    time: LocalTime,
  }),
  /** Day 29–31 runs on the last day of shorter months. */
  z.object({ kind: z.literal("monthly"), day: z.number().int().min(1).max(31), time: LocalTime }),
]);
export type AutomationSchedule = z.infer<typeof AutomationSchedule>;

/** IANA zone name such as "Africa/Lagos" or "Europe/London". The server checks it is a real zone. */
export const TimeZoneName = z.string().min(1).max(64).regex(/^[A-Za-z0-9_+\-/]+$/, "Not a time zone name");

/** active: scheduled. paused: kept but not run. completed: a one-time automation that has run. */
export const AutomationStatus = z.enum(["active", "paused", "completed"]);
export type AutomationStatus = z.infer<typeof AutomationStatus>;

/** queued → running → ready | failed. */
export const AutomationRunStatus = z.enum(["queued", "running", "ready", "failed"]);
export type AutomationRunStatus = z.infer<typeof AutomationRunStatus>;

export const AutomationRunTrigger = z.enum(["schedule", "manual", "regenerate"]);
export type AutomationRunTrigger = z.infer<typeof AutomationRunTrigger>;

/** A run as lists show it: no content. Provider-neutral (no provider or model, ever). */
export const AutomationRunSummary = z.object({
  id: Id,
  automationId: Id,
  status: AutomationRunStatus,
  trigger: AutomationRunTrigger,
  createdAt: IsoDateTime,
  startedAt: IsoDateTime.nullable(),
  finishedAt: IsoDateTime.nullable(),
  /** Set when the person edited the result. */
  editedAt: IsoDateTime.nullable(),
  /** A neutral, user-safe reason when status is "failed". */
  error: z.string().nullable(),
  /** True when the server runs demonstration adapters: the result is a labelled demonstration. */
  demo: z.boolean(),
  /** First line of the result, for lists (empty until ready). */
  preview: z.string(),
});
export type AutomationRunSummary = z.infer<typeof AutomationRunSummary>;

export const AutomationRun = AutomationRunSummary.extend({
  /** The result, in Markdown. Empty until the run is ready. */
  content: z.string(),
});
export type AutomationRun = z.infer<typeof AutomationRun>;

/**
 * What a person sees about one automation. `state` is the one label clients show:
 * running (a run is queued or running), failed (the last run failed), ready (the last run produced a
 * result), scheduled (active, nothing run yet), paused, completed.
 */
export const AutomationState = z.enum(["scheduled", "running", "ready", "failed", "paused", "completed"]);
export type AutomationState = z.infer<typeof AutomationState>;

export const Automation = z.object({
  id: Id,
  name: z.string().min(1).max(AUTOMATION_LIMITS.maxNameChars),
  prompt: z.string().min(1).max(AUTOMATION_LIMITS.maxPromptChars),
  mode: AssistantMode,
  schedule: AutomationSchedule,
  timeZone: TimeZoneName,
  status: AutomationStatus,
  state: AutomationState,
  /** Next scheduled run (UTC instant), or null when paused or completed. */
  nextRunAt: IsoDateTime.nullable(),
  lastRun: AutomationRunSummary.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Automation = z.infer<typeof Automation>;

export const CreateAutomationRequest = z.object({
  name: z.string().trim().min(1).max(AUTOMATION_LIMITS.maxNameChars),
  prompt: z.string().trim().min(1).max(AUTOMATION_LIMITS.maxPromptChars),
  mode: AssistantMode.default("general"),
  schedule: AutomationSchedule,
  timeZone: TimeZoneName,
});
export type CreateAutomationRequest = z.infer<typeof CreateAutomationRequest>;

/** Every field optional; a schedule or time-zone change recomputes the next run. */
export const UpdateAutomationRequest = CreateAutomationRequest.partial();
export type UpdateAutomationRequest = z.infer<typeof UpdateAutomationRequest>;

export const AutomationListResponse = z.object({ automations: z.array(Automation) });
export type AutomationListResponse = z.infer<typeof AutomationListResponse>;

export const AutomationDetailResponse = z.object({
  automation: Automation,
  /** Most recent first. */
  runs: z.array(AutomationRunSummary),
});
export type AutomationDetailResponse = z.infer<typeof AutomationDetailResponse>;

export const AutomationRunResponse = z.object({ run: AutomationRun });
export type AutomationRunResponse = z.infer<typeof AutomationRunResponse>;

/** Edit a ready result in place (the original is replaced; Regenerate makes a new run). */
export const UpdateAutomationRunRequest = z.object({
  content: z.string().min(1).max(AUTOMATION_LIMITS.maxResultChars),
});
export type UpdateAutomationRunRequest = z.infer<typeof UpdateAutomationRunRequest>;

export const NotificationKind = z.enum(["automation.ready", "automation.failed"]);
export type NotificationKind = z.infer<typeof NotificationKind>;

/** An in-app notice. Titles are built by the server from the automation's name. */
export const AppNotification = z.object({
  id: Id,
  kind: NotificationKind,
  title: z.string(),
  body: z.string(),
  automationId: Id,
  runId: Id,
  createdAt: IsoDateTime,
  readAt: IsoDateTime.nullable(),
});
export type AppNotification = z.infer<typeof AppNotification>;

export const NotificationListResponse = z.object({
  notifications: z.array(AppNotification),
  unread: z.number().int().nonnegative(),
});
export type NotificationListResponse = z.infer<typeof NotificationListResponse>;

/** Marks the listed notifications read, or all of them when `ids` is omitted. */
export const MarkNotificationsReadRequest = z.object({ ids: z.array(Id).max(200).optional() });
export type MarkNotificationsReadRequest = z.infer<typeof MarkNotificationsReadRequest>;

/** Data export entry: an automation with all of its kept runs (results included). */
export const AutomationExport = z.object({ automation: Automation, runs: z.array(AutomationRun) });
export type AutomationExport = z.infer<typeof AutomationExport>;
