import type { z } from "zod";
import type { ToolCallStatus } from "@dash-ai/contracts";
import { MAX_TOOL_TIMEOUT_MS, PluginRegistry, type OfferedTools } from "./registry.js";
import { ToolUserError, type ModelToolCall, type ToolContext, type ToolExecution } from "./types.js";

export const MAX_ARGUMENT_BYTES = 16 * 1024;

export interface ExecutorOptions {
  defaultTimeoutMs: number;
  maxResultChars: number;
}

export type ExecutionContext = Omit<ToolContext, "callId">;

const FAILURE_TEXT: Record<Exclude<ToolCallStatus, "ok">, string> = {
  invalid_arguments: "The tool call was rejected because its arguments were invalid.",
  denied: "That tool is not available in this conversation.",
  unknown_tool: "That tool does not exist.",
  timeout: "The tool took too long and was stopped.",
  error: "The tool failed. Continue without it or tell the user it is unavailable.",
  cancelled: "The tool call was cancelled.",
};

/**
 * The only path from model output to side effects. A model can *request* a tool by emitting a
 * structured call; this class decides whether anything runs. It checks, in order: that the tool
 * was offered to this request (registry + user permissions), that the call is not an
 * unexecutable (write) tool, that the arguments are bounded JSON that satisfies the tool's strict
 * schema, then runs the handler under a hard timeout and cancellation, bounds the output, and
 * converts every failure into a short generic message for the model. Text that merely looks like
 * a tool call never reaches this class: only structured calls from provider adapters do.
 */
export class ToolExecutor {
  constructor(
    private readonly registry: PluginRegistry,
    private readonly options: ExecutorOptions,
  ) {}

  async execute(call: ModelToolCall, offered: OfferedTools, ctx: ExecutionContext): Promise<ToolExecution> {
    const started = Date.now();
    const argBytes = Buffer.byteLength(call.argumentsJson, "utf8");
    const { plugin, tool } = labelOf(call.name);
    const done = (status: ToolCallStatus, content: string): ToolExecution => ({
      callId: call.id,
      name: call.name,
      plugin,
      tool,
      status,
      content,
      isError: status !== "ok",
      durationMs: Date.now() - started,
      argBytes,
    });
    const fail = (status: Exclude<ToolCallStatus, "ok">, detail?: string) =>
      done(status, detail ? `${FAILURE_TEXT[status]} ${detail}` : FAILURE_TEXT[status]);

    if (ctx.signal.aborted) return fail("cancelled");

    const entry = offered.get(call.name);
    if (!entry) {
      // Distinguish "never existed" from "exists but not offered to this user/request" only in the
      // audit status; the model gets a message that reveals nothing about what is installed.
      return fail(this.registry.findTool(call.name) ? "denied" : "unknown_tool");
    }
    if (!PluginRegistry.isExecutable(entry.tool)) return fail("denied");

    if (argBytes > MAX_ARGUMENT_BYTES) return fail("invalid_arguments", "The arguments are too large.");
    let raw: unknown;
    try {
      raw = call.argumentsJson.trim() === "" ? {} : JSON.parse(call.argumentsJson);
    } catch {
      return fail("invalid_arguments", "The arguments are not valid JSON.");
    }
    // `.strict()`: unknown properties are rejected rather than silently dropped.
    const parsed = entry.tool.input.strict().safeParse(raw);
    if (!parsed.success) return fail("invalid_arguments", describeIssues(parsed.error));

    const timeoutMs = Math.min(entry.tool.timeoutMs ?? this.options.defaultTimeoutMs, MAX_TOOL_TIMEOUT_MS);
    const controller = new AbortController();
    const onParentAbort = () => controller.abort("cancelled");
    ctx.signal.addEventListener("abort", onParentAbort, { once: true });
    let timer: NodeJS.Timeout | undefined;
    const interrupted = new Promise<"timeout" | "cancelled">((resolve) => {
      timer = setTimeout(() => {
        controller.abort("timeout");
        resolve("timeout");
      }, timeoutMs);
      controller.signal.addEventListener("abort", () => resolve(controller.signal.reason === "timeout" ? "timeout" : "cancelled"), { once: true });
    });

    try {
      const running = entry.tool
        .execute(parsed.data, { ...ctx, callId: call.id, signal: controller.signal })
        .then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
      // A handler that ignores its signal still cannot hold the response past the timeout.
      const outcome = await Promise.race([running, interrupted]);
      if (outcome === "timeout") return fail("timeout");
      if (outcome === "cancelled") return fail("cancelled");
      if (!outcome.ok) {
        if (outcome.error instanceof ToolUserError) return fail("error", outcome.error.message.slice(0, 300));
        ctx.log.warn({ plugin, tool, errorName: outcome.error instanceof Error ? outcome.error.name : "unknown" }, "tool handler failed");
        return fail("error");
      }
      const text = typeof outcome.value === "string" ? outcome.value : safeStringify(outcome.value);
      return done("ok", this.bound(text));
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onParentAbort);
    }
  }

  private bound(text: string): string {
    const max = this.options.maxResultChars;
    return text.length > max ? `${text.slice(0, max)}\n[output truncated: ${text.length - max} more characters]` : text;
  }
}

/** Audit labels for a model-supplied name: never store arbitrary model text. */
function labelOf(name: string): { plugin: string; tool: string } {
  const m = /^([a-z][a-z0-9-]{1,31})__([a-z][a-z0-9_]{1,47})$/.exec(name);
  return m ? { plugin: m[1]!, tool: m[2]! } : { plugin: "unknown", tool: "unknown" };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return "[unserialisable result]";
  }
}

/** Paths and zod issue codes only: never echoes the offending value back. */
function describeIssues(error: z.ZodError): string {
  const parts = error.issues.slice(0, 5).map((i) => {
    const path = i.path.length > 0 ? i.path.join(".") : "(arguments)";
    return `${path}: ${i.code === "unrecognized_keys" ? "unexpected property" : i.message.slice(0, 120)}`;
  });
  return parts.join("; ");
}
