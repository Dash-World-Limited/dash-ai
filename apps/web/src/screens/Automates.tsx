import {
  AUTOMATION_LIMITS,
  type AssistantMode,
  type Automation,
  type AutomationDetailResponse,
  type AutomationRun,
  type AutomationSchedule,
} from "@dash-ai/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError } from "../api/client";
import { Markdown } from "../chat/Markdown";
import { browserTimeZone, downloadName, formatWhen, scheduleLabel, STATE_BADGE, suggestedOnce, timeZoneOptions } from "../logic/automations";
import { MODE_ORDER, MODES } from "../logic/presentation";
import { useApp, useNow } from "../state/app";
import { navigate, useRoute } from "../state/router";
import { useStore } from "../state/store";
import { Icon } from "../ui/icons";
import { Badge, Confirm, Empty, Loading, Notice } from "../ui/kit";
import { TopBar } from "./Shell";

const message = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

/** /automates, /automates/new, /automates/:id, /automates/:id/edit, /automates/:id/runs/:runId */
export function AutomatesRoutes() {
  const app = useApp();
  const settings = useStore(app.settings);
  const { parts } = useRoute();
  if (settings.demoMode || !settings.account) {
    return (
      <>
        <TopBar title="Automates" />
        <div className="content">
          <main className="reading stack">
            <Empty icon="clock" title="Sign in to use Automates" testId="automates-signed-out" action={<button className="btn btn-primary" onClick={() => navigate("/sign-in")}>Sign in</button>}>
              Automates run on the DASH AI server for your account, even when this page is closed. Demo Mode doesn't run them.
            </Empty>
          </main>
        </div>
      </>
    );
  }
  const [, id, sub, runId] = parts;
  if (id === "new") return <AutomationEditor />;
  if (id && sub === "edit") return <AutomationEditor id={id} />;
  if (id && sub === "runs" && runId) return <RunScreen id={id} runId={runId} />;
  if (id) return <AutomationDetail id={id} />;
  return <AutomatesList />;
}

function StateBadge({ automation }: { automation: Automation }) {
  const b = STATE_BADGE[automation.state];
  return <Badge text={b.text} tone={b.tone} />;
}

function AutomatesList() {
  const app = useApp();
  const now = useNow(30_000);
  const notes = useStore(app.notifications);
  const [items, setItems] = useState<Automation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setItems((await app.api.automations()).automations);
      setError(null);
    } catch (e) {
      setError(message(e, "Couldn't load your automations."));
    }
  }, [app]);
  useEffect(() => {
    void load();
  }, [load, notes.unread]);
  // Running automations change state on the server: look again while any is running.
  useEffect(() => {
    if (!items?.some((a) => a.state === "running")) return;
    const t = setInterval(() => void load(), 3_000);
    return () => clearInterval(t);
  }, [items, load]);

  return (
    <>
      <TopBar
        title="Automates"
        actions={
          <button className="btn btn-primary" style={{ minHeight: 40, padding: "0 16px" }} onClick={() => navigate("/automates/new")} data-testid="new-automation">
            <Icon name="plus" size={18} /> New automation
          </button>
        }
      />
      <div className="content">
        <main className="reading stack" style={{ paddingBottom: 48 }} data-testid="automates">
          <p className="muted" style={{ margin: 0 }}>Schedule a task once and DASH AI prepares the result on time, even when this page is closed. You review it, then copy, download or share it yourself.</p>
          <NotificationsPanel />
          {error && <Notice tone="error" action={{ label: "Retry", onClick: () => void load() }}>{error}</Notice>}
          {!items && !error ? (
            <Loading label="Loading automations…" />
          ) : items && items.length === 0 ? (
            <Empty icon="clock" title="No automations yet" testId="automates-empty" action={<button className="btn btn-primary" onClick={() => navigate("/automates/new")}>Create one</button>}>
              For example: “Every weekday at 08:00, draft three priorities for my day.”
            </Empty>
          ) : (
            items?.map((a) => (
              <button key={a.id} className="card card-pad card-button stack" style={{ gap: 6 }} onClick={() => navigate(`/automates/${a.id}`)} data-testid="automation-item">
                <div className="row">
                  <strong className="grow ellipsis">{a.name}</strong>
                  <StateBadge automation={a} />
                </div>
                <span className="small muted">{scheduleLabel(a.schedule)} · {a.timeZone}</span>
                <span className="small faint">
                  {a.nextRunAt ? `Next: ${formatWhen(a.nextRunAt, new Date(now))}` : a.status === "paused" ? "Paused" : "No more runs scheduled"}
                  {a.lastRun?.finishedAt ? ` · Last: ${formatWhen(a.lastRun.finishedAt, new Date(now))}` : ""}
                </span>
              </button>
            ))
          )}
        </main>
      </div>
    </>
  );
}

