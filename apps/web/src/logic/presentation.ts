/**
 * The web app's UI decisions, kept free of React so they are unit-tested. They mirror the Android
 * core (`apps/android/core/.../presentation`), so both apps behave the same.
 */
import type { AssistantMode, ConversationMessage, ModelChoice, PluginInfo, ProviderId } from "@dash-ai/contracts";
import { SMART_ROUTING } from "@dash-ai/contracts";

// ---- Modes and providers ----------------------------------------------------------------------

export interface ModeInfo {
  label: string;
  tagline: string;
  hint: string;
  suggestions: string[];
  limitation?: string;
}

export const MODES: Record<AssistantMode, ModeInfo> = {
  general: {
    label: "General",
    tagline: "Everyday questions, ideas and conversation.",
    hint: "Ask DASH AI anything…",
    suggestions: [
      "Explain a complex topic to me in simple terms",
      "Help me plan my week around three priorities",
      "Give me five creative ideas for a weekend project",
    ],
  },
  business: {
    label: "Business",
    tagline: "Plans, strategy, pricing and operations.",
    hint: "Describe the business goal or decision…",
    suggestions: [
      "Draft a one-page business plan for a premium coffee kiosk",
      "Create a SWOT analysis for launching a delivery service",
      "Outline a 90-day go-to-market plan with milestones",
    ],
  },
  writing: {
    label: "Writing",
    tagline: "Professional drafts, edits and tone.",
    hint: "What should we write or improve?",
    suggestions: [
      "Write a warm, professional email introducing our company",
      "Rewrite this paragraph to sound confident and concise",
      "Turn my notes into a polished executive summary",
    ],
  },
  documents: {
    label: "Documents",
    tagline: "Summaries and answers from your files.",
    hint: "Attach a document, then ask about it…",
    suggestions: [
      "Summarise the attached document in five bullet points",
      "List the key dates, amounts and obligations in this file",
      "What are the main risks mentioned in this document?",
    ],
    limitation: "Text is extracted from TXT, DOCX and text-based PDFs. Image and scanned-PDF analysis is not available yet.",
  },
  research: {
    label: "Research",
    tagline: "Structured research from built-in model knowledge.",
    hint: "What would you like to research?",
    suggestions: [
      "Give me a structured overview of the electric vehicle market",
      "Compare three approaches to remote team management",
      "Create a research plan for entering a new market",
    ],
    limitation: "Live web research is not connected. Answers come from the model's built-in knowledge and may be out of date.",
  },
};

export const MODE_ORDER: AssistantMode[] = ["general", "business", "writing", "documents", "research"];
export const CHOICE_ORDER: ModelChoice[] = ["smart", "openai", "claude", "compare"];

export const PROVIDER_NAME: Record<ProviderId, string> = { openai: "OpenAI", anthropic: "Claude" };
export const CHOICE_LABEL: Record<ModelChoice, string> = { smart: "Dash Smart", openai: "OpenAI", claude: "Claude", compare: "Compare" };

export function choiceForProvider(p: ProviderId): ModelChoice {
  return p === "openai" ? "openai" : "claude";
}

export interface ProviderAvailability {
  configured: ReadonlySet<ProviderId>;
  models: Partial<Record<ProviderId, string>>;
  error?: string;
}

export const ALL_AVAILABLE: ProviderAvailability = { configured: new Set<ProviderId>(["openai", "anthropic"]), models: {} };

export function isAvailable(a: ProviderAvailability, choice: ModelChoice): boolean {
  switch (choice) {
    case "smart":
      return a.configured.size > 0;
    case "openai":
      return a.configured.has("openai");
    case "claude":
      return a.configured.has("anthropic");
    case "compare":
      return a.configured.has("openai") && a.configured.has("anthropic");
  }
}

const DESCRIPTION: Record<ModelChoice, string> = {
  smart: "Automatic. DASH AI chooses OpenAI or Claude for the mode you are in.",
  openai: "Every message in this chat goes to OpenAI.",
  claude: "Every message in this chat goes to Anthropic's Claude.",
  compare: "Asks OpenAI and Claude and shows both answers. Uses two requests.",
};

export interface ProviderOption {
  choice: ModelChoice;
  title: string;
  description: string;
  selected: boolean;
  available: boolean;
  unavailableReason: string | null;
  model: string | null;
}

