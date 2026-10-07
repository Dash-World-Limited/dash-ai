import { AssistantMode, ProviderId, SMART_ROUTING } from "@dash-ai/contracts";
import { z } from "zod";

/**
 * What a request asks DASH AI to do. Every product surface routes through the same DASH Intelligence
 * Router with one of these: Chat today; Documents, Research, Reports, Editing and Automates use it as
 * they move server-side; Graphics, Tools workflows and Voice are declared so routing exists before the
 * capability does (a request for a capability no provider has is refused honestly, never faked).
 */
export const TaskType = z.enum([
  "chat",
  "documents",
  "research",
  "graphics",
  "reports",
  "editing",
  "tools",
  "automation",
  "voice",
  "workflow",
]);
export type TaskType = z.infer<typeof TaskType>;

/** What a provider (as configured on this server) can do. Requests list the ones they need. */
export const Capability = z.enum([
  "text",
  "long_context",
  "tool_use",
  "vision",
  "image_generation",
  "speech_input",
  "speech_output",
  "structured_output",
]);
export type Capability = z.infer<typeof Capability>;

/** How a request should trade quality against speed and cost. A future per-user preference. */
export const RoutePreference = z.enum(["balanced", "quality", "speed", "economy"]);
export type RoutePreference = z.infer<typeof RoutePreference>;

const Score = z.number().min(0).max(1);

/**
 * One provider as the router sees it. Quality is keyed by route key: "<task>:<mode>", then "<task>",
 * then "default" (the most specific key present wins). Costs are relative prices per million tokens
 * (any consistent unit; null = unknown, treated as neutral).
 */
export const ProviderProfile = z.object({
  enabled: z.boolean().default(true),
  capabilities: z.array(Capability).min(1),
  contextTokens: z.number().int().positive(),
  costPerMillionInput: z.number().nonnegative().nullable().default(null),
  costPerMillionOutput: z.number().nonnegative().nullable().default(null),
  quality: z.record(z.string(), Score).default({}),
});
export type ProviderProfile = z.infer<typeof ProviderProfile>;

export const Weights = z.object({ quality: Score, reliability: Score, latency: Score, cost: Score });
export type Weights = z.infer<typeof Weights>;

const Factor = z.number().min(0).max(10);
/** Multipliers a route preference applies to a task's weights (1 = unchanged). */
export const Multipliers = z.object({ quality: Factor, reliability: Factor, latency: Factor, cost: Factor });
export type Multipliers = z.infer<typeof Multipliers>;

export const TaskPolicy = z.object({
  /** Capabilities every request of this task needs, on top of what the request itself asks for. */
  requires: z.array(Capability).default(["text"]),
  weights: Weights,
});
export type TaskPolicy = z.infer<typeof TaskPolicy>;

export const RouterPolicy = z.object({
  providers: z.partialRecord(ProviderId, ProviderProfile),
  tasks: z.record(TaskType, TaskPolicy),
  /** Weight multipliers applied on top of a task's weights for a route preference. */
  preferences: z.record(RoutePreference, Multipliers),
  circuit: z.object({
    /** Consecutive retryable failures that move a provider to the back of every route. */
    failureThreshold: z.number().int().min(1).max(100),
    /** How long it stays there before it is tried first again. */
    cooldownMs: z.number().int().min(1_000).max(3_600_000),
  }),
  /** Smoothing for observed reliability and latency (exponentially weighted; higher = reacts faster). */
  smoothing: z.number().min(0.01).max(1),
});
export type RouterPolicy = z.infer<typeof RouterPolicy>;

const BALANCED: Weights = { quality: 0.6, reliability: 0.3, latency: 0.07, cost: 0.03 };

/**
 * Starting quality per route. The chat modes reproduce the shared preference table (SMART_ROUTING,
 * also used by Android Demo Mode), so with healthy providers chat routes exactly as before: the
 * preferred provider scores 0.9, the next 0.85. Health, latency and cost can then reorder them.
 * These are starting judgements, not permanent rules: an operator overrides any of them with
 * ROUTER_POLICY, and later milestones can feed measured quality back in.
 */
function defaultQuality(provider: ProviderId): Record<string, number> {
  const quality: Record<string, number> = { default: 0.8 };
  for (const mode of AssistantMode.options) {
    const order = SMART_ROUTING[mode];
    const rank = order.indexOf(provider);
    quality[`chat:${mode}`] = rank === 0 ? 0.9 : rank === 1 ? 0.85 : 0.8;
  }
  // Long, structured writing and close reading of documents start on the documents/writing preference;
  // research starts on the research preference. Automations inherit their mode's chat route.
  quality.documents = quality["chat:documents"]!;
  quality.reports = quality["chat:writing"]!;
  quality.editing = quality["chat:writing"]!;
  quality.research = quality["chat:research"]!;
  return quality;
}

