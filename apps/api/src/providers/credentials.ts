import { matchesTier, NOVA_TIER_VARIABLES, type NovaTier } from "./nova.js";

/**
 * Checks on provider credentials, shared by start-up validation (config.ts) and the provider registry.
 * They look only at the shape of a value: a key is never logged, returned, or included in a message.
 */

/**
 * Values copied from an example instead of a real secret ("your-key", "sk-...", "changeme"), or a key
 * with spaces inside it. Such a provider is still configured (the provider decides), but start-up
 * says why its requests will be refused. The key itself is never logged.
 */
export function looksLikePlaceholder(key: string): boolean {
  return /\s/.test(key) || /\.\.\.|^<|>$|your[-_ ]?(api[-_ ]?)?key|changeme|placeholder|^x{6,}$|^replace/i.test(key) || key.length < 16;
}

interface Credentials {
  apiKey: string | undefined;
  model: string | undefined;
}

export interface BedrockCredentials {
  /** api_key: Bedrock API key as a bearer token. iam: the AWS SDK default credential chain. */
  auth: "api_key" | "iam";
  apiKey: string | undefined;
  region: string | undefined;
  models: Record<NovaTier, string | undefined>;
}

export interface LiveProviderConfig {
  openai: Credentials;
  anthropic: Credentials;
  bedrock: BedrockCredentials;
}

const PROVIDERS = [
  { name: "OpenAI", key: "OPENAI_API_KEY", model: "OPENAI_MODEL", config: "openai" },
  { name: "Anthropic", key: "ANTHROPIC_API_KEY", model: "ANTHROPIC_MODEL", config: "anthropic" },
] as const;

const TIERS = Object.keys(NOVA_TIER_VARIABLES) as NovaTier[];
const TIER_NAMES: Record<NovaTier, string> = { micro: "Amazon Nova Micro", lite: "Amazon Nova Lite", nova2Lite: "Amazon Nova 2 Lite" };
const QUOTED = /^["']|["']$/;
const quoted = (name: string) => `${name} is wrapped in quotes: remove them (this environment file keeps quotes as part of the value).`;

/**
 * Whether Bedrock was meant to be used: a key or a model id is set. A Region or BEDROCK_AUTH on its
 * own is not an intent (templates preset them), so it never makes an otherwise empty setup "incomplete".
 */
const bedrockIntended = (b: BedrockCredentials): boolean => Boolean(b.apiKey || TIERS.some((t) => b.models[t]));

export function bedrockConfigured(b: BedrockCredentials): boolean {
  return Boolean(b.region && TIERS.some((t) => b.models[t]) && (b.auth === "iam" || b.apiKey));
}

/**
 * Why the Bedrock settings could not work, by variable name only (never a value). Empty when
 * Bedrock is not configured at all, or configured completely and plausibly.
 */
export function bedrockProblems(b: BedrockCredentials): string[] {
  if (!bedrockIntended(b)) return [];
  const problems: string[] = [];
  if (!b.region) problems.push("BEDROCK_REGION is required when Bedrock is configured.");
  else if (!/^[a-z]{2}(-gov)?-[a-z]+-\d$/.test(b.region)) problems.push("BEDROCK_REGION is not an AWS Region code (for example eu-west-1).");
  if (!TIERS.some((t) => b.models[t])) {
    problems.push("Bedrock needs at least one of BEDROCK_MODEL_MICRO, BEDROCK_MODEL_LITE or BEDROCK_MODEL_NOVA2_LITE.");
  }
  if (b.auth === "api_key") {
    if (!b.apiKey) problems.push("BEDROCK_API_KEY is required when Bedrock is configured with BEDROCK_AUTH=api_key.");
    else if (looksLikePlaceholder(b.apiKey)) problems.push("BEDROCK_API_KEY looks like a placeholder, not a real key.");
  } else if (b.apiKey) {
    problems.push("BEDROCK_API_KEY is set but BEDROCK_AUTH=iam uses AWS credentials instead: remove one of them.");
  }
  for (const tier of TIERS) {
    const id = b.models[tier];
    if (!id) continue;
    if (QUOTED.test(id)) problems.push(quoted(NOVA_TIER_VARIABLES[tier]));
    else if (!matchesTier(tier, id)) {
      problems.push(`${NOVA_TIER_VARIABLES[tier]} is not an ${TIER_NAMES[tier]} model or inference profile id.`);
    }
  }
  if (b.apiKey && QUOTED.test(b.apiKey)) problems.push(quoted("BEDROCK_API_KEY"));
  if (b.region && QUOTED.test(b.region)) problems.push(quoted("BEDROCK_REGION"));
  return problems;
}

/**
 * Why PROVIDER_MODE=live could not give real answers with these settings, by variable name only.
 * OpenAI/Anthropic need a key + model. Bedrock needs a Region, at least one Nova model id and its
 * credentials (see bedrockProblems). Empty when at least one provider is complete and none is
 * half-configured.
 */
export function liveProviderProblems(config: LiveProviderConfig): string[] {
  const problems: string[] = [];
  let complete = 0;
  for (const p of PROVIDERS) {
    const { apiKey, model } = config[p.config];
    if (apiKey && model) complete += 1;
    else if (apiKey) problems.push(`${p.key} is set without ${p.model}.`);
    else if (model) problems.push(`${p.model} is set without ${p.key}.`);
    if (apiKey && looksLikePlaceholder(apiKey)) problems.push(`${p.key} looks like a placeholder, not a real key.`);
    // Some environment-file loaders (docker --env-file, for one) keep quotes as part of the value.
    for (const [name, value] of [[p.key, apiKey], [p.model, model]] as const) {
      if (value && QUOTED.test(value)) problems.push(quoted(name));
    }
  }

  if (bedrockConfigured(config.bedrock)) complete += 1;
  problems.push(...bedrockProblems(config.bedrock));

  if (complete === 0 && problems.length === 0) {
    problems.push(
      "No AI provider is configured: set OPENAI_API_KEY + OPENAI_MODEL, ANTHROPIC_API_KEY + ANTHROPIC_MODEL, and/or the BEDROCK_* settings.",
    );
  }
  return problems;
}

/** How many live provider adapters are complete enough to be constructed. */
export const liveProviderCount = (config: LiveProviderConfig): number =>
  PROVIDERS.filter((p) => config[p.config].apiKey && config[p.config].model).length + (bedrockConfigured(config.bedrock) ? 1 : 0);