export function providerOptions(a: ProviderAvailability, selected: ModelChoice, demo: boolean): ProviderOption[] {
  return CHOICE_ORDER.map((choice) => {
    const available = demo || isAvailable(a, choice);
    const model = choice === "openai" ? a.models.openai : choice === "claude" ? a.models.anthropic : undefined;
    return {
      choice,
      title: CHOICE_LABEL[choice],
      description: demo ? `${DESCRIPTION[choice]} Simulated in Demo Mode.` : DESCRIPTION[choice],
      selected: choice === selected,
      available,
      unavailableReason: available
        ? null
        : choice === "compare"
          ? "Needs both OpenAI and Claude on this server."
          : choice === "smart"
            ? "No provider is configured on this server."
            : "Not configured on this server.",
      model: demo ? null : (model ?? null),
    };
  });
}

/** Switching never interrupts an answer that is streaming and never picks a provider for the user. */
export function canSwitch(choice: ModelChoice, a: ProviderAvailability, demo: boolean, generating: boolean): boolean {
  return !generating && (demo || isAvailable(a, choice));
}

export function recipientLabel(choice: ModelChoice, mode: AssistantMode, demo: boolean): string {
  if (demo) return "Demo Mode · simulated answers · nothing leaves this device";
  if (choice === "compare") return "Sends to OpenAI + Claude · uses both providers";
  if (choice === "smart") return `Dash Smart · usually ${PROVIDER_NAME[SMART_ROUTING[mode][0]!]} for ${MODES[mode].label}`;
  return choice === "openai" ? "Sends to OpenAI" : "Sends to Claude (Anthropic)";
}

// ---- Greeting and Home ------------------------------------------------------------------------

const PLACEHOLDER_NAMES = new Set(["Demo user", "Dash AI user"]);

export function firstName(displayName: string | null | undefined): string | null {
  const clean = (displayName ?? "").trim();
  if (!clean || PLACEHOLDER_NAMES.has(clean)) return null;
  return clean.split(/\s+/)[0]!.slice(0, 24);
}

/** Time-aware greeting with the account's own first name. Never an invented name. */
export function greeting(hour: number, displayName: string | null | undefined): string {
  const part = hour >= 5 && hour <= 11 ? "Good morning" : hour >= 12 && hour <= 16 ? "Good afternoon" : hour >= 17 && hour <= 21 ? "Good evening" : "Hello";
  const first = firstName(displayName);
  return first ? `${part}, ${first}` : part;
}

export function initials(displayName: string | null | undefined, email: string | null | undefined): string | null {
  const name = firstName(displayName) ? displayName!.trim() : null;
  const source = name ?? (email ? email.split("@")[0] : null);
  if (!source) return null;
  const words = source.split(/[\s._-]+/).filter((w) => w && /[\p{L}\p{N}]/u.test(w[0]!));
  if (words.length === 0) return null;
  return (words.length >= 2 ? words[0]![0]! + words[1]![0]! : words[0]![0]!).toUpperCase();
}

export interface QuickAction {
  id: "write" | "file" | "brainstorm" | "code" | "research" | "tools";
  label: string;
  mode: AssistantMode;
  prompt: string;
}

export const QUICK_ACTIONS: QuickAction[] = [
  { id: "write", label: "Write", mode: "writing", prompt: "" },
  { id: "file", label: "Analyse a file", mode: "documents", prompt: "" },
  { id: "brainstorm", label: "Brainstorm", mode: "general", prompt: "Help me brainstorm ideas for " },
  { id: "code", label: "Code", mode: "general", prompt: "Help me with this code: " },
  { id: "research", label: "Research", mode: "research", prompt: "" },
  { id: "tools", label: "More tools", mode: "general", prompt: "" },
];

// ---- History ----------------------------------------------------------------------------------

export type HistorySection = "Today" | "Yesterday" | "Previous 7 days" | "Older";
const SECTIONS: HistorySection[] = ["Today", "Yesterday", "Previous 7 days", "Older"];

function dayNumber(ms: number): number {
  const d = new Date(ms);
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
}

