import { describe, expect, it } from "vitest";
import { downloadName, formatWhen, scheduleLabel, STATE_BADGE, suggestedOnce, timeZoneOptions } from "./automations";

describe("Automates labels", () => {
  it("describes every schedule in plain words (same wording as Android)", () => {
    expect(scheduleLabel({ kind: "daily", time: "08:00" })).toBe("Every day at 08:00");
    expect(scheduleLabel({ kind: "weekly", days: [5, 1, 2, 3, 4], time: "07:30" })).toBe("Weekdays at 07:30");
    expect(scheduleLabel({ kind: "weekly", days: [0, 6], time: "10:00" })).toBe("Weekends at 10:00");
    expect(scheduleLabel({ kind: "weekly", days: [1], time: "09:00" })).toBe("Mondays at 09:00");
    expect(scheduleLabel({ kind: "weekly", days: [5, 1, 3], time: "09:00" })).toBe("Mondays, Wednesdays and Fridays at 09:00");
    expect(scheduleLabel({ kind: "weekly", days: [0, 1, 2, 3, 4, 5, 6], time: "06:00" })).toBe("Every day at 06:00");
    expect(scheduleLabel({ kind: "monthly", day: 1, time: "07:00" })).toBe("Monthly on day 1 at 07:00");
    expect(scheduleLabel({ kind: "monthly", day: 31, time: "07:00" })).toBe("Monthly on day 31 at 07:00 (or the last day)");
    expect(scheduleLabel({ kind: "once", date: "2026-12-01", time: "09:00" })).toBe("Once on 1 Dec 2026 at 09:00");
  });

  it("labels every state with Ready / Running / Failed and the rest", () => {
    expect(STATE_BADGE.ready).toEqual({ text: "Ready", tone: "success" });
    expect(STATE_BADGE.running).toEqual({ text: "Running", tone: "progress" });
    expect(STATE_BADGE.failed).toEqual({ text: "Failed", tone: "error" });
    expect(Object.keys(STATE_BADGE).sort()).toEqual(["completed", "failed", "paused", "ready", "running", "scheduled"]);
  });

  it("formats run times relative to today in the viewer's zone", () => {
    const now = new Date("2026-10-07T10:00:00Z");
    expect(formatWhen("2026-10-07T07:00:00Z", now, "Africa/Lagos")).toBe("Today at 08:00");
    expect(formatWhen("2026-10-08T07:00:00Z", now, "Africa/Lagos")).toBe("Tomorrow at 08:00");
    expect(formatWhen("2026-10-06T07:00:00Z", now, "Africa/Lagos")).toBe("Yesterday at 08:00");
    expect(formatWhen("2026-10-12T07:00:00Z", now, "Africa/Lagos")).toBe("Mon 12 Oct at 08:00");
  });

  it("makes safe download names and sensible defaults", () => {
    expect(downloadName("Morning brief: Q4 / Sales!", "2026-10-07T07:00:00Z")).toBe("morning-brief-q4-sales-2026-10-07.md");
    expect(downloadName("✨", "2026-10-07T07:00:00Z")).toBe("dash-ai-result-2026-10-07.md");
    expect(suggestedOnce(new Date("2026-10-07T10:20:00Z"), "Africa/Lagos")).toEqual({ date: "2026-10-07", time: "12:00" });
    expect(timeZoneOptions("Africa/Lagos")[0]).toBe("Africa/Lagos");
    expect(timeZoneOptions("Africa/Lagos")).toContain("UTC");
  });
});
