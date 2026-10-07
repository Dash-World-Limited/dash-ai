import {
  AUTOMATION_LIMITS,
  type AppNotification,
  type Automation,
  type AutomationRun,
  type AutomationRunSummary,
  type AutomationRunTrigger,
  type AutomationState,
} from "@dash-ai/contracts";
import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "../config.js";
import { GenerationError, generateText } from "../intelligence/generate.js";
import type { IntelligenceRouter } from "../intelligence/router.js";
import type { Metrics } from "../observability/metrics.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { newId } from "../security/crypto.js";
import type { AutomationRecord, AutomationRunRecord, NotificationRecord, Store } from "../store/store.js";
import { localParts, nextRunIso } from "./schedule.js";

export interface AutomationDeps {
  store: Store;
  providers: ProviderRegistry;
  router: IntelligenceRouter;
  config: AppConfig;
  log: FastifyBaseLogger;
  metrics: Metrics;
  now: () => Date;
}

/** Added to DASH AI's identity and mode instructions for every automation run. */
export function automationInstructions(timeZone: string, now: Date): string {
  const p = localParts(now.getTime(), timeZone);
  const local = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  return [
    "This request comes from DASH Automates: a task the person scheduled earlier. They are not in the conversation " +
      "right now, so do not ask questions or wait for confirmation: make sensible assumptions, state them briefly, and " +
      "deliver the finished result ready to use.",
    `The current date and time for the person is ${local} (${timeZone}).`,
    "You have no live web access: never claim to have searched or checked current sources. Nothing you write is " +
      "published automatically; the person reviews, edits and shares the result themselves.",
  ].join(" ");
}

/** The message a person sees for a failed run, by normalized code. Never names a provider. */
export function runErrorMessage(code: string | null): string {
  switch (code) {
    case "provider_timeout":
      return "DASH AI took too long to finish this run.";
    case "rate_limited":
      return "DASH AI was very busy when this ran.";
    case "unavailable":
      return "DASH AI was unavailable when this ran.";
    case "interrupted":
      return "This run was interrupted before it finished.";
    default:
      return "DASH AI couldn't complete this run.";
  }
}

