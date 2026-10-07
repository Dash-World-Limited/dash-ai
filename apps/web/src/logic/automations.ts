import type { AutomationSchedule, AutomationState } from "@dash-ai/contracts";
import type { Tone } from "./presentation";

/** Same wording on Web and Android (see apps/android/core …/presentation/Automates.kt). */
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function scheduleLabel(s: AutomationSchedule): string {
  switch (s.kind) {
    case "once": {
      const [y, m, d] = s.date.split("-").map(Number);
      return `Once on ${d} ${MONTHS[m! - 1]} ${y} at ${s.time}`;
    }
    case "daily":
      return `Every day at ${s.time}`;
    case "weekly": {
      const days = [...s.days].sort((a, b) => a - b);
      if (days.length === 7) return `Every day at ${s.time}`;
      if (days.join() === "1,2,3,4,5") return `Weekdays at ${s.time}`;
      if (days.join() === "0,6") return `Weekends at ${s.time}`;
      const names = days.map((d) => `${DAY_NAMES[d]}s`);
      const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
      return `${list} at ${s.time}`;
    }
    case "monthly":
      return `Monthly on day ${s.day} at ${s.time}${s.day > 28 ? " (or the last day)" : ""}`;
  }
}

export const STATE_BADGE: Record<AutomationState, { text: string; tone: Tone }> = {
  scheduled: { text: "Scheduled", tone: "neutral" },
  running: { text: "Running", tone: "progress" },
  ready: { text: "Ready", tone: "success" },
  failed: { text: "Failed", tone: "error" },
  paused: { text: "Paused", tone: "neutral" },
  completed: { text: "Completed", tone: "neutral" },
};

/** "Today at 08:00", "Tomorrow at 08:00", "Mon 12 Oct at 08:00", in the viewer's own time zone. */
export function formatWhen(iso: string, now: Date, timeZone?: string): string {
  const date = new Date(iso);
  const opts = timeZone ? { timeZone } : {};
  const dayKey = (d: Date) => new Intl.DateTimeFormat("en-CA", { ...opts, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const time = new Intl.DateTimeFormat("en-GB", { ...opts, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  const today = dayKey(now);
  const tomorrow = dayKey(new Date(now.getTime() + 86_400_000));
  const yesterday = dayKey(new Date(now.getTime() - 86_400_000));
  const key = dayKey(date);
  if (key === today) return `Today at ${time}`;
  if (key === tomorrow) return `Tomorrow at ${time}`;
  if (key === yesterday) return `Yesterday at ${time}`;
  const day = new Intl.DateTimeFormat("en-GB", { ...opts, weekday: "short", day: "numeric", month: "short" }).format(date);
  return `${day} at ${time}`;
}

/** The browser's own IANA zone (the default for new automations). */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Every zone the browser knows, with the given one guaranteed present. */
export function timeZoneOptions(current: string): string[] {
  let zones: string[] = [];
  try {
    zones = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    zones = [];
  }
  return [...new Set([current, "UTC", ...zones])].sort((a, b) => (a === current ? -1 : b === current ? 1 : a.localeCompare(b)));
}

/** "Morning brief" → "morning-brief-2026-10-07.md". */
export function downloadName(name: string, createdAt: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "dash-ai-result";
  return `${slug}-${createdAt.slice(0, 10)}.md`;
}

/** Today's date (YYYY-MM-DD) and the next whole hour (HH:MM) in a zone, for new one-time schedules. */
export function suggestedOnce(now: Date, timeZone: string): { date: string; time: string } {
  const later = new Date(now.getTime() + 60 * 60_000);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
      .formatToParts(later)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:00` };
}
