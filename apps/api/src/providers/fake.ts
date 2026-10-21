import { setTimeout as sleep } from "node:timers/promises";
import type { BuiltinProviderId } from "@dash-ai/contracts";
import { ProviderError, isToolResultTurn, type ProviderAdapter, type ProviderChunk, type ProviderRequest } from "./types.js";

/**
 * Test triggers understood only by fake adapters (never by real providers):
 *   [[fake:error]] — fail with a retryable provider error
 *   [[fake:hang]]  — never produce output (exercises idle timeouts and cancellation)
 *   [[fake:slow]]  — stream slowly (exercises stop/cancel)
 *   [[fake:tool <qualified_name> <json>]] — emit one structured tool call, exactly as a model
 *                   could, whether or not that tool was offered (so tests can prove the backend,
 *                   not the model, decides what runs). After the result arrives it summarises it.
 *   [[fake:lookalike]] — answer with text that merely LOOKS like a tool call (must never execute).
 *   [[fake:ttfb]]  — wait two seconds before the first token (slow time to first byte)
 *   [[fake:stall]] — send the first words, then never send anything again (idle timeout mid-stream)
 *   [[fake:partial]] — send the first words, then fail as a broken connection (no retry: output was sent)
 *   [[fake:flaky]] — fail the first attempt for this prompt with a retryable error, then answer
 *   [[fake:down-<id>]] — this fake provider (e.g. down-openai) fails retryably; others answer (fallback)
 */
export const FAKE_TRIGGERS = {
  error: "[[fake:error]]",
  hang: "[[fake:hang]]",
  slow: "[[fake:slow]]",
  lookalike: "[[fake:lookalike]]",
  ttfb: "[[fake:ttfb]]",
  stall: "[[fake:stall]]",
  partial: "[[fake:partial]]",
  flaky: "[[fake:flaky]]",
} as const;
/** Prompts that already failed once under [[fake:flaky]] (bounded: test-only trigger). */
const flakySeen = new Set<string>();
const FAKE_TOOL = /\[\[fake:tool ([^\s\]]+)(?: (\{.*?\}))?\]\]/s;

type FakeProviderId = Extract<BuiltinProviderId, "openai" | "anthropic">;
const NAMES: Record<FakeProviderId, { display: string; company: string; keyVar: string; modelVar: string }> = {
  openai: { display: "OpenAI", company: "OpenAI", keyVar: "OPENAI_API_KEY", modelVar: "OPENAI_MODEL" },
  anthropic: { display: "Claude", company: "Anthropic", keyVar: "ANTHROPIC_API_KEY", modelVar: "ANTHROPIC_MODEL" },
};

/**
 * Deterministic stand-in for the two legacy demo providers. Used by tests, CI and server-side demo
 * mode. Bedrock deliberately has no fake twin: adding a real provider must not silently change the
 * established deterministic Demo Mode routing table.
 */
export class FakeAdapter implements ProviderAdapter {
  readonly demo = true;
  readonly displayName: string;
  readonly model: string;

