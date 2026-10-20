/**
 * Amazon Nova model profiles used by the Bedrock adapter (INTERNAL: never shown to consumers).
 *
 * The operator configures one model or inference-profile id per tier (BEDROCK_MODEL_MICRO, _LITE,
 * _NOVA2_LITE), for example `eu.amazon.nova-lite-v1:0`. A tier is recognised from its id, so a
 * cross-Region inference profile (`eu.`, `us.`, `apac.`, `global.`) and a plain model id share a
 * profile. The limits are deliberately conservative: asking for more output than a model allows is
 * a request error (no retry, no failover), while a lower limit only ends a long answer early with
 * finish reason "length", which the apps already handle with Continue.
 */

export type NovaTier = "micro" | "lite" | "nova2Lite";

export interface NovaProfile {
  tier: NovaTier;
  /** Matches the model id or inference-profile id the operator configured for this tier. */
  idPattern: RegExp;
  /** Input context the router may rely on. */
  contextTokens: number;
  /** Upper bound for maxTokens sent to Bedrock. */
  maxOutputTokens: number;
}

export const NOVA_PROFILES: Record<NovaTier, NovaProfile> = {
  micro: { tier: "micro", idPattern: /(^|[.:/])amazon\.nova-micro-v\d/, contextTokens: 128_000, maxOutputTokens: 5_000 },
  lite: { tier: "lite", idPattern: /(^|[.:/])amazon\.nova-lite-v\d/, contextTokens: 300_000, maxOutputTokens: 5_000 },
  nova2Lite: { tier: "nova2Lite", idPattern: /(^|[.:/])amazon\.nova-2-lite-v\d/, contextTokens: 1_000_000, maxOutputTokens: 64_000 },
};

/** The environment variable that configures each tier. */
export const NOVA_TIER_VARIABLES: Record<NovaTier, string> = {
  micro: "BEDROCK_MODEL_MICRO",
  lite: "BEDROCK_MODEL_LITE",
  nova2Lite: "BEDROCK_MODEL_NOVA2_LITE",
};

/** True when `modelId` is an id (or inference profile) of the given Nova tier. */
export const matchesTier = (tier: NovaTier, modelId: string): boolean => NOVA_PROFILES[tier].idPattern.test(modelId);

/** The profile for a configured model id, or undefined when it is not a known Nova model. */
export function novaProfileFor(modelId: string): NovaProfile | undefined {
  return (Object.values(NOVA_PROFILES) as NovaProfile[]).find((p) => p.idPattern.test(modelId));
}
