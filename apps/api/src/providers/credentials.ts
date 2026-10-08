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

const PROVIDERS = [
  { name: "OpenAI", key: "OPENAI_API_KEY", model: "OPENAI_MODEL", config: "openai" },
  { name: "Anthropic", key: "ANTHROPIC_API_KEY", model: "ANTHROPIC_MODEL", config: "anthropic" },
] as const;

/**
 * Why PROVIDER_MODE=live could not give real answers with these settings, by variable name only:
 * a key without its model (or the reverse), a key that looks copied from an example, or no provider
 * at all. Empty when at least one provider has a key and a model and none is half-configured.
 */
export function liveProviderProblems(config: { openai: Credentials; anthropic: Credentials }): string[] {
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
  if (complete === 0 && problems.length === 0) {
    problems.push("No AI provider is configured: set OPENAI_API_KEY and OPENAI_MODEL, and/or ANTHROPIC_API_KEY and ANTHROPIC_MODEL.");
  }
  return problems;
}

/** How many providers have both a key and a model (the ones PROVIDER_MODE=live will call). */
export const liveProviderCount = (config: { openai: Credentials; anthropic: Credentials }): number =>
  PROVIDERS.filter((p) => config[p.config].apiKey && config[p.config].model).length;
