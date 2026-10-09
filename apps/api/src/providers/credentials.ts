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
  apiKey: string | undefined;
  region: string | undefined;
  models: {
    micro: string | undefined;
    lite: string | undefined;
    nova2Lite: string | undefined;
  };
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

const BEDROCK_MODELS = [
  ["BEDROCK_MODEL_MICRO", "micro"],
  ["BEDROCK_MODEL_LITE", "lite"],
  ["BEDROCK_MODEL_NOVA2_LITE", "nova2Lite"],
] as const;

export function bedrockConfigured(config: BedrockCredentials): boolean {
  return Boolean(config.apiKey && config.region && BEDROCK_MODELS.some(([, key]) => config.models[key]));
}

/**
 * Why PROVIDER_MODE=live could not give real answers with these settings, by variable name only.
 * OpenAI/Anthropic need a key + model. Bedrock needs a bearer API key, Region and at least one Nova
 * model id. Empty when at least one provider is complete and none is half-configured.
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
      if (value && /^["']|["']$/.test(value)) problems.push(`${name} is wrapped in quotes: remove them (this environment file keeps quotes as part of the value).`);
    }
  }

  const b = config.bedrock;
  const bedrockValues = [b.apiKey, b.region, ...BEDROCK_MODELS.map(([, key]) => b.models[key])];
  const anyBedrock = bedrockValues.some(Boolean);
  const anyBedrockModel = BEDROCK_MODELS.some(([, key]) => Boolean(b.models[key]));
  if (bedrockConfigured(b)) complete += 1;
  else if (anyBedrock) {
    if (!b.apiKey) problems.push("BEDROCK_API_KEY is required when Bedrock is configured.");
    if (!b.region) problems.push("BEDROCK_REGION is required when Bedrock is configured.");
    if (!anyBedrockModel) problems.push("Bedrock needs at least one of BEDROCK_MODEL_MICRO, BEDROCK_MODEL_LITE or BEDROCK_MODEL_NOVA2_LITE.");
  }
  if (b.apiKey && looksLikePlaceholder(b.apiKey)) problems.push("BEDROCK_API_KEY looks like a placeholder, not a real key.");
  const namedBedrockValues: Array<[string, string | undefined]> = [
    ["BEDROCK_API_KEY", b.apiKey],
    ["BEDROCK_REGION", b.region],
    ...BEDROCK_MODELS.map(([name, key]) => [name, b.models[key]] as [string, string | undefined]),
  ];
  for (const [name, value] of namedBedrockValues) {
    if (value && /^["']|["']$/.test(value)) problems.push(`${name} is wrapped in quotes: remove them (this environment file keeps quotes as part of the value).`);
  }

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
