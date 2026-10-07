import type { ProviderId } from "@dash-ai/contracts";
import type { AppConfig } from "../config.js";

/**
 * What consumers see of DASH AI's infrastructure. DASH AI is the product; the AI providers behind it
 * are internal. With PROVIDER_DETAILS=hidden (the production default) nothing that reaches a client
 * names a provider or model: errors, routing text, stream metadata, history, usage, tool activity.
 * Logs, metrics and the database keep the full detail for operators.
 */
export const hideProviders = (config: Pick<AppConfig, "providerDetails">): boolean => config.providerDetails !== "exposed";

export const NEUTRAL_ROUTING_REASON = "DASH AI chose how to handle this request.";
export const NEUTRAL_UNAVAILABLE = "DASH AI is temporarily unavailable. Please try again later.";

/** The message a person sees when an answer could not be completed, by error code. */
export function neutralErrorMessage(code: string): string {
  switch (code) {
    case "rate_limited":
      return "DASH AI is very busy right now. Please try again in a moment.";
    case "provider_timeout":
      return "DASH AI took too long to respond. Please try again.";
    default:
      return "DASH AI couldn't complete that response. Please try again.";
  }
}

/** Provider and product names that must never appear in consumer-facing text. Used by tests and checks. */
export const PROVIDER_NAMES: readonly string[] = ["OpenAI", "ChatGPT", "GPT-", "Anthropic", "Claude", "Gemini"];

export const containsProviderName = (text: string): boolean =>
  PROVIDER_NAMES.some((n) => text.toLowerCase().includes(n.toLowerCase())) || /\b(openai|anthropic)\b/i.test(text);

export type { ProviderId };
