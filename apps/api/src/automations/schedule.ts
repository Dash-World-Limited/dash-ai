import type { AutomationSchedule } from "@dash-ai/contracts";

/**
 * Time-zone-correct scheduling for DASH Automates. Schedules are wall-clock times in the automation's
 * own IANA zone ("every weekday at 08:00 in Africa/Lagos"), so daylight-saving changes never move a
 * run to the wrong local hour. Uses the runtime's ICU time-zone data (Intl); no extra dependency.
 *
 * Daylight-saving edge cases, decided once here:
 * - A local time that does not exist (spring forward, e.g. 02:30 when clocks jump 02:00 → 03:00)
 *   runs at the same offset past the gap (03:30).
 * - A local time that happens twice (fall back, e.g. 01:30) runs once, at the first occurrence.
 * - "monthly" on day 29–31 runs on the last day of shorter months.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** True for a real IANA zone name the runtime knows ("UTC" included). */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

export interface LocalDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** The wall-clock date and time at `instant` (ms) in `timeZone`. */
export function localParts(instant: number, timeZone: string): LocalDateTime & { second: number } {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(instant))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return { year: parts.year!, month: parts.month!, day: parts.day!, hour: parts.hour!, minute: parts.minute!, second: parts.second! };
}

/** Offset of `timeZone` from UTC at `instant`, in ms (positive east of Greenwich). */
function offsetAt(instant: number, timeZone: string): number {
  const p = localParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** The instant a wall-clock time happens in `timeZone` (see the DST rules above). */
export function zonedTimeToInstant(local: LocalDateTime, timeZone: string): number {
  const wall = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  // Offsets in force half a day either side cover any single transition near this time.
  const before = offsetAt(wall - 12 * 3_600_000, timeZone);
  const after = offsetAt(wall + 12 * 3_600_000, timeZone);
  const valid = [...new Set([before, after])].map((o) => wall - o).filter((t) => offsetAt(t, timeZone) === wall - t);
  if (valid.length > 0) return Math.min(...valid);
  // In a gap: keep the pre-transition offset, which lands the same distance past the jump.
  return wall - before;
}

const daysInMonth = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();

const parseTime = (time: string): { hour: number; minute: number } => {
  const [h, m] = time.split(":").map(Number);
  return { hour: h!, minute: m! };
};

/**
 * The first run strictly after `after` (ms), as a UTC instant in ms, or null when there is none (a
 * one-time automation whose time has passed). Looks at most ~13 months ahead.
 */
export function nextRunAfter(schedule: AutomationSchedule, timeZone: string, after: number): number | null {
  const { hour, minute } = parseTime(schedule.time);
  if (schedule.kind === "once") {
    const [year, month, day] = schedule.date.split("-").map(Number);
    const t = zonedTimeToInstant({ year: year!, month: month!, day: day!, hour, minute }, timeZone);
    return t > after ? t : null;
  }
  // Walk local calendar dates from the day `after` falls on in this zone.
  const start = localParts(after, timeZone);
  for (let i = 0; i < 400; i++) {
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day + i));
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    const matches =
      schedule.kind === "daily" ||
      (schedule.kind === "weekly" && schedule.days.includes(date.getUTCDay())) ||
      (schedule.kind === "monthly" && day === Math.min(schedule.day, daysInMonth(year, month)));
    if (!matches) continue;
    const t = zonedTimeToInstant({ year, month, day, hour, minute }, timeZone);
    if (t > after) return t;
  }
  return null;
}

/** ISO form of nextRunAfter, or null. */
export function nextRunIso(schedule: AutomationSchedule, timeZone: string, after: Date): string | null {
  const t = nextRunAfter(schedule, timeZone, after.getTime());
  return t === null ? null : new Date(t).toISOString();
}
