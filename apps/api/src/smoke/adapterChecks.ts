import type { ProviderChunk, ProviderAdapter, ProviderTurn } from "../providers/types.js";
import { ProviderError } from "../providers/types.js";
import { ToolExecutor } from "../tools/executor.js";
import { ToolRuntime } from "../tools/runtime.js";
import { CheckFailure, check, skipped, timed, type CheckResult } from "./report.js";

const SYSTEM = "You are a terse test responder. Follow the instruction exactly.";
const MAX_TOKENS = 400;

interface Collected {
  text: string;
  chunks: number;
  firstTextMs: number | null;
  totalMs: number;
  finish: Extract<ProviderChunk, { type: "finish" }> | undefined;
  calls: Extract<ProviderChunk, { type: "tool_calls" }>["calls"];
  continuation?: unknown;
}

async function collect(adapter: ProviderAdapter, messages: ProviderTurn[], extra: Pick<Parameters<ProviderAdapter["stream"]>[0], "tools" | "toolChoice"> & { maxOutputTokens?: number } = {}): Promise<Collected> {
  const started = Date.now();
  const out: Collected = { text: "", chunks: 0, firstTextMs: null, totalMs: 0, finish: undefined, calls: [] };
  for await (const chunk of adapter.stream({
    system: SYSTEM,
    messages,
    maxOutputTokens: extra.maxOutputTokens ?? 256,
    signal: AbortSignal.timeout(60_000),
    ...(extra.tools ? { tools: extra.tools, ...(extra.toolChoice ? { toolChoice: extra.toolChoice } : {}) } : {}),
  })) {
    if (chunk.type === "text") {
      out.text += chunk.text;
      out.chunks += 1;
      out.firstTextMs ??= Date.now() - started;
    } else if (chunk.type === "tool_calls") {
      out.calls = chunk.calls;
      out.continuation = chunk.continuation;
    }
    else out.finish = chunk;
  }
  out.totalMs = Date.now() - started;
  return out;
}

export interface AdapterCheckOptions {
  /** Skip the tool round trip (it uses a harmless built-in tool but costs two extra requests). */
  skipTools?: boolean;
  /** How long cancellation may take to take effect. */
  cancelWithinMs?: number;
}

/**
 * Verifies one real provider adapter: a normal response, streaming, provider/model metadata,
 * cancellation, and a tool-calling round trip through the backend tool layer.
 * Each check uses tiny fixed prompts and bounded output.
 */
