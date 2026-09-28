import { z } from "zod";

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalString = z.preprocess(emptyToUndefined, z.string().trim().min(1).optional());
const int = (def: number, min: number, max: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().min(min).max(max).default(def));

const EnvSchema = z.object({
  NODE_ENV: z.preprocess(emptyToUndefined, z.enum(["development", "test", "production"]).default("development")),
  HOST: z.preprocess(emptyToUndefined, z.string().default("0.0.0.0")),
  PORT: int(8787, 1, 65535),
  LOG_LEVEL: z.preprocess(
    emptyToUndefined,
    z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  ),
  /**
   * live — use real providers for which both a key and a model are configured.
   * fake — use the fake demonstration adapters for both providers (no network, no cost).
   */
  PROVIDER_MODE: z.preprocess(emptyToUndefined, z.enum(["live", "fake"]).default("live")),
  OPENAI_API_KEY: optionalString,
  OPENAI_MODEL: optionalString,
  ANTHROPIC_API_KEY: optionalString,
  ANTHROPIC_MODEL: optionalString,
  PROVIDER_TIMEOUT_MS: int(120_000, 1_000, 600_000),
  PROVIDER_IDLE_TIMEOUT_MS: int(45_000, 500, 300_000),
  MAX_OUTPUT_TOKENS: int(2_048, 16, 32_000),
  FAKE_STREAM_DELAY_MS: int(25, 0, 5_000),
  RATE_LIMIT_CHAT_PER_MINUTE: int(20, 1, 10_000),
  RATE_LIMIT_AUTH_PER_MINUTE: int(10, 1, 10_000),
  RATE_LIMIT_UPLOAD_PER_MINUTE: int(10, 1, 10_000),
  RATE_LIMIT_API_PER_MINUTE: int(240, 1, 100_000),
  MAX_CONCURRENT_STREAMS_PER_USER: int(3, 1, 50),
  SESSION_TTL_DAYS: int(30, 1, 365),
  /** Set to "true" only behind a trusted reverse proxy so client IPs come from X-Forwarded-For. */
  TRUST_PROXY: z.preprocess(emptyToUndefined, z.enum(["true", "false"]).default("false")),
});

export type Env = z.infer<typeof EnvSchema>;

export interface ProviderConfig {
  apiKey: string | undefined;
  model: string | undefined;
}

export interface AppConfig {
  nodeEnv: Env["NODE_ENV"];
  host: string;
  port: number;
  logLevel: Env["LOG_LEVEL"];
  providerMode: Env["PROVIDER_MODE"];
  openai: ProviderConfig;
  anthropic: ProviderConfig;
  providerTimeoutMs: number;
  providerIdleTimeoutMs: number;
  maxOutputTokens: number;
  fakeStreamDelayMs: number;
  rateLimits: { chatPerMinute: number; authPerMinute: number; uploadPerMinute: number; apiPerMinute: number };
  maxConcurrentStreamsPerUser: number;
  sessionTtlDays: number;
  trustProxy: boolean;
  version: string;
}

export class ConfigError extends Error {}

/** Parses environment variables. Error messages name the variable, never its value. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ConfigError(`Invalid configuration: ${problems}`);
  }
  const e = parsed.data;
  return {
    nodeEnv: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    providerMode: e.PROVIDER_MODE,
    openai: { apiKey: e.OPENAI_API_KEY, model: e.OPENAI_MODEL },
    anthropic: { apiKey: e.ANTHROPIC_API_KEY, model: e.ANTHROPIC_MODEL },
    providerTimeoutMs: e.PROVIDER_TIMEOUT_MS,
    providerIdleTimeoutMs: e.PROVIDER_IDLE_TIMEOUT_MS,
    maxOutputTokens: e.MAX_OUTPUT_TOKENS,
    fakeStreamDelayMs: e.FAKE_STREAM_DELAY_MS,
    rateLimits: {
      chatPerMinute: e.RATE_LIMIT_CHAT_PER_MINUTE,
      authPerMinute: e.RATE_LIMIT_AUTH_PER_MINUTE,
      uploadPerMinute: e.RATE_LIMIT_UPLOAD_PER_MINUTE,
      apiPerMinute: e.RATE_LIMIT_API_PER_MINUTE,
    },
    maxConcurrentStreamsPerUser: e.MAX_CONCURRENT_STREAMS_PER_USER,
    sessionTtlDays: e.SESSION_TTL_DAYS,
    trustProxy: e.TRUST_PROXY === "true",
    version: "0.1.0",
  };
}