/** Groups conversations (newest first) by the local calendar day of their last activity. */
export function groupHistory<T extends { updatedAt: string }>(items: T[], now: number): { section: HistorySection; items: T[] }[] {
  const today = dayNumber(now);
  const buckets = new Map<HistorySection, T[]>();
  for (const item of items) {
    const days = today - dayNumber(Date.parse(item.updatedAt));
    const section: HistorySection = days <= 0 ? "Today" : days === 1 ? "Yesterday" : days < 8 ? "Previous 7 days" : "Older";
    buckets.set(section, [...(buckets.get(section) ?? []), item]);
  }
  return SECTIONS.filter((s) => buckets.has(s)).map((section) => ({ section, items: buckets.get(section)! }));
}

// ---- Failure recovery -------------------------------------------------------------------------

export type RecoveryAction = "retry" | "change" | "later";

export interface RecoveryCard {
  title: string;
  message: string;
  attemptsNote: string | null;
  actions: RecoveryAction[];
  alternatives: ProviderId[];
}

export interface FailedAnswer {
  provider: ProviderId | null;
  compareGroupId: string | null;
  errorMessage: string | null;
  retryable: boolean;
  recovery?: { attempts: number; alternatives: ProviderId[] };
}

/** The server's recovery metadata decides which providers are offered. The app never switches by itself. */
export function recoveryCard(answer: FailedAnswer, configured: ReadonlySet<ProviderId>, online: boolean): RecoveryCard {
  const other: ProviderId | null = answer.provider ? (answer.provider === "openai" ? "anthropic" : "openai") : null;
  const offered: ProviderId[] = answer.compareGroupId !== null ? [] : answer.recovery ? answer.recovery.alternatives : other ? [other] : [];
  const alternatives = offered.filter((p) => configured.has(p) && p !== answer.provider);
  const actions: RecoveryAction[] = [];
  if (answer.retryable && online) actions.push("retry");
  if (alternatives.length > 0 && online) actions.push("change");
  actions.push("later");
  const attempts = answer.recovery?.attempts ?? 1;
  return {
    title: answer.retryable ? "Provider temporarily unavailable" : "This answer couldn't be completed",
    message: online
      ? (answer.errorMessage ?? "The provider did not finish this answer. Your conversation is saved.")
      : "You're offline. Your conversation is saved; try again when you're connected.",
    attemptsNote: attempts > 1 ? `DASH AI tried ${attempts} times before stopping.` : null,
    actions,
    alternatives: [...new Set(alternatives)],
  };
}

// ---- Documents --------------------------------------------------------------------------------

export type Tone = "neutral" | "progress" | "success" | "warning" | "error";

export function formatSize(bytes: number): string {
  if (bytes < 0) return "Unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const DOCUMENT_SUGGESTIONS = ["Summarise this document", "What are the key risks?", "Extract the major points"];
export const KIND_LABEL = { pdf: "PDF", docx: "Word", txt: "Text", image: "Image" } as const;

// ---- Auth -------------------------------------------------------------------------------------

export type AuthFailureKind = "offline" | "invalid" | "exists" | "rate_limited" | "expired" | "server";

export function authFailure(code: string, message: string, retryable: boolean, online: boolean): { kind: AuthFailureKind; message: string; canRetry: boolean } {
  if (!online || code === "network") {
    return {
      kind: "offline",
      message: online ? "DASH AI couldn't reach the server. Check your connection and try again." : "You're offline. Connect to the internet and try again.",
      canRetry: true,
    };
  }
  if (code === "conflict") return { kind: "exists", message, canRetry: false };
  if (code === "rate_limited") return { kind: "rate_limited", message, canRetry: true };
  if (code === "unauthorized" && /expired/i.test(message)) return { kind: "expired", message: "Your session has expired. Sign in again.", canRetry: false };
  if (code === "unauthorized" || code === "bad_request") return { kind: "invalid", message, canRetry: false };
  return { kind: "server", message: retryable ? "DASH AI is having trouble right now. Try again in a moment." : message, canRetry: retryable };
}

export function emailError(value: string): string | null {
  if (!value.trim()) return "Enter your email address.";
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim()) ? null : "Enter a valid email address.";
}

export function passwordError(value: string, creating: boolean, min: number, max: number): string | null {
  if (!value) return "Enter your password.";
  if (creating && value.length < min) return `Use at least ${min} characters.`;
  if (value.length > max) return `Passwords can be up to ${max} characters.`;
  return null;
}