export async function runAdapterChecks(adapter: ProviderAdapter, options: AdapterCheckOptions = {}): Promise<CheckResult[]> {
  const id = adapter.id;
  const results: CheckResult[] = [];
  let metaSource: Collected | undefined;

  results.push(
    await timed(id, "normal response", async () => {
      const r = await collect(adapter, [{ role: "user", content: "Reply with exactly one word: pong" }]);
      metaSource = r;
      check(r.text.trim().length > 0, "the answer was empty");
      check(r.text.toLowerCase().includes("pong"), "the answer did not follow the instruction");
      check(r.finish?.finishReason === "stop", `finished with "${r.finish?.finishReason}" instead of "stop" (raise the token limit for reasoning models?)`);
      const u = r.finish.usage;
      check(typeof u.inputTokens === "number" && u.inputTokens > 0, "input token usage was not reported");
      check(typeof u.outputTokens === "number" && u.outputTokens > 0, "output token usage was not reported");
      return `chars=${r.text.trim().length} in=${u.inputTokens} out=${u.outputTokens} finish=stop`;
    }),
  );

  results.push(
    await timed(id, "streaming", async () => {
      const r = await collect(adapter, [{ role: "user", content: "Count from 1 to 15 separated by single spaces. No other text." }]);
      check(r.chunks >= 2, `the answer arrived in ${r.chunks} piece(s); expected incremental streaming`);
      check(r.firstTextMs !== null && r.firstTextMs < r.totalMs, "the first text did not arrive before the stream finished");
      check(r.finish?.finishReason === "stop", "the stream did not finish cleanly");
      return `chunks=${r.chunks} firstTextMs=${r.firstTextMs} totalMs=${r.totalMs}`;
    }),
  );

  results.push(
    await timed(id, "provider/model metadata", async () => {
      const served = metaSource?.finish?.servedModel;
      check(served, "the provider did not report which model served the request");
      check(adapter.model.length > 0, "no model is configured");
      return served === adapter.model ? `model=${adapter.model}` : `configured=${adapter.model} served=${served} (alias resolved by the provider)`;
    }),
  );

  results.push(
    await timed(id, "cancellation", async () => {
      const controller = new AbortController();
      const started = Date.now();
      let cancelledAt = 0;
      let sawText = false;
      try {
        for await (const chunk of adapter.stream({
          system: SYSTEM,
          messages: [{ role: "user", content: "Write the numbers from 1 to 400, one per line." }],
          maxOutputTokens: MAX_TOKENS,
          signal: controller.signal,
        })) {
          if (chunk.type === "text" && !sawText) {
            sawText = true;
            cancelledAt = Date.now();
            controller.abort("cancelled");
          }
        }
      } catch (err) {
        check(err instanceof ProviderError && err.code === "cancelled", "aborting did not surface as a clean cancellation");
        const lag = Date.now() - cancelledAt;
        check(lag <= (options.cancelWithinMs ?? 5_000), `cancellation took ${lag} ms to take effect`);
        return `first text after ${cancelledAt - started} ms, stopped ${lag} ms after cancel`;
      }
      throw new CheckFailure("the response finished before cancellation could be exercised");
    }),
  );

  if (options.skipTools) {
    results.push(skipped(id, "tool round trip", "skipped by --skip-tools"));
  } else {
    results.push(
      await timed(id, "tool round trip", async () => {
        const registry = ToolRuntime.defaultRegistry();
        const offered = registry.offeredFor([{ pluginId: "dash-demo", enabled: true, grantedScopes: ["demo:read"], updatedAt: new Date().toISOString() }]);
        const executor = new ToolExecutor(registry, { defaultTimeoutMs: 5_000, maxResultChars: 2_000 });
        const user: ProviderTurn = {
          role: "user",
          content: 'Use the text_stats tool on the text "alpha beta gamma" and then tell me how many words it has.',
        };
        const first = await collect(adapter, [user], { tools: offered.list() });
        check(first.calls.length >= 1, "the model did not request a tool call");
        const call = first.calls[0]!;
        check(call.name === "dash-demo__text_stats", "the model called an unexpected tool");
        const execution = await executor.execute(call, offered, {
          userId: "smoke", conversationId: "smoke-conversation", messageId: "smoke-message", provider: adapter.id,
          signal: AbortSignal.timeout(10_000), now: () => new Date(),
          log: { warn: () => undefined, info: () => undefined, error: () => undefined } as never,
        });
        check(execution.status === "ok", `the backend refused or failed the tool call (${execution.status})`);
        const second = await collect(
          adapter,
          [
            user,
            // Replayed exactly like the orchestrator does (thinking blocks / encrypted reasoning included).
            { role: "assistant", content: first.text, toolCalls: first.calls, ...(first.continuation !== undefined ? { continuation: first.continuation } : {}) },
            { role: "tool", results: [{ callId: call.id, name: call.name, content: execution.content, isError: false }] },
          ],
          // The same tools with tool use switched off, exactly like the orchestrator's last round.
          { tools: offered.list(), toolChoice: "none" },
        );
        check(second.calls.length === 0, "the model requested a tool although tool use was switched off");
        check(second.text.includes("3"), "the final answer did not use the tool result");
        check(second.finish?.finishReason === "stop", "the final answer did not finish cleanly");
        return `call=${call.name} status=ok rounds=2`;
      }),
    );
  }
  return results;
}
