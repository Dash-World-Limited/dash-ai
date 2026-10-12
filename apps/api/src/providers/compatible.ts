import { BUILTIN_PROVIDER_IDS, ProviderId, type Usage } from "@dash-ai/contracts";
import OpenAI from "openai";
import type { ChatCompletionChunk, ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import { z } from "zod";
import { Capability, PricingClass, PrivacyClass, TaskType, type ProviderProfile } from "../intelligence/policy.js";
import { ProviderQuotaConfig } from "../intelligence/quota.js";
import type { ModelToolCall, NormalizedTool } from "../tools/types.js";
import {
  isToolCallTurn,
  isToolResultTurn,
  toProviderError,
  type ProviderAdapter,
  type ProviderChunk,
  type ProviderRequest,
  type ProviderTurn,
} from "./types.js";

/**
 * One approved third-party inference API that speaks the OpenAI Chat Completions protocol, registered
 * by configuration (COMPATIBLE_PROVIDERS) instead of code. Only the NAME of the environment variable
 * holding its key is configured; the key itself stays in the server's secret store. Every field that
 * decides who may receive what (privacy, pricing) must be stated by the operator; a provider is
 * `unapproved` (receives nothing) until approved individually.
 */
export const CompatibleProviderConfig = z
  .object({
    id: ProviderId.refine((id) => !(BUILTIN_PROVIDER_IDS as readonly string[]).includes(id), "must not reuse a built-in provider id"),
    /** Internal name for logs and the operator view. Never shown to consumers. */
    displayName: z.string().min(1).max(60).optional(),
    baseUrl: z.url(),
    /** Name of the environment variable that holds the API key (for example EXAMPLE_API_KEY). */
    apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]{1,60}_API_KEY$/, "must be an environment variable name ending in _API_KEY"),
    model: z.string().min(1).max(200),
    enabled: z.boolean().default(true),
    /** Per-request time limit for this provider (the server-wide PROVIDER_TIMEOUT_MS still applies). */
    timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
    capabilities: z.array(Capability).min(1).default(["text"]),
    contextTokens: z.number().int().positive().max(10_000_000),
    maxOutputTokens: z.number().int().positive().max(1_000_000).optional(),
    tasks: z.array(TaskType).min(1).nullable().default(null),
    plans: z.array(z.string().min(1).max(40)).min(1).nullable().default(null),
    /** Starting quality on every route (0..1). Lower than the built-in providers' unless measured. */
    quality: z.number().min(0).max(1).default(0.7),
    pricing: PricingClass,
    /** USD list prices per million tokens; free providers may leave them at 0. */
    inputPerMillion: z.number().nonnegative().max(10_000).nullable().default(null),
    outputPerMillion: z.number().nonnegative().max(10_000).nullable().default(null),
    privacy: PrivacyClass.default("unapproved"),
    quota: ProviderQuotaConfig.optional(),
    /** Ask for token usage at the end of the stream (stream_options.include_usage). Turn off for APIs that reject it. */
    streamUsage: z.boolean().default(true),
  })
  .strict();
export type CompatibleProviderConfig = z.infer<typeof CompatibleProviderConfig>;

export const CompatibleProviders = z
  .array(CompatibleProviderConfig)
  .max(20)
  .refine((list) => new Set(list.map((p) => p.id)).size === list.length, "provider ids must be unique");

/** The router's view of a compatible provider. */
export function compatibleProfile(c: CompatibleProviderConfig): ProviderProfile {
  return {
    enabled: c.enabled,
    capabilities: c.capabilities,
    contextTokens: c.contextTokens,
    costPerMillionInput: c.inputPerMillion,
    costPerMillionOutput: c.outputPerMillion,
    quality: { default: c.quality },
    privacy: c.privacy,
    pricing: c.pricing,
    tasks: c.tasks,
    plans: c.plans,
    inputModalities: ["text"],
    outputModalities: ["text"],
    streaming: true,
  };
}

export interface CompatibleAdapterOptions {
  /** Injected fetch (tests). */
  fetch?: typeof fetch;
}