// ---- Tools ------------------------------------------------------------------------------------

export type ConnectionState = "Available" | "Connected" | "Disabled" | "Requires permission";

export interface ToolConnection {
  plugin: PluginInfo;
  state: ConnectionState;
  tone: Tone;
  detail: string;
  canToggle: boolean;
  scopesToGrant: string[];
}

export function toolConnection(plugin: PluginInfo, toolsEnabled: boolean): ToolConnection {
  const runnable = plugin.tools.filter((t) => t.executable);
  const writeScopes = new Set(plugin.scopes.filter((s) => s.risk !== "read").map((s) => s.id));
  const needed = [...new Set(runnable.map((t) => t.scope).filter((s) => !writeScopes.has(s)))];
  const missing = needed.filter((s) => !plugin.grantedScopes.includes(s));
  let state: ConnectionState;
  let detail: string;
  if (!toolsEnabled) [state, detail] = ["Disabled", "Tools are turned off on this server."];
  else if (runnable.length === 0) [state, detail] = ["Disabled", "Not available on this server yet."];
  else if (plugin.enabled && missing.length === 0) [state, detail] = ["Connected", "DASH AI can use these tools when they help with your request."];
  else if (plugin.enabled) [state, detail] = ["Requires permission", "Allow access so DASH AI can use these tools."];
  else [state, detail] = ["Available", "Off. Turn it on to let DASH AI use these tools."];
  const tone: Tone = state === "Connected" ? "success" : state === "Requires permission" ? "warning" : "neutral";
  return {
    plugin,
    state,
    tone,
    detail,
    canToggle: toolsEnabled && (runnable.length > 0 || plugin.enabled),
    scopesToGrant: [...new Set([...plugin.grantedScopes.filter((s) => !writeScopes.has(s)), ...needed])].sort(),
  };
}

export function toolLabel(name: string): string {
  const s = name.replace(/[_-]/g, " ").trim();
  return s ? s[0]!.toUpperCase() + s.slice(1) : "Tool";
}

export type ToolStatus = "ok" | "duplicate" | "invalid_arguments" | "denied" | "unknown_tool" | "timeout" | "error" | "cancelled";

export interface ToolUse {
  callId: string;
  plugin: string;
  tool: string;
  status: ToolStatus | null;
  durationMs: number | null;
}

/** Names and outcomes only: the server never sends tool arguments or results to the app. */
export function toolUseLabel(use: ToolUse, pluginNames: Record<string, string>): { title: string; detail: string; tone: Tone } {
  const tool = toolLabel(use.tool);
  const plugin = pluginNames[use.plugin] ?? toolLabel(use.plugin);
  const took = use.durationMs !== null ? ` in ${use.durationMs < 1000 ? `${use.durationMs} ms` : `${(use.durationMs / 1000).toFixed(1)} s`}` : "";
  switch (use.status) {
    case null:
      return { title: `Using ${tool}`, detail: plugin, tone: "progress" };
    case "ok":
    case "duplicate":
      return { title: `Used ${tool}`, detail: `${plugin} · finished${took}`, tone: "success" };
    case "denied":
      return { title: `${tool} not permitted`, detail: `${plugin} · access is not allowed in Tools & Connections`, tone: "warning" };
    case "cancelled":
      return { title: `${tool} stopped`, detail: plugin, tone: "neutral" };
    case "timeout":
      return { title: `${tool} timed out`, detail: plugin, tone: "warning" };
    default:
      return { title: `Couldn't use ${tool}`, detail: plugin, tone: "warning" };
  }
}

export function toolSummary(uses: ToolUse[]): string {
  if (uses.length === 0) return "";
  if (uses.some((u) => u.status === null)) return "Using tools…";
  return uses.length === 1 ? toolUseLabel(uses[0]!, {}).title : `Used ${uses.length} tools`;
}

/** The label shown above an answer: who produced it. Demo answers always say so. */
export function sourceLabel(m: Pick<ConversationMessage, "origin" | "model" | "demo">): string {
  if (m.demo) return `Demo · ${m.origin ? PROVIDER_NAME[m.origin] : "DASH AI"}-style (simulated)`;
  if (m.origin) return [PROVIDER_NAME[m.origin], m.model].filter(Boolean).join(" · ");
  return "DASH AI";
}
