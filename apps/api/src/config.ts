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
  /** Request and replay encrypted reasoning items in tool rounds (reasoning models). Verify live before enabling. */
  OPENAI_ENCRYPTED_REASONING: z.preprocess(emptyToUndefined, z.enum(["true", "false"]).default("false")),
  ANTHROPIC_API_KEY: optionalString,
  ANTHROPIC_MODEL: optionalString,
  PROVIDER_TIMEOUT_MS: int(120_000, 1_000, 600_000),
  PROVIDER_IDLE_TIMEOUT_MS: int(45_000, 500, 300_000),
  /** Includes any reasoning/thinking tokens on models that think, so it must leave room for both. */
  MAX_OUTPUT_TOKENS: int(16_000, 16, 128_000),
  FAKE_STREAM_DELAY_MS: int(25, 0, 5_000),
  RATE_LIMIT_CHAT_PER_MINUTE: int(20, 1, 10_000),
  RATE_LIMIT_SYNC_PER_MINUTE: int(60, 1, 10_000),
  RATE_LIMIT_AUTH_PER_MINUTE: int(10, 1, 10_000),
  RATE_LIMIT_UPLOAD_PER_MINUTE: int(10, 1, 10_000),
  RATE_LIMIT_API_PER_MINUTE: int(240, 1, 100_000),
  MAX_CONCURRENT_STREAMS_PER_USER: int(3, 1, 50),
  SESSION_TTL_DAYS: int(30, 1, 365),
  /** Set to "true" only behind a trusted reverse proxy so client IPs come from X-Forwarded-For. */
  TRUST_PROXY: z.preprocess(emptyToUndefined, z.enum(["true", "false"]).default("false")),

  /** PostgreSQL connection string. Unset = in-memory store (development and tests only). */
  DATABASE_URL: optionalString,
  /** TLS to the database. Defaults to "require" in production and "disable" elsewhere. */
  DATABASE_SSL: z.preprocess(emptyToUndefined, z.enum(["disable", "require", "no-verify"]).optional()),
  DATABASE_POOL_MAX: int(10, 1, 100),
  /** Apply pending migrations at startup. Defaults to true outside production, false in production. */
  DATABASE_AUTO_MIGRATE: z.preprocess(emptyToUndefined, z.enum(["true", "false"]).optional()),
  /** Base64 of 32 random bytes (openssl rand -base64 32). Encrypts document text at rest. */
  DATA_ENCRYPTION_KEY: optionalString,
  DATA_ENCRYPTION_KEY_ID: z.preprocess(emptyToUndefined, z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).default("k1")),
  /** Retired keys kept for decrypting old data: id:base64,id2:base64 */
  DATA_ENCRYPTION_PREVIOUS_KEYS: optionalString,
  /** Server-wide kill switch for tool calling. */
  TOOLS_ENABLED: z.preprocess(emptyToUndefined, z.enum(["true", "false"]).default("true")),
  TOOL_TIMEOUT_MS: int(10_000, 100, 120_000),
  TOOL_MAX_ROUNDS: int(4, 1, 8),
  TOOL_MAX_RESULT_CHARS: int(20_000, 100, 200_000),
  /** Production refuses to start on the in-memory store unless this is "true". */
  ALLOW_MEMORY_STORE: z.preprocess(emptyToUndefined, z.enum(["true", "false"]).default("false")),
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
  openai: ProviderConfig & { encryptedReasoning: boolean };
  anthropic: ProviderConfig;
  providerTimeoutMs: number;
  providerIdleTimeoutMs: number;
  maxOutputTokens: number;
  fakeStreamDelayMs: number;
  rateLimits: { chatPerMinute: number; authPerMinute: number; uploadPerMinute: number; apiPerMinute: number; syncPerMinute: number };
  maxConcurrentStreamsPerUser: number;
  sessionTtlDays: number;
  trustProxy: boolean;
  database: {
    url: string | undefined;
    ssl: "disable" | "require" | "no-verify";
    poolMax: number;
    autoMigrate: boolean;
    allowMemoryStore: boolean;
  };
  tools: { enabled: boolean; timeoutMs: number; maxRounds: number; maxResultChars: number };
  dataEncryption: { key: string | undefined; keyId: string; previousKeys: string | undefined };
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
    openai: { apiKey: e.OPENAI_API_KEY, model: e.OPENAI_MODEL, encryptedReasoning: e.OPENAI_ENCRYPTED_REASONING === "true" },
    anthropic: { apiKey: e.ANTHROPIC_API_KEY, model: e.ANTHROPIC_MODEL },
    providerTimeoutMs: e.PROVIDER_TIMEOUT_MS,
    providerIdleTimeoutMs: e.PROVIDER_IDLE_TIMEOUT_MS,
    maxOutputTokens: e.MAX_OUTPUT_TOKENS,
    fakeStreamDelayMs: e.FAKE_STREAM_DELAY_MS,
    rateLimits: {
      chatPerMinute: e.RATE_LIMIT_CHAT_PER_MINUTE,
      syncPerMinute: e.RATE_LIMIT_SYNC_PER_MINUTE,
      authPerMinute: e.RATE_LIMIT_AUTH_PER_MINUTE,
      uploadPerMinute: e.RATE_LIMIT_UPLOAD_PER_MINUTE,
      apiPerMinute: e.RATE_LIMIT_API_PER_MINUTE,
    },
    maxConcurrentStreamsPerUser: e.MAX_CONCURRENT_STREAMS_PER_USER,
    sessionTtlDays: e.SESSION_TTL_DAYS,
    trustProxy: e.TRUST_PROXY === "true",
    database: {
      url: e.DATABASE_URL,
      ssl: e.DATABASE_SSL ?? (e.NODE_ENV === "production" ? "require" : "disable"),
      poolMax: e.DATABASE_POOL_MAX,
      autoMigrate: e.DATABASE_AUTO_MIGRATE ? e.DATABASE_AUTO_MIGRATE === "true" : e.NODE_ENV !== "production",
      allowMemoryStore: e.ALLOW_MEMORY_STORE === "true",
    },
    tools: {
      enabled: e.TOOLS_ENABLED === "true",
      timeoutMs: e.TOOL_TIMEOUT_MS,
      maxRounds: e.TOOL_MAX_ROUNDS,
      maxResultChars: e.TOOL_MAX_RESULT_CHARS,
    },
    dataEncryption: {
      key: e.DATA_ENCRYPTION_KEY,
      keyId: e.DATA_ENCRYPTION_KEY_ID,
      previousKeys: e.DATA_ENCRYPTION_PREVIOUS_KEYS,
    },
    version: "0.1.0",
  };
}