export const DEFAULT_POLICY: RouterPolicy = {
  providers: {
    openai: {
      enabled: true,
      capabilities: ["text", "long_context", "tool_use", "structured_output"],
      contextTokens: 128_000,
      costPerMillionInput: null,
      costPerMillionOutput: null,
      quality: defaultQuality("openai"),
    },
    anthropic: {
      enabled: true,
      capabilities: ["text", "long_context", "tool_use", "structured_output"],
      contextTokens: 200_000,
      costPerMillionInput: null,
      costPerMillionOutput: null,
      quality: defaultQuality("anthropic"),
    },
  },
  tasks: {
    chat: { requires: ["text"], weights: BALANCED },
    documents: { requires: ["text", "long_context"], weights: BALANCED },
    research: { requires: ["text"], weights: BALANCED },
    // No provider is configured with image generation yet: graphics requests are refused, not faked.
    graphics: { requires: ["image_generation"], weights: BALANCED },
    reports: { requires: ["text", "long_context"], weights: BALANCED },
    editing: { requires: ["text"], weights: BALANCED },
    tools: { requires: ["text", "tool_use"], weights: BALANCED },
    // Nobody is waiting on a scheduled run: reliability and cost matter more than speed.
    automation: { requires: ["text"], weights: { quality: 0.55, reliability: 0.35, latency: 0, cost: 0.1 } },
    voice: { requires: ["speech_input", "speech_output"], weights: { quality: 0.4, reliability: 0.3, latency: 0.3, cost: 0 } },
    workflow: { requires: ["text", "tool_use"], weights: BALANCED },
  },
  preferences: {
    balanced: { quality: 1, reliability: 1, latency: 1, cost: 1 },
    quality: { quality: 1.5, reliability: 1, latency: 0.5, cost: 0.25 },
    speed: { quality: 0.8, reliability: 1, latency: 3, cost: 1 },
    economy: { quality: 0.8, reliability: 1, latency: 1, cost: 4 },
  },
  circuit: { failureThreshold: 3, cooldownMs: 60_000 },
  smoothing: 0.2,
};

/** A partial policy an operator supplies (ROUTER_POLICY); merged over the defaults per provider and task. */
const PolicyOverride = z.object({
  providers: z.partialRecord(ProviderId, ProviderProfile.partial()).optional(),
  tasks: z.partialRecord(TaskType, TaskPolicy.partial()).optional(),
  preferences: z.partialRecord(RoutePreference, Multipliers).optional(),
  circuit: RouterPolicy.shape.circuit.partial().optional(),
  smoothing: RouterPolicy.shape.smoothing.optional(),
});

export class PolicyError extends Error {}

/** The defaults, with an operator's JSON override merged in. Throws PolicyError naming the bad path (never values). */
export function loadPolicy(json: string | undefined): RouterPolicy {
  if (!json) return DEFAULT_POLICY;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new PolicyError("ROUTER_POLICY is not valid JSON.");
  }
  const parsed = PolicyOverride.safeParse(raw);
  if (!parsed.success) {
    throw new PolicyError(`ROUTER_POLICY is invalid: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const o = parsed.data;
  const providers = { ...DEFAULT_POLICY.providers };
  for (const id of ProviderId.options) {
    const base = providers[id];
    const patch = o.providers?.[id];
    if (!patch) continue;
    if (!base) {
      const full = ProviderProfile.safeParse(patch);
      if (!full.success) throw new PolicyError(`ROUTER_POLICY providers.${id} needs capabilities and contextTokens.`);
      providers[id] = full.data;
    } else {
      providers[id] = { ...base, ...patch, quality: { ...base.quality, ...patch.quality } };
    }
  }
  const tasks = { ...DEFAULT_POLICY.tasks };
  for (const t of TaskType.options) {
    const patch = o.tasks?.[t];
    if (patch) tasks[t] = { ...tasks[t], ...patch };
  }
  const merged = RouterPolicy.safeParse({
    providers,
    tasks,
    preferences: { ...DEFAULT_POLICY.preferences, ...o.preferences },
    circuit: { ...DEFAULT_POLICY.circuit, ...o.circuit },
    smoothing: o.smoothing ?? DEFAULT_POLICY.smoothing,
  });
  if (!merged.success) {
    throw new PolicyError(`ROUTER_POLICY is invalid: ${merged.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return merged.data;
}

/** Route keys from most to least specific: "chat:writing", "chat", "default". */
export function routeKeys(task: TaskType, mode?: AssistantMode): string[] {
  return [...(mode ? [`${task}:${mode}`] : []), task, ...(task === "automation" && mode ? [`chat:${mode}`] : []), "default"];
}

export function qualityFor(profile: ProviderProfile, keys: readonly string[]): number {
  for (const key of keys) {
    const q = profile.quality[key];
    if (q !== undefined) return q;
  }
  return 0.5;
}