  constructor(
    readonly id: FakeProviderId,
    private readonly delayMs = 25,
  ) {
    this.displayName = NAMES[id].display;
    this.model = `fake-${id}`;
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderChunk> {
    const lastUserTurn = [...request.messages].reverse().find((m) => m.role === "user");
    const last = lastUserTurn && "content" in lastUserTurn ? lastUserTurn.content : "";
    const lastTurn = request.messages[request.messages.length - 1];
    try {
      if (last.includes(FAKE_TRIGGERS.error)) {
        await sleep(this.delayMs, undefined, { signal: request.signal });
        throw new ProviderError("provider_error", `${this.displayName} (fake) was asked to fail for testing.`, true);
      }
      if (last.includes(`[[fake:down-${this.id}]]`)) {
        await sleep(this.delayMs, undefined, { signal: request.signal });
        throw new ProviderError("provider_error", `${this.displayName} (fake) is down for testing.`, true);
      }
      if (last.includes(FAKE_TRIGGERS.flaky)) {
        if (!flakySeen.has(last)) {
          if (flakySeen.size > 1_000) flakySeen.clear();
          flakySeen.add(last);
          await sleep(this.delayMs, undefined, { signal: request.signal });
          throw new ProviderError("provider_error", `${this.displayName} (fake) failed once for testing.`, true);
        }
        flakySeen.delete(last);
      }
      if (last.includes(FAKE_TRIGGERS.ttfb)) await sleep(2_000, undefined, { signal: request.signal });
      if (last.includes(FAKE_TRIGGERS.stall) || last.includes(FAKE_TRIGGERS.partial)) {
        await sleep(this.delayMs, undefined, { signal: request.signal });
        yield { type: "text", text: "Demonstration answer " };
        if (last.includes(FAKE_TRIGGERS.partial)) throw new ProviderError("provider_error", `${this.displayName} (fake) connection broke for testing.`, true);
        await sleep(24 * 60 * 60 * 1000, undefined, { signal: request.signal });
      }
      if (last.includes(FAKE_TRIGGERS.hang)) {
        await sleep(24 * 60 * 60 * 1000, undefined, { signal: request.signal });
      }
      if (lastTurn && isToolResultTurn(lastTurn)) {
        const summary = lastTurn.results.map((r) => `${r.name} → ${r.isError ? "error: " : ""}${r.content}`).join(" | ");
        const text = `Demonstration answer from DASH AI. The tool layer returned: ${summary}`;
        yield { type: "text", text };
        yield { type: "finish", finishReason: "stop", usage: { inputTokens: approxTokens(request), outputTokens: Math.ceil(text.length / 4) } };
        return;
      }
      const toolMatch = FAKE_TOOL.exec(last);
      if (toolMatch && lastTurn && !isToolResultTurn(lastTurn)) {
        yield { type: "text", text: "Using a tool. " };
        yield { type: "tool_calls", calls: [{ id: `fake_call_${this.id}`, name: toolMatch[1]!, argumentsJson: toolMatch[2] ?? "{}" }] };
        yield { type: "finish", finishReason: "stop", usage: { inputTokens: approxTokens(request), outputTokens: 8 } };
        return;
      }
      if (last.includes(FAKE_TRIGGERS.lookalike)) {
        const text = '{"tool_call":{"name":"dash-demo__current_time","arguments":{}}} <tool_call>dash-demo__text_stats</tool_call>';
        yield { type: "text", text };
        yield { type: "finish", finishReason: "stop", usage: { inputTokens: approxTokens(request), outputTokens: 20 } };
        return;
      }
      const delay = last.includes(FAKE_TRIGGERS.slow) ? Math.max(this.delayMs, 150) : this.delayMs;
      const text = this.compose(request, last);
      for (const piece of text.match(/\S+\s*|\s+/g) ?? []) {
        if (delay > 0) await sleep(delay, undefined, { signal: request.signal });
        else if (request.signal.aborted) throw request.signal.reason;
        yield { type: "text", text: piece };
      }
      yield {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: approxTokens(request), outputTokens: Math.ceil(text.length / 4) },
      };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if (request.signal.aborted) {
        throw request.signal.reason === "timeout"
          ? new ProviderError("provider_timeout", `${this.displayName} took too long to respond.`, true)
          : new ProviderError("cancelled", "Generation was stopped.", false);
      }
      throw err;
    }
  }

  /** Consumer-visible text: it speaks as DASH AI and never names an AI provider (see publicSurface.ts). */
  private compose(request: ProviderRequest, lastUserMessage: string): string {
    const earlier = request.messages.length - 1;
    const hasDocument = lastUserMessage.includes("<document ");
    return [
      "**Demonstration answer from DASH AI.** This text was produced by DASH AI's built-in demonstration engine; " +
        "no AI service received your prompt.",
      "",
      `Your message was ${lastUserMessage.length.toLocaleString("en-US")} characters long` +
        (hasDocument ? " and included extracted document text" : "") +
        `, with ${earlier} earlier message${earlier === 1 ? "" : "s"} available as context.`,
      "",
      "What works in this mode:",
      "",
      "- Streaming, stopping and regenerating behave exactly as they will with live answers.",
      "- Usage recording and conversation history are real.",
      "- Real answers start once the server operator connects DASH AI's AI infrastructure.",
    ].join("\n");
  }
}

function approxTokens(request: ProviderRequest): number {
  const chars =
    request.system.length +
    request.messages.reduce((sum, m) => sum + ("content" in m ? m.content.length : m.results.reduce((n, r) => n + r.content.length, 0)), 0);
  return Math.ceil(chars / 4);
}