function NotificationsPanel() {
  const app = useApp();
  const { items, unread } = useStore(app.notifications);
  const now = useNow(30_000);
  const [permission, setPermission] = useState(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
  const recent = items.filter((n) => n.readAt === null).slice(0, 5);
  if (recent.length === 0 && permission !== "default") return null;
  return (
    <section className="card card-pad stack" aria-label="Notifications" data-testid="notifications">
      {recent.length > 0 && (
        <>
          <div className="row">
            <Icon name="bell" />
            <strong className="grow">{unread === 1 ? "1 new result" : `${unread} new results`}</strong>
            <button className="btn btn-text" onClick={() => void app.markNotificationsRead()}>Mark all read</button>
          </div>
          {recent.map((n) => (
            <button key={n.id} className="nav-item" onClick={() => { void app.markNotificationsRead([n.id]); navigate(`/automates/${n.automationId}/runs/${n.runId}`); }} data-testid="notification">
              <span className="grow" style={{ textAlign: "left" }}>
                <span style={{ display: "block" }}>{n.title}</span>
                <span className="small faint">{n.body} · {formatWhen(n.createdAt, new Date(now))}</span>
              </span>
            </button>
          ))}
        </>
      )}
      {permission === "default" && (
        <div className="row small muted">
          <span className="grow">Get a browser notification when a result is ready (while DASH AI is open in a tab).</span>
          <button className="btn btn-text" onClick={() => void Notification.requestPermission().then(setPermission)}>Turn on</button>
        </div>
      )}
    </section>
  );
}

function useAutomation(id: string) {
  const app = useApp();
  const notes = useStore(app.notifications);
  const [data, setData] = useState<AutomationDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await app.api.automation(id));
      setError(null);
    } catch (e) {
      setError(message(e, "Couldn't load this automation."));
    }
  }, [app, id]);
  useEffect(() => {
    void load();
  }, [load, notes.unread]);
  useEffect(() => {
    if (data?.automation.state !== "running") return;
    const t = setInterval(() => void load(), 2_500);
    return () => clearInterval(t);
  }, [data?.automation.state, load]);
  return { data, setData, error, load };
}

