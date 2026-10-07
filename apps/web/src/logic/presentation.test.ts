import { describe, expect, it } from "vitest";
import type { PluginInfo } from "@dash-ai/contracts";
import { canSwitch, greeting, groupHistory, initials, providerOptions, recoveryCard, toolConnection, toolUseLabel, authFailure, ALL_AVAILABLE } from "./presentation";

describe("greeting", () => {
  it("uses the time of day and the account's own first name, never an invented one", () => {
    expect(greeting(8, "Ada Lovelace")).toBe("Good morning, Ada");
    expect(greeting(14, "Chinedu")).toBe("Good afternoon, Chinedu");
    expect(greeting(19, " Ngozi ")).toBe("Good evening, Ngozi");
    expect(greeting(2, "Ngozi")).toBe("Hello, Ngozi");
    expect(greeting(9, null)).toBe("Good morning");
    expect(greeting(9, "Demo user")).toBe("Good morning");
    expect(initials("Ada Lovelace", null)).toBe("AL");
    expect(initials(null, "john.doe@example.com")).toBe("JD");
  });
});

describe("history grouping", () => {
  it("groups by local calendar day and omits empty sections", () => {
    const now = new Date(2026, 2, 10, 9, 0).getTime();
    const at = (d: Date) => ({ id: d.toISOString(), updatedAt: d.toISOString() });
    const items = [at(new Date(2026, 2, 10, 0, 5)), at(new Date(2026, 2, 9, 23, 59)), at(new Date(2026, 2, 5)), at(new Date(2026, 1, 1))];
    expect(groupHistory(items, now).map((g) => [g.section, g.items.length])).toEqual([
      ["Today", 1],
      ["Yesterday", 1],
      ["Previous 7 days", 1],
      ["Older", 1],
    ]);
    expect(groupHistory([], now)).toEqual([]);
  });
});

describe("providers", () => {
  it("lists only real choices, explains unavailable ones and never switches mid-answer", () => {
    const onlyOpenAi = { configured: new Set(["openai"] as const), models: { openai: "gpt-x" } };
    const options = providerOptions(onlyOpenAi, "smart", false);
    expect(options.map((o) => o.choice)).toEqual(["smart", "openai", "claude", "compare"]);
    expect(options.map((o) => o.available)).toEqual([true, true, false, false]);
    expect(options[2]!.unavailableReason).toBe("Not configured on this server.");
    expect(options[1]!.model).toBe("gpt-x");
    expect(canSwitch("claude", ALL_AVAILABLE, false, true)).toBe(false);
    expect(canSwitch("claude", onlyOpenAi, false, false)).toBe(false);
  });

  it("recovery offers retry, an explicit change of provider from the server's list, and continue later", () => {
    const card = recoveryCard({ provider: "openai", compareGroupId: null, errorMessage: "OpenAI is busy.", retryable: true, recovery: { attempts: 3, alternatives: ["anthropic"] } }, ALL_AVAILABLE.configured, true);
    expect(card.title).toBe("Provider temporarily unavailable");
    expect(card.actions).toEqual(["retry", "change", "later"]);
    expect(card.alternatives).toEqual(["anthropic"]);
    expect(card.attemptsNote).toBe("DASH AI tried 3 times before stopping.");
    const offline = recoveryCard({ provider: "openai", compareGroupId: null, errorMessage: null, retryable: true }, ALL_AVAILABLE.configured, false);
    expect(offline.actions).toEqual(["later"]);
    const compare = recoveryCard({ provider: "openai", compareGroupId: "g", errorMessage: null, retryable: true, recovery: { attempts: 1, alternatives: ["anthropic"] } }, ALL_AVAILABLE.configured, true);
    expect(compare.alternatives).toEqual([]);
  });
});

describe("auth failures", () => {
  it("distinguishes offline, wrong credentials, existing accounts and server trouble", () => {
    expect(authFailure("network", "", true, true).kind).toBe("offline");
    expect(authFailure("internal_error", "x", true, false).kind).toBe("offline");
    expect(authFailure("unauthorized", "Email or password is incorrect.", false, true)).toEqual({ kind: "invalid", message: "Email or password is incorrect.", canRetry: false });
    expect(authFailure("conflict", "Exists.", false, true).kind).toBe("exists");
    expect(authFailure("internal_error", "boom", true, true).canRetry).toBe(true);
  });
});

describe("tools", () => {
  const plugin = (enabled: boolean, granted: string[]): PluginInfo => ({
    id: "dash-demo", name: "Dash demo tools", description: "d", version: "1", kind: "builtin",
    scopes: [{ id: "demo:read", description: "Read the clock", risk: "read" }],
    tools: [{ name: "current_time", qualifiedName: "dash-demo__current_time", description: "Time", scope: "demo:read", risk: "read", executable: true }],
    enabled, grantedScopes: granted,
  });
  it("maps the registry to Available / Connected / Requires permission / Disabled", () => {
    expect(toolConnection(plugin(false, []), true).state).toBe("Available");
    expect(toolConnection(plugin(true, ["demo:read"]), true).state).toBe("Connected");
    expect(toolConnection(plugin(true, []), true).state).toBe("Requires permission");
    expect(toolConnection(plugin(true, ["demo:read"]), false).state).toBe("Disabled");
  });
  it("labels tool use with names and outcomes only", () => {
    expect(toolUseLabel({ callId: "1", plugin: "dash-demo", tool: "text_stats", status: "ok", durationMs: 3 }, { "dash-demo": "Dash demo tools" })).toEqual({ title: "Used Text stats", detail: "Dash demo tools · finished in 3 ms", tone: "success" });
    expect(toolUseLabel({ callId: "1", plugin: "p", tool: "text_stats", status: null, durationMs: null }, {}).title).toBe("Using Text stats");
  });
});