/** An OpenAI Chat Completions-compatible API behind the common provider interface. */
export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly model: string;
  readonly demo = false;
  private readonly client: OpenAI;

  constructor(
    private readonly config: CompatibleProviderConfig,
    apiKey: string,
    options: CompatibleAdapterOptions = {},
  ) {
    this.id = config.id;
    this.displayName = config.displayName ?? config.id;
    this.model = config.model;
    this.client = new OpenAI({
      apiKey,
      baseURL: config.baseUrl,
      // Retries happen once, in the orchestrator (bounded, cancellable, counted).
      maxRetries: 0,
      ...(config.timeoutMs ? { timeout: config.timeoutMs } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderChunk> {
    const tools = request.tools && request.tools.length > 0 ? request.tools : undefined;
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let usage: Usage = { inputTokens: null, outputTokens: null };
    let cachedInputTokens: number | null = null;
    let providerCostUsd: number | null = null;
    let finish: string | null = null;
    let servedModel: string | null = null;
    try {
      const stream = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: toChatMessages(request.system, request.messages),
          stream: true,
          max_tokens: Math.min(request.maxOutputTokens, this.config.maxOutputTokens ?? request.maxOutputTokens),
          ...(this.config.streamUsage ? { stream_options: { include_usage: true } } : {}),
          // The same tools every round; tool use is switched off with tool_choice, never by dropping them.
          ...(tools ? { tools: toChatTools(tools), tool_choice: request.toolChoice === "none" ? ("none" as const) : ("auto" as const) } : {}),
        },
        { signal: request.signal },
      );
      for await (const chunk of stream as AsyncIterable<ChatCompletionChunk>) {
        servedModel = chunk.model || servedModel;
        if (chunk.usage) {
          usage = { inputTokens: chunk.usage.prompt_tokens ?? null, outputTokens: chunk.usage.completion_tokens ?? null };
          cachedInputTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? null;
          // Some compatible APIs report their own charge for the request.
          const cost = (chunk.usage as { cost?: unknown }).cost;
          if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) providerCostUsd = cost;
        }
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta;
        if (typeof delta?.content === "string" && delta.content !== "") yield { type: "text", text: delta.content };
        for (const call of delta?.tool_calls ?? []) {
          const current = calls.get(call.index) ?? { id: "", name: "", args: "" };
          if (call.id) current.id = call.id;
          if (call.function?.name) current.name += call.function.name;
          if (call.function?.arguments) current.args += call.function.arguments;
          calls.set(call.index, current);
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
      // The SDK ends the iteration silently when the request is aborted: that is a cancellation or timeout.
      if (request.signal.aborted) throw request.signal.reason ?? new Error("aborted");
    } catch (err) {
      throw toProviderError(this.displayName, err, request.signal);
    }
    if (calls.size > 0) {
      const toolCalls: ModelToolCall[] = [...calls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, c]) => ({ id: c.id || `call-${index}`, name: c.name, argumentsJson: c.args.trim() === "" ? "{}" : c.args }));
      yield { type: "tool_calls", calls: toolCalls };
    }
    yield {
      type: "finish",
      finishReason: finish === "length" ? "length" : finish === "content_filter" ? "refusal" : "stop",
      usage,
      servedModel,
      cachedInputTokens,
      providerCostUsd,
    };
  }
}

/** Provider-neutral turns → Chat Completions messages. Tool turns only ever replay to this provider. */
export function toChatMessages(system: string, turns: readonly ProviderTurn[]): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [{ role: "system", content: system }];
  for (const turn of turns) {
    if (isToolResultTurn(turn)) {
      for (const r of turn.results) out.push({ role: "tool", tool_call_id: r.callId, content: r.content === "" ? "(no output)" : r.content });
    } else if (isToolCallTurn(turn)) {
      out.push({
        role: "assistant",
        content: turn.content === "" ? null : turn.content,
        tool_calls: turn.toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.argumentsJson } })),
      });
    } else {
      out.push({ role: turn.role, content: turn.content });
    }
  }
  return out;
}

export function toChatTools(tools: readonly NormalizedTool[]): ChatCompletionTool[] {
  return tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
}