function AutomationDetail({ id }: { id: string }) {
  const app = useApp();
  const now = useNow(30_000);
  const { data, error, load } = useAutomation(id);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      if (done) app.notify(done);
      await load();
    } catch (e) {
      setActionError(message(e, "That didn't work. Try again."));
    } finally {
      setBusy(false);
    }
  };
  const a = data?.automation;
  return (
    <>
      <TopBar
        back
        title={a?.name ?? "Automation"}
        actions={a && <button className="icon-btn" aria-label="Edit automation" onClick={() => navigate(`/automates/${id}/edit`)} data-testid="edit-automation"><Icon name="edit" /></button>}
      />
      <div className="content">
        <main className="reading stack" style={{ paddingBottom: 48 }} data-testid="automation-detail">
          {error && <Notice tone="error" action={{ label: "Retry", onClick: () => void load() }}>{error}</Notice>}
          {!a ? (
            !error && <Loading label="Loading…" />
          ) : (
            <>
              <section className="card card-pad stack">
                <div className="row">
                  <StateBadge automation={a} />
                  <span className="small muted grow">{MODES[a.mode].label}</span>
                </div>
                <div className="small muted">{scheduleLabel(a.schedule)} · {a.timeZone}</div>
                <div className="small" data-testid="next-run">{a.nextRunAt ? `Next run: ${formatWhen(a.nextRunAt, new Date(now))}` : a.status === "paused" ? "Paused: no runs until you resume it." : "No more runs scheduled."}</div>
                <div className="small" data-testid="last-run">
                  {a.lastRun ? `Last run: ${a.lastRun.finishedAt ? formatWhen(a.lastRun.finishedAt, new Date(now)) : "in progress"}` : "Not run yet."}
                </div>
                <p style={{ margin: 0, whiteSpace: "pre-wrap" }} className="muted">{a.prompt}</p>
                {actionError && <Notice tone="error">{actionError}</Notice>}
                <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
                  <button className="btn btn-primary" disabled={busy || a.state === "running"} onClick={() => void act(() => app.api.runAutomation(id), "Running now. The result will appear here.")} data-testid="run-now">
                    <Icon name="play" size={18} /> Run now
                  </button>
                  {a.status === "paused" ? (
                    <button className="btn btn-secondary" disabled={busy} onClick={() => void act(() => app.api.resumeAutomation(id), "Resumed")} data-testid="resume">Resume</button>
                  ) : a.status === "active" ? (
                    <button className="btn btn-secondary" disabled={busy} onClick={() => void act(() => app.api.pauseAutomation(id), "Paused")} data-testid="pause">
                      <Icon name="pause" size={18} /> Pause
                    </button>
                  ) : null}
                  <button className="btn btn-secondary btn-danger" disabled={busy} onClick={() => setDeleting(true)} data-testid="delete-automation">Delete</button>
                </div>
              </section>
              <h2 style={{ fontSize: 17, margin: "8px 0 0" }}>Results</h2>
              {data.runs.length === 0 && <p className="muted small" style={{ margin: 0 }}>Results appear here after each run.</p>}
              {data.runs.map((r) => (
                <button
                  key={r.id}
                  className="card card-pad card-button stack"
                  style={{ gap: 4 }}
                  disabled={r.status !== "ready"}
                  onClick={() => navigate(`/automates/${id}/runs/${r.id}`)}
                  data-testid="run-item"
                >
                  <div className="row">
                    <span className="grow small muted">{formatWhen(r.finishedAt ?? r.createdAt, new Date(now))} · {r.trigger === "schedule" ? "Scheduled" : r.trigger === "manual" ? "Run now" : "Regenerated"}</span>
                    <Badge text={r.status === "ready" ? "Ready" : r.status === "failed" ? "Failed" : "Running"} tone={r.status === "ready" ? "success" : r.status === "failed" ? "error" : "progress"} />
                  </div>
                  <span className="ellipsis">{r.status === "ready" ? r.preview || "Result" : r.status === "failed" ? r.error : "DASH AI is working on it…"}</span>
                </button>
              ))}
            </>
          )}
        </main>
      </div>
      {deleting && a && (
        <Confirm
          title="Delete this automation?"
          text={`“${a.name}” and all of its results will be removed.`}
          confirm="Delete"
          destructive
          onClose={() => setDeleting(false)}
          onConfirm={() => {
            setDeleting(false);
            void app.api.deleteAutomation(id).then(
              () => {
                app.notify("Automation deleted");
                navigate("/automates", true);
              },
              (e: unknown) => setActionError(message(e, "Couldn't delete it.")),
            );
          }}
        />
      )}
    </>
  );
}

type Kind = AutomationSchedule["kind"];
const WEEKDAYS = [["Mon", 1], ["Tue", 2], ["Wed", 3], ["Thu", 4], ["Fri", 5], ["Sat", 6], ["Sun", 0]] as const;

