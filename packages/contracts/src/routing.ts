import type { AssistantMode, ModelChoice, ProviderId } from "./common.js";

/**
 * Dash Smart routing table: for each assistant mode, the providers in order of preference.
 * The API picks the first configured provider. The Android Demo Mode mirrors this table and a
 * contract test on each side checks it against fixtures/smart-routing.json.
 */
export const SMART_ROUTING: Readonly<Record<AssistantMode, readonly ProviderId[]>> = {
  general: ["openai", "anthropic"],
  business: ["openai", "anthropic"],
  writing: ["anthropic", "openai"],
  documents: ["anthropic", "openai"],
  research: ["openai", "anthropic"],
};

export const SMART_ROUTING_REASONS: Readonly<Record<AssistantMode, string>> = {
  general: "General conversations default to OpenAI when it is configured.",
  business: "Business planning defaults to OpenAI when it is configured.",
  writing: "Long-form writing defaults to Claude when it is configured.",
  documents: "Document work defaults to Claude when it is configured.",
  research: "Research defaults to OpenAI when it is configured.",
};

export type RoutingResult =
  | { ok: true; providers: ProviderId[]; reason: string }
  | { ok: false; code: "provider_not_configured" | "no_provider_available"; message: string };

/** Resolves a model choice to the provider(s) that will receive the prompt. */
export function resolveProviders(
  choice: ModelChoice,
  mode: AssistantMode,
  configured: ReadonlySet<ProviderId>,
): RoutingResult {
  switch (choice) {
    case "openai":
      return configured.has("openai")
        ? { ok: true, providers: ["openai"], reason: "You selected OpenAI." }
        : { ok: false, code: "provider_not_configured", message: "OpenAI is not configured on this server." };
    case "claude":
      return configured.has("anthropic")
        ? { ok: true, providers: ["anthropic"], reason: "You selected Claude." }
        : { ok: false, code: "provider_not_configured", message: "Claude is not configured on this server." };
    case "compare":
      return configured.has("openai") && configured.has("anthropic")
        ? {
            ok: true,
            providers: ["openai", "anthropic"],
            reason: "Compare sends the same prompt to OpenAI and Claude.",
          }
        : {
            ok: false,
            code: "provider_not_configured",
            message: "Compare needs both OpenAI and Claude to be configured on this server.",
          };
    case "smart": {
      const preferred = SMART_ROUTING[mode];
      const pick = preferred.find((p) => configured.has(p));
      if (!pick) {
        return { ok: false, code: "no_provider_available", message: "No AI provider is configured on this server." };
      }
      const reason =
        pick === preferred[0]
          ? SMART_ROUTING_REASONS[mode]
          : `Dash Smart used ${pick === "openai" ? "OpenAI" : "Claude"} because the preferred provider is not configured.`;
      return { ok: true, providers: [pick], reason };
    }
  }
}

export function otherProvider(provider: ProviderId): ProviderId {
  return provider === "openai" ? "anthropic" : "openai";
}

/**
 * A provider the person explicitly asked for in their own words ("use ChatGPT", "a Claude-style
 * analysis"). Only a routing preference: it is applied when that provider is configured and is never
 * announced or promised to the user. Unknown names (e.g. Gemini, not integrated) give no hint.
 */
export function providerHint(text: string): ProviderId | null {
  const t = text.toLowerCase();
  const claude = /\b(claude|anthropic)\b/.test(t);
  const openai = /\b(chatgpt|chat gpt|openai|gpt-?\d[\w.-]*)\b/.test(t);
  if (claude === openai) return null;
  return claude ? "anthropic" : "openai";
}

/**
 * DASH AI's own route for a request: every configured provider, best first. The first answers; the
 * rest are internal fallbacks used only when the first fails before producing anything.
 */
export function smartRoute(mode: AssistantMode, configured: ReadonlySet<ProviderId>, hint: ProviderId | null = null): ProviderId[] {
  const order = [...SMART_ROUTING[mode]];
  if (hint && configured.has(hint)) order.sort((a, b) => Number(b === hint) - Number(a === hint));
  return order.filter((p) => configured.has(p));
}
