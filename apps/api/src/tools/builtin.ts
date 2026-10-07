import { z } from "zod";
import { ToolUserError, defineTool, type ToolPlugin } from "./types.js";

/**
 * Harmless demonstration plugin that ships with Dash AI. It touches no network, file system,
 * database or credential, so it is a safe way to see tool calling work end to end.
 */
export const builtinPlugin: ToolPlugin = {
  id: "dash-demo",
  name: "Dash demo tools",
  description: "Harmless built-in tools that show how tool calling works: the current time and text statistics.",
  version: "1.0.0",
  kind: "builtin",
  scopes: [{ id: "demo:read", description: "Read the server clock and measure text you provide.", risk: "read" }],
  tools: [
    defineTool({
      name: "current_time",
      description: "Returns the current date and time, optionally in a given IANA time zone such as Africa/Lagos.",
      scope: "demo:read",
      risk: "read",
      input: z.object({ timeZone: z.string().min(1).max(64).optional() }),
      async execute({ timeZone }, ctx) {
        const now = ctx.now();
        let local: string | undefined;
        if (timeZone) {
          try {
            local = new Intl.DateTimeFormat("en-GB", { dateStyle: "full", timeStyle: "long", timeZone }).format(now);
          } catch {
            throw new ToolUserError(`"${timeZone.replace(/[^A-Za-z0-9_/+-]/g, "").slice(0, 40)}" is not a valid IANA time zone.`);
          }
        }
        return { utc: now.toISOString(), ...(timeZone ? { timeZone, local } : {}) };
      },
    }),
    defineTool({
      name: "text_stats",
      description: "Counts characters, words and lines in a piece of text.",
      scope: "demo:read",
      risk: "read",
      input: z.object({ text: z.string().max(20_000) }),
      async execute({ text }) {
        const trimmed = text.trim();
        return {
          characters: text.length,
          words: trimmed === "" ? 0 : trimmed.split(/\s+/).length,
          lines: text === "" ? 0 : text.split(/\r\n|\r|\n/).length,
        };
      },
    }),
  ],
};