function AutomationEditor({ id }: { id?: string }) {
  const app = useApp();
  const settings = useStore(app.settings);
  const [loaded, setLoaded] = useState(!id);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<AssistantMode>(settings.defaultMode);
  const [timeZone, setTimeZone] = useState(browserTimeZone());
  const [kind, setKind] = useState<Kind>("daily");
  const [time, setTime] = useState("08:00");
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [day, setDay] = useState(1);
  const [date, setDate] = useState(() => suggestedOnce(new Date(), browserTimeZone()).date);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const zones = useMemo(() => timeZoneOptions(timeZone), [timeZone]);

  useEffect(() => {
    if (!id) return;
    void app.api.automation(id).then(
      ({ automation: a }) => {
        setName(a.name);
        setPrompt(a.prompt);
        setMode(a.mode);
        setTimeZone(a.timeZone);
        setKind(a.schedule.kind);
        setTime(a.schedule.time);
        if (a.schedule.kind === "weekly") setDays(a.schedule.days);
        if (a.schedule.kind === "monthly") setDay(a.schedule.day);
        if (a.schedule.kind === "once") setDate(a.schedule.date);
        setLoaded(true);
      },
      (e: unknown) => setError(message(e, "Couldn't load this automation.")),
    );
  }, [app, id]);

  const schedule = (): AutomationSchedule => {
    switch (kind) {
      case "once":
        return { kind, date, time };
      case "daily":
        return { kind, time };
      case "weekly":
        return { kind, days, time };
      case "monthly":
        return { kind, day, time };
    }
  };
  const valid = name.trim() !== "" && prompt.trim() !== "" && /^\d{2}:\d{2}$/.test(time) && (kind !== "weekly" || days.length > 0);

  const save = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    const body = { name: name.trim(), prompt: prompt.trim(), mode, timeZone, schedule: schedule() };
    try {
      const saved = id ? await app.api.updateAutomation(id, body) : await app.api.createAutomation(body);
      app.notify(id ? "Automation saved" : "Automation created");
      navigate(`/automates/${saved.id}`, true);
    } catch (e) {
      setError(message(e, "Couldn't save the automation."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <TopBar back title={id ? "Edit automation" : "New automation"} />
      <div className="content">
        <main className="reading" style={{ paddingBottom: 48 }}>
          {!loaded ? (
            error ? <Notice tone="error">{error}</Notice> : <Loading label="Loading…" />
          ) : (
            <form className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }} data-testid="automation-editor">
              <div className="field">
                <label htmlFor="a-name">Name</label>
                <input id="a-name" className="input" value={name} maxLength={AUTOMATION_LIMITS.maxNameChars} onChange={(e) => setName(e.target.value)} placeholder="Morning brief" data-testid="automation-name" />
              </div>
              <div className="field">
                <label htmlFor="a-prompt">What should DASH AI do?</label>
                <textarea id="a-prompt" className="input" rows={6} value={prompt} maxLength={AUTOMATION_LIMITS.maxPromptChars} onChange={(e) => setPrompt(e.target.value)} placeholder="Draft three priorities for my day and a short motivational note." data-testid="automation-prompt" style={{ resize: "vertical", paddingTop: 10 }} />
                <span className="hint">Write it as you would in chat. DASH AI won't be able to ask you questions when it runs.</span>
              </div>
              <div className="field">
                <label htmlFor="a-mode">Mode</label>
                <select id="a-mode" className="input" value={mode} onChange={(e) => setMode(e.target.value as AssistantMode)}>
                  {MODE_ORDER.map((m) => <option key={m} value={m}>{MODES[m].label}</option>)}
                </select>
              </div>
              <div className="field">
                <span id="a-repeat" style={{ fontSize: 14, color: "var(--ink-2)", fontWeight: 500 }}>Repeat</span>
                <div className="segmented" role="tablist" aria-labelledby="a-repeat">
                  {(["once", "daily", "weekly", "monthly"] as const).map((k) => (
                    <button key={k} type="button" role="tab" aria-selected={kind === k} onClick={() => setKind(k)} style={{ flex: 1 }} data-testid={`repeat-${k}`}>
                      {k === "once" ? "Once" : k === "daily" ? "Daily" : k === "weekly" ? "Weekly" : "Monthly"}
                    </button>
                  ))}
                </div>
              </div>
              {kind === "weekly" && (
                <div className="row" style={{ flexWrap: "wrap", gap: 8 }} role="group" aria-label="Days">
                  {WEEKDAYS.map(([label, d]) => (
                    <button key={d} type="button" className={`chip-btn${days.includes(d) ? " accent" : ""}`} aria-pressed={days.includes(d)} style={{ paddingRight: 12 }} onClick={() => setDays((x) => (x.includes(d) ? x.filter((y) => y !== d) : [...x, d]))}>
                      {label}
                    </button>
                  ))}
                </div>
              )}
              {kind === "monthly" && (
                <div className="field">
                  <label htmlFor="a-day">Day of the month</label>
                  <input id="a-day" className="input" type="number" min={1} max={31} value={day} onChange={(e) => setDay(Math.min(31, Math.max(1, Number(e.target.value) || 1)))} />
                  {day > 28 && <span className="hint">In shorter months it runs on the last day.</span>}
                </div>
              )}
              {kind === "once" && (
                <div className="field">
                  <label htmlFor="a-date">Date</label>
                  <input id="a-date" className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                </div>
              )}
              <div className="field">
                <label htmlFor="a-time">Time</label>
                <input id="a-time" className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} data-testid="automation-time" />
              </div>
              <div className="field">
                <label htmlFor="a-zone">Time zone</label>
                <select id="a-zone" className="input" value={timeZone} onChange={(e) => setTimeZone(e.target.value)} data-testid="automation-zone">
                  {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}
                </select>
                <span className="hint">The time is kept in this zone, including daylight-saving changes.</span>
              </div>
              <p className="small muted" style={{ margin: 0 }}>{scheduleLabel(schedule())}. Results stay in DASH AI for you to review; nothing is posted anywhere automatically.</p>
              {error && <Notice tone="error">{error}</Notice>}
              <div className="row">
                <button type="button" className="btn btn-text" style={{ color: "var(--ink-2)" }} onClick={() => history.back()}>Cancel</button>
                <span className="grow" />
                <button type="submit" className="btn btn-primary" disabled={!valid || busy} data-testid="save-automation">{busy ? "Saving…" : id ? "Save" : "Create automation"}</button>
              </div>
            </form>
          )}
        </main>
      </div>
    </>
  );
}

