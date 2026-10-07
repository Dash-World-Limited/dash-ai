import { createHash } from "node:crypto";
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

/** Where at-most-once executions are claimed (the Store in production). */
export interface ExecutionLedger {
  claimToolExecution(claim: { keyHash: string; userId: string; createdAt: string }): Promise<boolean>;
  finishToolExecution(keyHash: string, status: string, finishedAt: string): Promise<void>;
}

export const DUPLICATE_TEXT = {
  callId: "This tool call repeats one already answered in this response, so it was not run again. Use the earlier result.",
  action: "This action was already carried out for this message, so it was not repeated.",
} as const;

const FAILURE_TEXT: Record<Exclude<ToolCallStatus, "ok" | "duplicate">, string> = {
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
    private readonly ledger?: ExecutionLedger,
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
      isError: status !== "ok" && status !== "duplicate",
      durationMs: Date.now() - started,
      argBytes,
    });
    const fail = (status: Exclude<ToolCallStatus, "ok" | "duplicate">, detail?: string) =>
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

    // At-most-once tools: claim the action before running it. A failed claim means it already ran
    // (or started and its outcome is unknown, e.g. the server restarted): never run it again.
    let claimed: string | undefined;
    if (entry.tool.idempotency === "per-message") {
      if (!this.ledger) return fail("denied", "This action cannot be run safely on this server.");
      const keyHash = executionKey(ctx, entry.qualifiedName, parsed.data);
      let first: boolean;
      try {
        first = await this.ledger.claimToolExecution({ keyHash, userId: ctx.userId, createdAt: ctx.now().toISOString() });
      } catch {
        return fail("error", "The action could not be recorded, so it was not run.");
      }
      if (!first) return done("duplicate", DUPLICATE_TEXT.action);
      claimed = keyHash;
    }
    const finish = (execution: ToolExecution): ToolExecution => {
      if (claimed) void this.ledger!.finishToolExecution(claimed, execution.status, ctx.now().toISOString()).catch(() => undefined);
      return execution;
    };

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
      if (outcome === "timeout") return finish(fail("timeout"));
      if (outcome === "cancelled") return finish(fail("cancelled"));
      if (!outcome.ok) {
        if (outcome.error instanceof ToolUserError) return finish(fail("error", outcome.error.message.slice(0, 300)));
        ctx.log.warn({ plugin, tool, errorName: outcome.error instanceof Error ? outcome.error.name : "unknown" }, "tool handler failed");
        return finish(fail("error"));
      }
      const text = typeof outcome.value === "string" ? outcome.value : safeStringify(outcome.value);
      return finish(done("ok", this.bound(text)));
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

/** JSON with object keys sorted, so equivalent arguments always produce the same key. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The at-most-once key: who, where, which user message, which tool, which (validated) arguments. */
export function executionKey(ctx: Pick<ExecutionContext, "userId" | "conversationId" | "turnId">, qualifiedName: string, args: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify([ctx.userId, ctx.conversationId, ctx.turnId, qualifiedName, canonicalJson(args)]))
    .digest("hex");
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
