import { OpenAIAdapter } from "../src/providers/openai.js";
import { AnthropicAdapter } from "../src/providers/anthropic.js";
import { ProviderRegistry } from "../src/providers/registry.js";

/** What a scripted model decides to do for one request. */
export type ModelPlan =
  | { kind: "text"; text: string; /** Emit these deltas instead of splitting `text` in two. */ chunks?: string[] }
  | { kind: "tool"; name: string; args: unknown; preface?: string };

export interface RecordedRequest {
  url: string;
  body: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/**
 * SSE body as a real stream: events can be delayed, and aborting the request's signal errors the
 * stream the way a closed network connection would.
 */
const enc = (events: [string, unknown][], delayMs = 0, signal?: AbortSignal | null) => {
  const lines = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  if (delayMs === 0 && !signal) {
    return new Response(lines.join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
  }
  let i = 0;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (signal?.aborted) return controller.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (i >= lines.length) return controller.close();
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      if (signal?.aborted) return controller.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
      controller.enqueue(encoder.encode(lines[i++]!));
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
};

function pieces(plan: Extract<ModelPlan, { kind: "text" }>): string[] {
  return plan.chunks ?? [plan.text.slice(0, Math.ceil(plan.text.length / 2)), plan.text.slice(Math.ceil(plan.text.length / 2))];
}

function openaiResponse(plan: ModelPlan, model: string, id: number, delayMs: number, signal?: AbortSignal | null): Response {
  const usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15 };
  const events: [string, unknown][] = [
    ["response.created", { type: "response.created", sequence_number: 0, response: { id: `resp_${id}`, status: "in_progress" } }],
  ];
  const output: unknown[] = [];
  const delta = (text: string, n: number) =>
    events.push(["response.output_text.delta", { type: "response.output_text.delta", delta: text, item_id: "i", output_index: 0, content_index: 0, sequence_number: n, logprobs: [] }]);
  if (plan.kind === "text") {
    pieces(plan).forEach((piece, n) => delta(piece, n + 1));
  } else {
    if (plan.preface) delta(plan.preface, 1);
    output.push({ type: "function_call", id: `fc_${id}`, call_id: `call_oa_${id}`, name: plan.name, arguments: JSON.stringify(plan.args), status: "completed" });
  }
  events.push(["response.completed", { type: "response.completed", sequence_number: 9999, response: { id: `resp_${id}`, status: "completed", model, output, usage } }]);
  return enc(events, delayMs, signal);
}

function anthropicResponse(plan: ModelPlan, model: string, id: number, delayMs: number, signal?: AbortSignal | null): Response {
  const events: [string, unknown][] = [
    ["message_start", { type: "message_start", message: { id: `msg_${id}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } }],
  ];
  let index = 0;
  const text = (t: string) => {
    events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }]);
    events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: t } }]);
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
    index += 1;
  };
  if (plan.kind === "text") {
    for (const piece of pieces(plan)) text(piece);
  } else {
    if (plan.preface) text(plan.preface);
    const json = JSON.stringify(plan.args);
    events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: `toolu_${id}`, name: plan.name, input: {} } }]);
    // Arguments arrive as partial JSON fragments, as with the real API.
    const cut = Math.max(1, Math.floor(json.length / 2));
    for (const part of [json.slice(0, cut), json.slice(cut)]) {
      events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: part } }]);
    }
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
  }
  events.push(["message_delta", { type: "message_delta", delta: { stop_reason: plan.kind === "tool" ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 7 } }]);
  events.push(["message_stop", { type: "message_stop" }]);
  return enc(events, delayMs, signal);
}

export interface ScriptedProvider {
  requests: RecordedRequest[];
  fetch: typeof fetch;
}

/**
 * A stand-in for a provider's HTTP API. It speaks the real wire format (so the official SDK and
 * our adapter run unmodified) and lets a test script what the "model" does per request.
 */
export function scriptedProvider(
  kind: "openai" | "anthropic",
  plan: (req: RecordedRequest, n: number) => ModelPlan,
  servedModel = `served-${kind}`,
  options: { chunkDelayMs?: number } = {},
): ScriptedProvider {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const req: RecordedRequest = { url, body: JSON.parse(String(init?.body ?? "{}")) };
    requests.push(req);
    const decided = plan(req, requests.length);
    const delay = options.chunkDelayMs ?? 0;
    const signal = init?.signal;
    return kind === "openai"
      ? openaiResponse(decided, servedModel, requests.length, delay, signal)
      : anthropicResponse(decided, servedModel, requests.length, delay, signal);
  }) as typeof fetch;
  return { requests, fetch: fetchImpl };
}

/** Does this request already carry a tool result? (Wire-format check per provider.) */
export const hasToolResult = (kind: "openai" | "anthropic", req: RecordedRequest): boolean =>
  kind === "openai"
    ? (req.body.input as Array<{ type?: string }>).some((i) => i.type === "function_call_output")
    : (req.body.messages as Array<{ content: unknown }>).some(
        (m) => Array.isArray(m.content) && (m.content as Array<{ type: string }>).some((b) => b.type === "tool_result"),
      );

export function registryFor(openai?: ScriptedProvider, anthropic?: ScriptedProvider): ProviderRegistry {
  return new ProviderRegistry({
    ...(openai ? { openai: new OpenAIAdapter("sk-test-not-a-real-key", "cfg-openai", { fetch: openai.fetch, maxRetries: 0 }) } : {}),
    ...(anthropic ? { anthropic: new AnthropicAdapter("sk-ant-test-not-real", "cfg-claude", { fetch: anthropic.fetch, maxRetries: 0 }) } : {}),
  });
}