/** First meaningful line of a result, without Markdown markers, for lists and notifications. */
export function previewOf(content: string): string {
  const line = content.split("\n").map((l) => l.replace(/^\s*(#{1,6}\s+|[-*+]\s+|>\s*|\d+\.\s+)/, "").replace(/[*_`]/g, "").trim()).find((l) => l.length > 0) ?? "";
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

export function toRunSummary(r: AutomationRunRecord): AutomationRunSummary {
  return {
    id: r.id,
    automationId: r.automationId,
    status: r.status,
    trigger: r.trigger,
    createdAt: r.createdAt,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    editedAt: r.editedAt,
    error: r.status === "failed" ? runErrorMessage(r.errorCode) : null,
    demo: r.demo,
    preview: r.status === "ready" ? previewOf(r.content) : "",
  };
}

/** The full run for a person: provider and model are never included. */
export const toRun = (r: AutomationRunRecord): AutomationRun => ({ ...toRunSummary(r), content: r.status === "ready" ? r.content : "" });

export function stateOf(a: AutomationRecord, last: AutomationRunRecord | undefined): AutomationState {
  if (last && (last.status === "queued" || last.status === "running")) return "running";
  if (a.status === "paused") return "paused";
  if (last?.status === "failed") return "failed";
  if (last?.status === "ready") return a.status === "completed" ? "completed" : "ready";
  return a.status === "completed" ? "completed" : "scheduled";
}

export function newRun(automation: AutomationRecord, trigger: AutomationRunTrigger, now: Date): AutomationRunRecord {
  return {
    id: newId(),
    automationId: automation.id,
    userId: automation.userId,
    trigger,
    status: "queued",
    content: "",
    errorCode: null,
    createdAt: now.toISOString(),
    startedAt: null,
    finishedAt: null,
    leaseUntil: null,
    editedAt: null,
    provider: null,
    model: null,
    demo: false,
  };
}

/**
 * DASH Automates on the server: the scheduler and the executor.
 *
 * Every API instance runs one. Work is coordinated through the database, so any number of instances
 * can run without double execution and the phone never needs to be awake:
 * 1. Recover: a "running" run whose lease expired (its instance stopped) fails as "interrupted".
 * 2. Schedule: each due automation's nextRunAt is moved on by compare-and-set; only the instance that
 *    wins queues the run (at most one queued or running run per automation, enforced by a unique index).
 *    A server that was down runs a missed automation once, then continues from the next occurrence.
 * 3. Execute: queued runs are claimed (FOR UPDATE SKIP LOCKED) up to AUTOMATIONS_CONCURRENCY per
 *    instance and generated through the DASH Intelligence Router; the result and a notification are
 *    stored together.
 * Run now and Regenerate queue a run and poke the scheduler, so they start immediately.
 */
export class AutomationService {
  private timer: NodeJS.Timeout | undefined;
  private ticking: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private readonly inFlight = new Map<string, { promise: Promise<void>; controller: AbortController }>();

  constructor(private readonly deps: AutomationDeps) {}

  get enabled(): boolean {
    return this.deps.config.automations.enabled;
  }

  /** How long a claimed run may take before another instance treats it as abandoned. */
  private leaseMs(): number {
    const { providerTimeoutMs, providerRetry } = this.deps.config;
    return Math.max(1, this.deps.providers.configured().size) * (providerRetry.maxRetries + 1) * providerTimeoutMs + 60_000;
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => this.poke(), this.deps.config.automations.tickMs);
    this.timer.unref();
    this.poke();
  }

  /** Stops scheduling; runs still in progress are stopped and recorded as interrupted. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const { controller } of this.inFlight.values()) controller.abort("shutdown");
    await this.idle();
  }

  /** Runs a scheduling pass soon (coalesced with one already running). */
  poke(): void {
    if (!this.enabled || this.stopped) return;
    void this.tick().catch((err: unknown) => this.deps.log.warn({ err }, "automation scheduler pass failed"));
  }

  /** Resolves when no pass and no run is in progress (tests; shutdown). */
  async idle(): Promise<void> {
    while (this.ticking || this.inFlight.size > 0) {
      await Promise.allSettled([this.ticking, ...[...this.inFlight.values()].map((f) => f.promise)]);
    }
  }

  /** One scheduling pass: recover, schedule due automations, start queued runs. */
  tick(): Promise<void> {
    if (this.ticking) {
      this.again = true;
      return this.ticking;
    }
    this.ticking = (async () => {
      do {
        this.again = false;
        await this.recoverStale();
        await this.scheduleDue();
        await this.startQueued();
      } while (this.again && !this.stopped);
    })().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private async recoverStale(): Promise<void> {
    const now = this.deps.now();
    for (const run of await this.deps.store.listStaleRuns(now.toISOString(), 20)) {
      this.deps.log.warn({ automationRun: run.id }, "automation run lease expired; marking interrupted");
      await this.finish(run, { status: "failed", errorCode: "interrupted" });
    }
  }

  private async scheduleDue(): Promise<void> {
    const now = this.deps.now();
    const due = await this.deps.store.listDueAutomations(now.toISOString(), 50);
    for (const a of due) {
      // From now, not from the missed time: a server that was down runs a missed automation once.
      const next = a.schedule.kind === "once" ? null : nextRunIso(a.schedule, a.timeZone, now);
      const outcome = await this.deps.store.scheduleRun({
        automationId: a.id,
        expectedNextRunAt: a.nextRunAt!,
        nextRunAt: next,
        updatedAt: now.toISOString(),
        run: newRun(a, "schedule", now),
      });
      if (outcome === "skipped") this.deps.log.info({ automation: a.id }, "automation still running; this occurrence was skipped");
    }
  }

  private async startQueued(): Promise<void> {
    while (!this.stopped && this.inFlight.size < this.deps.config.automations.concurrency) {
      const now = this.deps.now();
      const run = await this.deps.store.claimQueuedRun(now.toISOString(), new Date(now.getTime() + this.leaseMs()).toISOString());
      if (!run) return;
      const controller = new AbortController();
      const promise = this.execute(run, controller.signal)
        .catch((err: unknown) => this.deps.log.error({ err, automationRun: run.id }, "automation run crashed"))
        .finally(() => {
          this.inFlight.delete(run.id);
          // A slot is free: look for more queued work.
          this.poke();
        });
      this.inFlight.set(run.id, { promise, controller });
    }
  }

  private async execute(run: AutomationRunRecord, signal: AbortSignal): Promise<void> {
    const { store, log, metrics } = this.deps;
    const automation = await store.getAutomation(run.userId, run.automationId);
    if (!automation) return; // deleted meanwhile (its runs went with it)
    const started = Date.now();
    // A run never outlives its lease, so another instance can never recover a run that is still going.
    const budget = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1_000, this.leaseMs() - 30_000))]);
    try {
      const result = await generateText(
        { providers: this.deps.providers, router: this.deps.router, config: this.deps.config, log, metrics },
        {
          task: "automation",
          mode: automation.mode,
          instructions: automationInstructions(automation.timeZone, this.deps.now()),
          prompt: automation.prompt,
          signal: budget,
        },
      );
      const content = result.content.slice(0, AUTOMATION_LIMITS.maxResultChars);
      await this.finish(run, { status: "ready", content, provider: result.provider, model: result.model, demo: result.demo });
      await store
        .recordUsage({
          userId: run.userId,
          conversationId: run.automationId,
          messageId: run.id,
          provider: result.provider,
          model: result.model,
          demo: result.demo,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          createdAt: this.deps.now().toISOString(),
        })
        .catch((err: unknown) => log.warn({ err }, "could not record automation usage"));
      metrics.automationRuns.inc({ trigger: run.trigger, status: "ready" });
      metrics.automationRunSeconds.observe({ status: "ready" }, (Date.now() - started) / 1000);
    } catch (err) {
      // Cancelled by shutdown = interrupted; cancelled by the run's own time budget = took too long.
      const code =
        err instanceof GenerationError ? (err.code === "cancelled" ? (signal.aborted ? "interrupted" : "provider_timeout") : err.code) : "provider_error";
      if (!(err instanceof GenerationError)) log.error({ err, automationRun: run.id }, "automation run failed unexpectedly");
      else log.warn({ automationRun: run.id, code }, "automation run failed");
      await this.finish(run, { status: "failed", errorCode: code });
      metrics.automationRuns.inc({ trigger: run.trigger, status: "failed" });
      metrics.automationRunSeconds.observe({ status: "failed" }, (Date.now() - started) / 1000);
    }
  }

  private async finish(
    run: AutomationRunRecord,
    outcome:
      | { status: "ready"; content: string; provider: AutomationRunRecord["provider"]; model: string; demo: boolean }
      | { status: "failed"; errorCode: string },
  ): Promise<void> {
    const now = this.deps.now().toISOString();
    const notification: NotificationRecord = {
      id: newId(),
      userId: run.userId,
      kind: outcome.status === "ready" ? "automation.ready" : "automation.failed",
      automationId: run.automationId,
      runId: run.id,
      createdAt: now,
      readAt: null,
    };
    await this.deps.store.finishRun({
      runId: run.id,
      status: outcome.status,
      content: outcome.status === "ready" ? outcome.content : "",
      errorCode: outcome.status === "failed" ? outcome.errorCode : null,
      finishedAt: now,
      provider: outcome.status === "ready" ? outcome.provider : null,
      model: outcome.status === "ready" ? outcome.model : null,
      demo: outcome.status === "ready" ? outcome.demo : false,
      notification,
      keep: AUTOMATION_LIMITS.maxRunsKept,
    });
  }

  // ---- views ---------------------------------------------------------------------------------

  async view(a: AutomationRecord): Promise<Automation> {
    const [last] = await this.deps.store.listRuns(a.userId, a.id, 1);
    return {
      id: a.id,
      name: a.name,
      prompt: a.prompt,
      mode: a.mode,
      schedule: a.schedule,
      timeZone: a.timeZone,
      status: a.status,
      state: stateOf(a, last),
      nextRunAt: a.status === "active" ? a.nextRunAt : null,
      lastRun: last ? toRunSummary(last) : null,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    };
  }

  async notificationsFor(userId: string, limit: number): Promise<AppNotification[]> {
    const records = await this.deps.store.listNotifications(userId, limit);
    const names = new Map<string, string>();
    const out: AppNotification[] = [];
    for (const n of records) {
      if (!names.has(n.automationId)) names.set(n.automationId, (await this.deps.store.getAutomation(userId, n.automationId))?.name ?? "Automation");
      const name = names.get(n.automationId)!;
      let body = "Your result is ready to review.";
      if (n.kind === "automation.failed") {
        const run = await this.deps.store.getRun(userId, n.automationId, n.runId);
        body = `${runErrorMessage(run?.errorCode ?? null)} Open it to run it again.`;
      }
      out.push({
        id: n.id,
        kind: n.kind,
        title: n.kind === "automation.ready" ? `${name} is ready` : `${name} didn't finish`,
        body,
        automationId: n.automationId,
        runId: n.runId,
        createdAt: n.createdAt,
        readAt: n.readAt,
      });
    }
    return out;
  }
}
