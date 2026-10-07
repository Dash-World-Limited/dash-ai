import { z } from "zod";
import { ToolUserError, defineTool, type ToolPlugin } from "../src/tools/types.js";

export interface MockPluginProbe {
  /** Number of times each tool handler actually ran. */
  calls: Record<string, number>;
  /** Arguments each handler received (validated). */
  args: Record<string, unknown[]>;
  /** Abort observations for slow tools. */
  aborted: number;
}

/**
 * A MOCKED external plugin standing in for something like GitHub. It never touches the network
 * and holds no credentials: it returns canned data so tests can prove the plugin machinery.
 */
export function makeMockGithubPlugin(): { plugin: ToolPlugin; probe: MockPluginProbe } {
  const probe: MockPluginProbe = { calls: {}, args: {}, aborted: 0 };
  const seen = (name: string, args: unknown) => {
    probe.calls[name] = (probe.calls[name] ?? 0) + 1;
    (probe.args[name] ??= []).push(args);
  };
  const plugin: ToolPlugin = {
    id: "mock-github",
    name: "Mock GitHub",
    description: "A mocked external plugin used by tests. Returns canned data; no network, no credentials.",
    version: "0.0.1",
    kind: "external",
    scopes: [
      { id: "issues:read", description: "Read issues (mocked).", risk: "read" },
      { id: "issues:write", description: "Create issues (mocked).", risk: "write" },
    ],
    tools: [
      defineTool({
        name: "list_issues",
        description: "Lists open issues of a repository.",
        scope: "issues:read",
        risk: "read",
        input: z.object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), limit: z.number().int().min(1).max(5).optional() }),
        async execute(args) {
          seen("list_issues", args);
          return { repo: args.repo, issues: [{ number: 1, title: "Mocked issue one" }, { number: 2, title: "Mocked issue two" }].slice(0, args.limit ?? 5) };
        },
      }),
      defineTool({
        name: "create_issue",
        description: "Creates an issue in a repository.",
        scope: "issues:write",
        risk: "write",
        idempotency: "per-message",
        input: z.object({ repo: z.string(), title: z.string() }),
        async execute(args) {
          seen("create_issue", args);
          return "created (this must never run in this milestone)";
        },
      }),
      defineTool({
        name: "slow_lookup",
        description: "A lookup that never finishes on its own and ignores its abort signal.",
        scope: "issues:read",
        risk: "read",
        timeoutMs: 150,
        input: z.object({}),
        async execute(args, ctx) {
          seen("slow_lookup", args);
          ctx.signal.addEventListener("abort", () => (probe.aborted += 1), { once: true });
          return new Promise<string>(() => undefined); // never settles, even when aborted
        },
      }),
      defineTool({
        name: "add_label",
        description: "Adds a label to an issue (mocked). Stands in for a side-effecting tool: it runs at most once per user message.",
        scope: "issues:read",
        risk: "read",
        idempotency: "per-message",
        input: z.object({ issue: z.number().int().min(1), label: z.string().min(1).max(40) }),
        async execute(args) {
          seen("add_label", args);
          return { labelled: args.issue, label: args.label };
        },
      }),
      defineTool({
        name: "hang_until_aborted",
        description: "Waits until aborted (to exercise cancellation).",
        scope: "issues:read",
        risk: "read",
        timeoutMs: 60_000,
        input: z.object({}),
        async execute(args, ctx) {
          seen("hang_until_aborted", args);
          await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
          return "aborted";
        },
      }),
      defineTool({
        name: "explode",
        description: "Always fails with an internal error that contains sensitive-looking text.",
        scope: "issues:read",
        risk: "read",
        input: z.object({}),
        async execute(args) {
          seen("explode", args);
          throw new Error("connection to db.internal.example failed with password hunter2-SECRET");
        },
      }),
      defineTool({
        name: "polite_failure",
        description: "Fails with a message that is safe to show the model.",
        scope: "issues:read",
        risk: "read",
        input: z.object({}),
        async execute(args) {
          seen("polite_failure", args);
          throw new ToolUserError("Repository not found.");
        },
      }),
      defineTool({
        name: "big_output",
        description: "Returns a very large result.",
        scope: "issues:read",
        risk: "read",
        input: z.object({}),
        async execute(args) {
          seen("big_output", args);
          return "x".repeat(50_000);
        },
      }),
    ],
  };
  return { plugin, probe };
}