function RunScreen({ id, runId }: { id: string; runId: string }) {
  const app = useApp();
  const now = useNow(30_000);
  const [run, setRun] = useState<AutomationRun | null>(null);
  const [name, setName] = useState("Result");
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void Promise.all([app.api.automationRun(id, runId), app.api.automation(id)]).then(
      ([r, d]) => {
        setRun(r.run);
        setName(d.automation.name);
        const unread = app.notifications.value.items.filter((n) => n.runId === runId && n.readAt === null).map((n) => n.id);
        if (unread.length) void app.markNotificationsRead(unread);
      },
      (e: unknown) => setError(message(e, "Couldn't load this result.")),
    );
  }, [app, id, runId]);

  const copy = async () => {
    if (!run) return;
    try {
      await navigator.clipboard.writeText(run.content);
      app.notify("Copied");
    } catch {
      app.notify("Couldn't copy. Select the text and copy it instead.");
    }
  };
  const download = () => {
    if (!run) return;
    const url = URL.createObjectURL(new Blob([run.content], { type: "text/markdown;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = downloadName(name, run.createdAt);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };
  /** The device's own share sheet (or a copy where there is none). DASH AI never posts anywhere itself. */
  const share = async () => {
    if (!run) return;
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: name, text: run.content });
      } catch {
        // Dismissed by the person.
      }
    } else await copy();
  };
  const saveEdit = async () => {
    if (editing === null || !editing.trim()) return;
    setBusy(true);
    try {
      setRun((await app.api.editAutomationRun(id, runId, editing)).run);
      setEditing(null);
      app.notify("Saved");
    } catch (e) {
      app.notify(message(e, "Couldn't save your changes."));
    } finally {
      setBusy(false);
    }
  };
  const regenerate = async () => {
    setBusy(true);
    try {
      await app.api.regenerateAutomationRun(id, runId);
      app.notify("Regenerating. The new result will appear in this automation's results.");
      navigate(`/automates/${id}`, true);
    } catch (e) {
      app.notify(message(e, "Couldn't regenerate."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <TopBar back title={name} />
      <div className="content">
        <main className="reading stack" style={{ paddingBottom: 48 }} data-testid="automation-run">
          {error && <Notice tone="error">{error}</Notice>}
          {!run ? (
            !error && <Loading label="Loading result…" />
          ) : (
            <>
              <div className="small muted">
                {run.finishedAt ? formatWhen(run.finishedAt, new Date(now)) : ""}
                {run.editedAt ? " · edited" : ""}
                {run.demo ? " · Demonstration by DASH AI (simulated)" : " · DASH AI"}
              </div>
              {run.status !== "ready" ? (
                <Notice tone={run.status === "failed" ? "error" : "neutral"}>{run.status === "failed" ? run.error ?? "This run failed." : "DASH AI is still working on this result."}</Notice>
              ) : editing !== null ? (
                <>
                  <textarea className="input" rows={18} value={editing} maxLength={AUTOMATION_LIMITS.maxResultChars} onChange={(e) => setEditing(e.target.value)} aria-label="Edit result" data-testid="run-editor" style={{ resize: "vertical", paddingTop: 10, fontFamily: "var(--mono)", fontSize: 14 }} />
                  <div className="row">
                    <button className="btn btn-text" style={{ color: "var(--ink-2)" }} onClick={() => setEditing(null)}>Cancel</button>
                    <span className="grow" />
                    <button className="btn btn-primary" disabled={busy || !editing.trim()} onClick={() => void saveEdit()} data-testid="save-run">Save</button>
                  </div>
                </>
              ) : (
                <>
                  <div className="row" style={{ flexWrap: "wrap", gap: 8 }} role="toolbar" aria-label="Result actions">
                    <button className="btn btn-secondary" onClick={() => setEditing(run.content)} data-testid="run-edit"><Icon name="edit" size={18} /> Edit</button>
                    <button className="btn btn-secondary" disabled={busy} onClick={() => void regenerate()} data-testid="run-regenerate"><Icon name="refresh" size={18} /> Regenerate</button>
                    <button className="btn btn-secondary" onClick={() => void copy()} data-testid="run-copy"><Icon name="copy" size={18} /> Copy</button>
                    <button className="btn btn-secondary" onClick={download} data-testid="run-download"><Icon name="download" size={18} /> Download</button>
                    <button className="btn btn-secondary" onClick={() => void share()} data-testid="run-share"><Icon name="share" size={18} /> Share</button>
                  </div>
                  <article className="card card-pad answer" data-testid="run-content">
                    <Markdown text={run.content} />
                  </article>
                </>
              )}
            </>
          )}
        </main>
      </div>
    </>
  );
}
