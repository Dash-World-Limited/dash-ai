import { z } from "zod";
import { CompatibleProviders, type CompatibleProviderConfig } from "../providers/compatible.js";
import { ProviderQuotas } from "./quota.js";
import type { Sensitivity } from "./policy.js";

/**
 * AI provider and cost-control settings that are JSON in the environment (parsed here so config.ts
 * stays readable). Every error names the variable and the field, never a value.
 */
export class SettingsError extends Error {}

/** USD amounts, keyed by account plan, for AI_PLAN_DAILY_SPEND. */
export const PlanLimits = z.record(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, "plan names are lowercase"), z.number().nonnegative().max(1_000_000));

export interface CompatibleProviderSettings extends CompatibleProviderConfig {
  /** The key read from the environment variable named by apiKeyEnv (never logged). */
  apiKey: string | undefined;
}

/** Global switches and spend limits (USD). A limit that is null is not enforced. */
export interface AiControls {
  /** AI_ENABLED (default true): false refuses every AI request, demonstrations included. */
  enabled: boolean;
  /** FREE_POOL_ENABLED (default false): free and promotional providers may serve requests. */
  freePoolEnabled: boolean;
  /** PAID_PROVIDERS_ENABLED (default true): paid providers may serve requests. */
  paidProvidersEnabled: boolean;
  /** BEDROCK_FALLBACK_ENABLED (default false): the Bedrock adapter may serve requests. */
  bedrockFallbackEnabled: boolean;
  /** AI_DEFAULT_PLAN: the plan every account is on until plans are assigned per account. */
  defaultPlan: string;
  /** AI_DEFAULT_SENSITIVITY (default sensitive): how ordinary requests are classified. */
  defaultSensitivity: Sensitivity;
  limits: {
    requestUsd: number | null;
    userDailyUsd: number | null;
    systemDailyUsd: number | null;
    systemMonthlyUsd: number | null;
    planDailyUsd: Record<string, number>;
  };
}

function parseJson(name: string, value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    throw new SettingsError(`${name} is not valid JSON.`);
  }
}

function describe(name: string, error: z.ZodError): string {
  const where = error.issues
    .slice(0, 3)
    .map((i) => {
      // Array indexes and field names only: record keys and values are operator text and not echoed.
      const path = i.path.filter((p) => typeof p === "number" || /^[a-zA-Z]+$/.test(String(p))).join(".");
      const message = i.code === "invalid_key" ? (i.issues[0]?.message ?? i.message) : i.message;
      return path ? `${path}: ${message}` : message;
    })
    .join("; ");
  return `${name} is invalid: ${where}`;
}

/**
 * COMPATIBLE_PROVIDERS: the registered OpenAI-compatible providers, with each key read from the
 * variable its entry names. A key variable may not name one of DASH's own settings (which would send
 * a DASH secret to a third party).
 */
export function parseCompatibleProviders(
  value: string | undefined,
  env: NodeJS.ProcessEnv,
  ownSettings: readonly string[],
  production: boolean,
): CompatibleProviderSettings[] {
  const raw = parseJson("COMPATIBLE_PROVIDERS", value);
  if (raw === undefined) return [];
  const parsed = CompatibleProviders.safeParse(raw);
  if (!parsed.success) throw new SettingsError(describe("COMPATIBLE_PROVIDERS", parsed.error));
  return parsed.data.map((p, i) => {
    if (ownSettings.includes(p.apiKeyEnv)) {
      throw new SettingsError(`COMPATIBLE_PROVIDERS ${i}.apiKeyEnv names one of DASH's own settings; use a variable of its own.`);
    }
    const url = new URL(p.baseUrl);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local && !production)) {
      throw new SettingsError(`COMPATIBLE_PROVIDERS ${i}.baseUrl must use https (plain http only for localhost outside production).`);
    }
    if (url.username || url.password) throw new SettingsError(`COMPATIBLE_PROVIDERS ${i}.baseUrl must not contain credentials.`);
    const key = env[p.apiKeyEnv]?.trim();
    return { ...p, apiKey: key ? key : undefined };
  });
}

export function parseQuotas(value: string | undefined): ProviderQuotas {
  const raw = parseJson("PROVIDER_QUOTAS", value);
  if (raw === undefined) return {};
  const parsed = ProviderQuotas.safeParse(raw);
  if (!parsed.success) throw new SettingsError(describe("PROVIDER_QUOTAS", parsed.error));
  return parsed.data;
}

export function parsePlanLimits(value: string | undefined): Record<string, number> {
  const raw = parseJson("AI_PLAN_DAILY_SPEND", value);
  if (raw === undefined) return {};
  const parsed = PlanLimits.safeParse(raw);
  if (!parsed.success) throw new SettingsError(describe("AI_PLAN_DAILY_SPEND", parsed.error));
  return parsed.data;
}
