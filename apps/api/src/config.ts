import { isIP } from "node:net";
import { z } from "zod";
import { ModelPrices } from "./intelligence/cost.js";
import { loadPolicy, PolicyError, type RouterPolicy } from "./intelligence/policy.js";
import { costControlProblems, liveProviderCount, liveProviderProblems, type BedrockCredentials } from "./providers/credentials.js";
import { compatibleProfile } from "./providers/compatible.js";
import { parseCompatibleProviders, parsePlanLimits, parseQuotas, SettingsError, type AiControls, type CompatibleProviderSettings } from "./intelligence/settings.js";
import type { ProviderQuotas } from "./intelligence/quota.js";
import { FcmConfigError, parseServiceAccount, type FcmServiceAccount } from "./push/fcm.js";

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalString = z.preprocess(emptyToUndefined, z.string().trim().min(1).optional());
const bool = (def: "true" | "false") => z.preprocess(emptyToUndefined, z.enum(["true", "false"]).default(def));
const optionalBool = z.preprocess(emptyToUndefined, z.enum(["true", "false"]).optional());
/** A USD amount; empty or absent = not set. */
const usd = z.preprocess(emptyToUndefined, z.coerce.number().nonnegative().max(1_000_000).optional());
const int = (def: number, min: number, max: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().min(min).max(max).default(def));

/** One TRUST_PROXY address or CIDR: its IP version and prefix length, or null when it is not one. */
function proxyRange(entry: string): { version: 4 | 6; prefix: number } | null {
  const m = /^([^/]+)(?:\/(\d{1,3}))?$/.exec(entry);
  const version = m ? isIP(m[1]!) : 0;
  if (!m || (version !== 4 && version !== 6)) return null;
  const max = version === 4 ? 32 : 128;
  const prefix = m[2] === undefined ? max : Number(m[2]);
  return prefix <= max ? { version, prefix } : null;
}

const EnvSchema = z.object({
  NODE_ENV: z.preprocess(emptyToUndefined, z.enum(["development", "test", "production"]).default("development")),
  HOST: z.preprocess(emptyToUndefined, z.string().default("0.0.0.0")),
  PORT: int(8787, 1, 65535),
  LOG_LEVEL: z.preprocess(
    emptyToUndefined,
    z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  ),
  /**
   * live — use real providers whose required settings are complete.
   * fake — use demonstration adapters only (no external inference, no cost).
   */
  PROVIDER_MODE: z.preprocess(emptyToUndefined, z.enum(["live", "fake"]).default("live")),
  // hidden (default): consumer responses never name the AI provider or model; explicit provider
  // routes are treated as DASH AI routing. exposed: engineering/diagnostic mode for tests and smoke runs.
  PROVIDER_DETAILS: z.preprocess(emptyToUndefined, z.enum(["hidden", "exposed"]).default("hidden")),
  OPENAI_API_KEY: optionalString,
  OPENAI_MODEL: optionalString,
  /** Request and replay encrypted reasoning items in tool rounds (reasoning models). Verify live before enabling. */
  OPENAI_ENCRYPTED_REASONING: z.preprocess(emptyToUndefined, z.enum(["true", "false"]).default("false")),
  ANTHROPIC_API_KEY: optionalString,
  ANTHROPIC_MODEL: optionalString,
  /**
   * Amazon Bedrock (Converse streaming API, Amazon Nova models). Server-side only.
   * api_key (default): BEDROCK_API_KEY is a Bedrock API key sent as a bearer token.
   * iam: credentials come from the AWS SDK default chain (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY,
   * a shared profile, or a container or instance role); AWS recommends this for production.
   */
  BEDROCK_AUTH: z.preprocess(emptyToUndefined, z.enum(["api_key", "iam"]).default("api_key")),
  BEDROCK_API_KEY: optionalString,
  BEDROCK_REGION: optionalString,
  BEDROCK_MODEL_MICRO: optionalString,
  BEDROCK_MODEL_LITE: optionalString,
  BEDROCK_MODEL_NOVA2_LITE: optionalString,
  /**
   * Optional USD prices per million tokens for the cost estimate in usage records, as JSON:
   * {"<provider>:<model id or prefix>": {"inputPerMillion": n, "outputPerMillion": n}}. Overrides the
   * built-in Amazon Nova estimates; OpenAI/Anthropic costs stay unknown unless listed here.
   */
  MODEL_PRICES: optionalString,
  /**
   * AI cost and provider controls (docs/provider-platform.md). Defaults keep today's behaviour: AI on,
   * the free pool and Bedrock off, paid providers allowed when configured, no limit enforced unless set
   * (production in live mode refuses to start without the daily and monthly limits).
   */
  AI_ENABLED: bool("true"),
  FREE_POOL_ENABLED: bool("false"),
  PAID_PROVIDERS_ENABLED: bool("true"),
  /**
   * BEDROCK_ENABLED (default false): Bedrock may serve requests. BEDROCK_FALLBACK_ENABLED is its
   * deprecated former name, still read; when both are set they must agree (see bedrockSwitch).
   */
  BEDROCK_ENABLED: optionalBool,
  BEDROCK_FALLBACK_ENABLED: optionalBool,
  MAX_DAILY_AI_SPEND: usd,
  MAX_MONTHLY_AI_SPEND: usd,
  MAX_REQUEST_AI_COST: usd,
  MAX_USER_DAILY_AI_SPEND: usd,
  /** JSON {"<plan>": usd}: daily paid spend per account plan. */
  AI_PLAN_DAILY_SPEND: optionalString,
  AI_DEFAULT_PLAN: z.preprocess(emptyToUndefined, z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/).default("standard")),
  AI_DEFAULT_SENSITIVITY: z.preprocess(emptyToUndefined, z.enum(["sensitive", "standard"]).default("sensitive")),
  /** JSON array of approved OpenAI-compatible providers (keys are read from the variables they name). */
  COMPATIBLE_PROVIDERS: optionalString,
  /** JSON {"<provider>": {windows: [...], softThreshold}}: quota windows per provider. */
  PROVIDER_QUOTAS: optionalString,
  PROVIDER_TIMEOUT_MS: int(120_000, 1_000, 600_000),
  PROVIDER_IDLE_TIMEOUT_MS: int(45_000, 500, 300_000),
  /** Extra attempts after a retryable provider failure that happened before any output (0 = none). */
  PROVIDER_MAX_RETRIES: int(2, 0, 4),
  /** First retry delay; doubles each attempt (with jitter), longer after rate limiting. */
  PROVIDER_RETRY_BASE_MS: int(500, 0, 10_000),
  /** Includes any reasoning/thinking tokens on models that think, so it must leave room for both. */
  MAX_OUTPUT_TOKENS: int(16_000, 16, 128_000),
  FAKE_STREAM_DELAY_MS: int(25, 0, 5_000),
  /** Wall-clock limit for parsing one PDF or DOCX in the isolated extraction process. */
  DOCUMENT_EXTRACTION_TIMEOUT_MS: int(20_000, 1_000, 120_000),
  /** Extraction processes running at once per instance. */
  DOCUMENT_EXTRACTION_CONCURRENCY: int(2, 1, 16),
  /** Uploads that may wait for an extraction process per instance (their bodies are in memory); more are refused as busy. */
  DOCUMENT_EXTRACTION_QUEUE: int(6, 0, 100),
  /** Uploads one account may have in progress per instance (receiving, waiting or extracting). */
  DOCUMENT_UPLOADS_PER_ACCOUNT: int(4, 1, 100),
  /** How long an upload may wait for an extraction process before it is refused as busy. */
  DOCUMENT_EXTRACTION_QUEUE_WAIT_MS: int(15_000, 100, 120_000),
  /** Documents one account may keep (each holds at most 200,000 extracted characters). */
  DOCUMENTS_MAX_PER_ACCOUNT: int(200, 1, 10_000),
  RATE_LIMIT_CHAT_PER_MINUTE: int(20, 1, 10_000),
  RATE_LIMIT_SYNC_PER_MINUTE: int(60, 1, 10_000),
  RATE_LIMIT_AUTH_PER_MINUTE: int(10, 1, 10_000),
  RATE_LIMIT_UPLOAD_PER_MINUTE: int(10, 1, 10_000),
  RATE_LIMIT_API_PER_MINUTE: int(240, 1, 100_000),
  /** Sign-in attempts per account (email) per 15 minutes, from any number of IPs. */
  RATE_LIMIT_LOGIN_PER_ACCOUNT: int(20, 1, 1_000),
  /**
   * memory — limits are per API process (one instance, development, tests).
   * redis — limits are shared by every instance through REDIS_URL (required when running more than one).
   */
  RATE_LIMIT_BACKEND: z.preprocess(emptyToUndefined, z.enum(["memory", "redis"]).default("memory")),
  /** redis:// or rediss:// (TLS). Secret: it usually contains a password. */
  REDIS_URL: optionalString,
  /** Prefix for every Redis key DASH AI writes (rate limits and shared stream state). */
  REDIS_KEY_PREFIX: z.preprocess(emptyToUndefined, z.string().regex(/^[A-Za-z0-9:_-]{1,64}$/).default("dash:")),
  /** Per account, across every instance (shared through Redis with RATE_LIMIT_BACKEND=redis). */
  MAX_CONCURRENT_STREAMS_PER_USER: int(3, 1, 50),
  /** How long a stream slot outlives its instance's last heartbeat (a crashed instance's slots free up after this). */
  STREAM_SLOT_TTL_MS: int(20_000, 2_000, 300_000),
  /**
   * On SIGTERM: how long active answers, automation runs and push sends may keep going (no new work
   * is accepted and /ready answers 503) before they are stopped and the process exits.
   */
  SHUTDOWN_DRAIN_MS: int(20_000, 0, 600_000),
  SESSION_TTL_DAYS: int(30, 1, 365),
  /**
   * Which X-Forwarded-For entries to believe for the client IP (per-IP rate limits depend on it):
   * "false" (direct traffic), the number of proxies in front of the API (for example 1 behind one load
   * balancer), or a comma-separated list of the proxies' addresses/CIDRs. "true" believes every entry,
   * so a client can choose its own IP: development and tests only (production refuses it, and any /0 range).
   */
  TRUST_PROXY: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .trim()
      .default("false")
      .refine(
        (v) => v === "true" || v === "false" || /^([1-9]|10)$/.test(v) || v.split(",").every((p) => proxyRange(p.trim()) !== null),
        "TRUST_PROXY must be false, true, a proxy count from 1 to 10, or comma-separated proxy addresses/CIDRs",
      ),
  ),

  /** PostgreSQL connection string. Unset = in-memory store (development and tests only). */
  DATABASE_URL: optionalString,
  /** TLS to the database. Defaults to "require" in production and "disable" elsewhere. */
  DATABASE_SSL: z.preprocess(emptyToUndefined, z.enum(["disable", "require", "no-verify"]).optional()),
  DATABASE_POOL_MAX: int(10, 1, 100),
  DATABASE_POOL_ACQUIRE_TIMEOUT_MS: int(5_000, 250, 60_000),
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
  /** Bearer token for GET /metrics. Unset = the metrics endpoint does not exist. Secret. */
  METRICS_TOKEN: z.preprocess(emptyToUndefined, z.string().trim().min(24).optional()),
  /**
   * Bearer token for the operator view of the internal provider configuration (GET /v1/providers).
   * A separate credential from METRICS_TOKEN: a metrics scraper never gets operator access. Unset = no
   * operator access when provider details are hidden. Secret.
   */
  OPERATOR_TOKEN: z.preprocess(emptyToUndefined, z.string().trim().min(32).optional()),
  /**
   * DASH Intelligence Router policy override (JSON, merged over the defaults): provider profiles
   * (capabilities, context size, relative cost, quality per route), task weights, preferences and
   * the circuit breaker. Empty = defaults. See docs/intelligence-router.md.
   */
  ROUTER_POLICY: optionalString,
  /** Server-side scheduled tasks (DASH Automates). false stops the scheduler and refuses new runs. */
  AUTOMATIONS_ENABLED: z.preprocess(emptyToUndefined, z.enum(["true", "false"]).default("true")),
  /** How often each instance looks for due automations and queued runs. */
  AUTOMATIONS_TICK_MS: int(15_000, 1_000, 600_000),
  /** Automation runs one instance executes at the same time. */
  AUTOMATIONS_CONCURRENCY: int(2, 1, 32),
  /** Automations one account may keep. */
  AUTOMATIONS_MAX_PER_USER: int(25, 1, 500),
  /**
   * How Automates push notifications are delivered. none (default): not at all (results and in-app
   * notices still work). fcm: Android through Firebase Cloud Messaging (needs FCM_SERVICE_ACCOUNT).
   * fake: recorded, never sent (development and tests).
   */
  PUSH_TRANSPORT: z.preprocess(emptyToUndefined, z.enum(["none", "fcm", "fake"]).default("none")),
  /** Firebase service-account JSON key (raw or base64) with permission to send FCM messages. Secret. */
  FCM_SERVICE_ACCOUNT: optionalString,
  /** How often each instance looks for due push deliveries (a finished run also triggers a pass). */
  PUSH_TICK_MS: int(5_000, 500, 600_000),
  /** Send attempts per device before a push is given up (the in-app notice stays). */
  PUSH_MAX_ATTEMPTS: int(5, 1, 10),
  /** First retry delay; doubles each attempt (with jitter), capped at an hour. */
  PUSH_RETRY_BASE_MS: int(30_000, 100, 3_600_000),
  /** How long a push may wait for an offline device, and the oldest notice still pushed. */
  PUSH_TTL_SECONDS: int(86_400, 60, 2_419_200),
  /** Production refuses to start on the in-memory store unless this is "true". */
  ALLOW_MEMORY_STORE: z.preprocess(emptyToUndefined, z.enum(["true", "false"]).default("false")),
});

export type Env = z.infer<typeof EnvSchema>;

/** Every environment variable the API reads (kept in sync with .env.example by a test). */
export const ENV_KEYS: readonly string[] = Object.keys(EnvSchema.shape);
/** Deprecated names still read for compatibility; templates leave them out so new environments use the new name. */
export const DEPRECATED_ENV_KEYS: readonly string[] = ["BEDROCK_FALLBACK_ENABLED"];

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
  /** Whether consumer responses may carry provider identity (production refuses to start with exposed). */
  providerDetails: Env["PROVIDER_DETAILS"];
  openai: ProviderConfig & { encryptedReasoning: boolean };
  anthropic: ProviderConfig;
  bedrock: BedrockCredentials;
  /** Operator prices for estimated USD cost (MODEL_PRICES); built-in estimates fill the gaps. */
  modelPrices: ModelPrices;
  /** Global AI switches and spend limits. */
  ai: AiControls;
  /** Deprecated environment variables in use, with what replaces them (logged at start-up in every environment). */
  deprecations: string[];
  /** Approved OpenAI-compatible providers registered by configuration. */
  compatibleProviders: CompatibleProviderSettings[];
  /** Quota windows per provider (PROVIDER_QUOTAS, plus those declared with compatible providers). */
  providerQuotas: ProviderQuotas;
  providerTimeoutMs: number;
  providerIdleTimeoutMs: number;
  providerRetry: { maxRetries: number; baseMs: number };
  maxOutputTokens: number;
  fakeStreamDelayMs: number;
  documentExtractionTimeoutMs: number;
  documentExtraction: { concurrency: number; queue: number; queueWaitMs: number; perAccount: number };
  documentsMaxPerAccount: number;
  rateLimits: {
    chatPerMinute: number;
    authPerMinute: number;
    uploadPerMinute: number;
    apiPerMinute: number;
    syncPerMinute: number;
    loginPerAccountPer15Min: number;
    backend: "memory" | "redis";
    redisUrl: string | undefined;
    redisKeyPrefix: string;
  };
  metricsToken: string | undefined;
  /** Operator credential for GET /v1/providers; never the same value as metricsToken. */
  operatorToken: string | undefined;
  maxConcurrentStreamsPerUser: number;
  streamSlotTtlMs: number;
  shutdownDrainMs: number;
  sessionTtlDays: number;
  /** Passed to Fastify: false, true (every hop; development only), a hop count, or proxy addresses. */
  trustProxy: boolean | number | string;
  database: {
    url: string | undefined;
    ssl: "disable" | "require" | "no-verify";
    poolMax: number;
    acquireTimeoutMs: number;
    autoMigrate: boolean;
    allowMemoryStore: boolean;
  };
  tools: { enabled: boolean; timeoutMs: number; maxRounds: number; maxResultChars: number };
  routerPolicy: RouterPolicy;
  automations: { enabled: boolean; tickMs: number; concurrency: number; maxPerUser: number };
  push: {
    transport: "none" | "fcm" | "fake";
    /** Parsed FCM_SERVICE_ACCOUNT (secret). */
    fcm: FcmServiceAccount | undefined;
    tickMs: number;
    maxAttempts: number;
    retryBaseMs: number;
    ttlSeconds: number;
  };
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
  if (e.RATE_LIMIT_BACKEND === "redis" && !e.REDIS_URL) {
    throw new ConfigError("Invalid configuration: REDIS_URL is required when RATE_LIMIT_BACKEND=redis.");
  }
  // Believing every X-Forwarded-For entry lets a client choose its own IP and get around per-IP limits.
  // Production must name its proxies (a count, or addresses narrower than "everything").
  if (e.NODE_ENV === "production" && e.TRUST_PROXY === "true") {
    throw new ConfigError(
      "Invalid configuration: TRUST_PROXY=true is not allowed in production (every X-Forwarded-For entry would be believed, so a " +
        "client could pick its own IP and get around per-IP rate limits). Set the number of proxies in front of the API (for example 1) or their addresses/CIDRs.",
    );
  }
  if (e.NODE_ENV === "production" && e.TRUST_PROXY.split(",").some((p) => proxyRange(p.trim())?.prefix === 0)) {
    throw new ConfigError(
      "Invalid configuration: TRUST_PROXY must not contain a /0 range in production (it trusts every address, the same as true). " +
        "Name the proxies' own addresses or subnets.",
    );
  }
  if (e.OPERATOR_TOKEN && e.OPERATOR_TOKEN === e.METRICS_TOKEN) {
    throw new ConfigError("Invalid configuration: OPERATOR_TOKEN must be a different secret from METRICS_TOKEN.");
  }
  let fcm: FcmServiceAccount | undefined;
  if (e.PUSH_TRANSPORT === "fcm") {
    if (!e.FCM_SERVICE_ACCOUNT) throw new ConfigError("Invalid configuration: FCM_SERVICE_ACCOUNT is required when PUSH_TRANSPORT=fcm.");
    try {
      fcm = parseServiceAccount(e.FCM_SERVICE_ACCOUNT);
    } catch (err) {
      if (err instanceof FcmConfigError) throw new ConfigError(`Invalid configuration: ${err.message}`);
      throw err;
    }
  }
  let modelPrices: ModelPrices = {};
  if (e.MODEL_PRICES) {
    let raw: unknown;
    try {
      raw = JSON.parse(e.MODEL_PRICES);
    } catch {
      throw new ConfigError("Invalid configuration: MODEL_PRICES is not valid JSON.");
    }
    const parsedPrices = ModelPrices.safeParse(raw);
    if (!parsedPrices.success) {
      // Field names only: the keys are operator text and are not echoed.
      const where = parsedPrices.error.issues
        .slice(0, 3)
        .map((i) =>
          i.code === "invalid_key"
            ? `has an invalid key: ${i.issues[0]?.message ?? i.message}`
            : i.path.length > 1
              ? `an entry's ${String(i.path.at(-1))}: ${i.message}`
              : i.message,
        )
        .join("; ");
      throw new ConfigError(`Invalid configuration: MODEL_PRICES ${where}`);
    }
    modelPrices = parsedPrices.data;
  }
  let compatibleProviders: CompatibleProviderSettings[];
  let providerQuotas: ProviderQuotas;
  let planDailyUsd: Record<string, number>;
  try {
    compatibleProviders = parseCompatibleProviders(e.COMPATIBLE_PROVIDERS, env, ENV_KEYS, e.NODE_ENV === "production");
    providerQuotas = {
      ...Object.fromEntries(compatibleProviders.filter((p) => p.quota).map((p) => [p.id, p.quota!])),
      ...parseQuotas(e.PROVIDER_QUOTAS),
    };
    planDailyUsd = parsePlanLimits(e.AI_PLAN_DAILY_SPEND);
  } catch (err) {
    if (err instanceof SettingsError) throw new ConfigError(`Invalid configuration: ${err.message}`);
    throw err;
  }
  // A compatible provider's declared prices price its model, unless MODEL_PRICES says otherwise.
  const declaredPrices: ModelPrices = Object.fromEntries(
    compatibleProviders
      .filter((p) => p.inputPerMillion !== null && p.outputPerMillion !== null)
      .map((p) => [`${p.id}:${p.model}`, { inputPerMillion: p.inputPerMillion!, outputPerMillion: p.outputPerMillion! }]),
  );
  modelPrices = { ...declaredPrices, ...modelPrices };
  let routerPolicy: RouterPolicy;
  try {
    routerPolicy = loadPolicy(e.ROUTER_POLICY, Object.fromEntries(compatibleProviders.map((p) => [p.id, compatibleProfile(p)])));
  } catch (err) {
    if (err instanceof PolicyError) throw new ConfigError(`Invalid configuration: ${err.message}`);
    throw err;
  }
  const bedrockSwitched = bedrockSwitch(e.BEDROCK_ENABLED, e.BEDROCK_FALLBACK_ENABLED);
  const bedrockEnabled = bedrockSwitched.enabled;
  // Bedrock serves traffic only when BEDROCK_ENABLED is on, whatever ROUTER_POLICY says.
  if (!bedrockEnabled && routerPolicy.providers.bedrock) {
    routerPolicy = { ...routerPolicy, providers: { ...routerPolicy.providers, bedrock: { ...routerPolicy.providers.bedrock, enabled: false } } };
  }
  const ai: AiControls = {
    enabled: e.AI_ENABLED === "true",
    freePoolEnabled: e.FREE_POOL_ENABLED === "true",
    paidProvidersEnabled: e.PAID_PROVIDERS_ENABLED === "true",
    bedrockEnabled,
    defaultPlan: e.AI_DEFAULT_PLAN,
    defaultSensitivity: e.AI_DEFAULT_SENSITIVITY,
    limits: {
      requestUsd: e.MAX_REQUEST_AI_COST ?? null,
      userDailyUsd: e.MAX_USER_DAILY_AI_SPEND ?? null,
      systemDailyUsd: e.MAX_DAILY_AI_SPEND ?? null,
      systemMonthlyUsd: e.MAX_MONTHLY_AI_SPEND ?? null,
      planDailyUsd,
    },
  };
  // Production with real providers must be able to answer: a missing, half-set or example key is a
  // deployment mistake, so the server refuses to start instead of failing every chat and automation.
  // Development and tests keep starting (the registry warns). Variable names only, never values.
  const bedrock: BedrockCredentials = {
    auth: e.BEDROCK_AUTH,
    apiKey: e.BEDROCK_API_KEY,
    region: e.BEDROCK_REGION,
    models: { micro: e.BEDROCK_MODEL_MICRO, lite: e.BEDROCK_MODEL_LITE, nova2Lite: e.BEDROCK_MODEL_NOVA2_LITE },
  };
  // The engineering view opens the operator routes (/v1/providers, /v1/router: provider settings,
  // prices, spend) without the operator token and lets requests pick a provider directly, outside
  // worst-case spend admission. It is for tests and diagnostics, never a production server.
  if (e.NODE_ENV === "production" && e.PROVIDER_DETAILS === "exposed") {
    throw new ConfigError(
      "Invalid configuration: PROVIDER_DETAILS=exposed is not allowed in production (it opens the operator views without " +
        "OPERATOR_TOKEN and lets requests choose a provider directly). Use PROVIDER_DETAILS=hidden.",
    );
  }
  if (e.NODE_ENV === "production" && e.PROVIDER_MODE === "live") {
    const problems = [
      ...liveProviderProblems({
        openai: { apiKey: e.OPENAI_API_KEY, model: e.OPENAI_MODEL },
        anthropic: { apiKey: e.ANTHROPIC_API_KEY, model: e.ANTHROPIC_MODEL },
        bedrock,
        bedrockEnabled,
        compatible: compatibleProviders,
      }),
      ...costControlProblems({ ai, prices: modelPrices, openaiModel: e.OPENAI_MODEL, anthropicModel: e.ANTHROPIC_MODEL, bedrock, compatible: compatibleProviders }),
    ];
    if (problems.length > 0) {
      throw new ConfigError(
        `Invalid configuration: PROVIDER_MODE=live needs real AI provider credentials in production. ${problems.join(" ")} ` +
          "Set them in the server's secret store, or PROVIDER_MODE=fake for a demonstration server.",
      );
    }
  }
  return {
    nodeEnv: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    providerMode: e.PROVIDER_MODE,
    providerDetails: e.PROVIDER_DETAILS,
    openai: { apiKey: e.OPENAI_API_KEY, model: e.OPENAI_MODEL, encryptedReasoning: e.OPENAI_ENCRYPTED_REASONING === "true" },
    anthropic: { apiKey: e.ANTHROPIC_API_KEY, model: e.ANTHROPIC_MODEL },
    bedrock,
    modelPrices,
    ai,
    compatibleProviders,
    providerQuotas,
    providerTimeoutMs: e.PROVIDER_TIMEOUT_MS,
    providerIdleTimeoutMs: e.PROVIDER_IDLE_TIMEOUT_MS,
    providerRetry: { maxRetries: e.PROVIDER_MAX_RETRIES, baseMs: e.PROVIDER_RETRY_BASE_MS },
    maxOutputTokens: e.MAX_OUTPUT_TOKENS,
    fakeStreamDelayMs: e.FAKE_STREAM_DELAY_MS,
    documentExtractionTimeoutMs: e.DOCUMENT_EXTRACTION_TIMEOUT_MS,
    documentExtraction: { concurrency: e.DOCUMENT_EXTRACTION_CONCURRENCY, queue: e.DOCUMENT_EXTRACTION_QUEUE, queueWaitMs: e.DOCUMENT_EXTRACTION_QUEUE_WAIT_MS, perAccount: e.DOCUMENT_UPLOADS_PER_ACCOUNT },
    documentsMaxPerAccount: e.DOCUMENTS_MAX_PER_ACCOUNT,
    rateLimits: {
      chatPerMinute: e.RATE_LIMIT_CHAT_PER_MINUTE,
      syncPerMinute: e.RATE_LIMIT_SYNC_PER_MINUTE,
      authPerMinute: e.RATE_LIMIT_AUTH_PER_MINUTE,
      uploadPerMinute: e.RATE_LIMIT_UPLOAD_PER_MINUTE,
      apiPerMinute: e.RATE_LIMIT_API_PER_MINUTE,
      loginPerAccountPer15Min: e.RATE_LIMIT_LOGIN_PER_ACCOUNT,
      backend: e.RATE_LIMIT_BACKEND,
      redisUrl: e.REDIS_URL,
      redisKeyPrefix: e.REDIS_KEY_PREFIX,
    },
    metricsToken: e.METRICS_TOKEN,
    operatorToken: e.OPERATOR_TOKEN,
    maxConcurrentStreamsPerUser: e.MAX_CONCURRENT_STREAMS_PER_USER,
    streamSlotTtlMs: e.STREAM_SLOT_TTL_MS,
    shutdownDrainMs: e.SHUTDOWN_DRAIN_MS,
    sessionTtlDays: e.SESSION_TTL_DAYS,
    trustProxy: e.TRUST_PROXY === "true" ? true : e.TRUST_PROXY === "false" ? false : /^\d+$/.test(e.TRUST_PROXY) ? Number(e.TRUST_PROXY) : e.TRUST_PROXY,
    database: {
      url: e.DATABASE_URL,
      ssl: e.DATABASE_SSL ?? (e.NODE_ENV === "production" ? "require" : "disable"),
      poolMax: e.DATABASE_POOL_MAX,
      acquireTimeoutMs: e.DATABASE_POOL_ACQUIRE_TIMEOUT_MS,
      autoMigrate: e.DATABASE_AUTO_MIGRATE ? e.DATABASE_AUTO_MIGRATE === "true" : e.NODE_ENV !== "production",
      allowMemoryStore: e.ALLOW_MEMORY_STORE === "true",
    },
    tools: {
      enabled: e.TOOLS_ENABLED === "true",
      timeoutMs: e.TOOL_TIMEOUT_MS,
      maxRounds: e.TOOL_MAX_ROUNDS,
      maxResultChars: e.TOOL_MAX_RESULT_CHARS,
    },
    routerPolicy,
    automations: {
      enabled: e.AUTOMATIONS_ENABLED === "true",
      tickMs: e.AUTOMATIONS_TICK_MS,
      concurrency: e.AUTOMATIONS_CONCURRENCY,
      maxPerUser: e.AUTOMATIONS_MAX_PER_USER,
    },
    push: {
      transport: e.PUSH_TRANSPORT,
      fcm,
      tickMs: e.PUSH_TICK_MS,
      maxAttempts: e.PUSH_MAX_ATTEMPTS,
      retryBaseMs: e.PUSH_RETRY_BASE_MS,
      ttlSeconds: e.PUSH_TTL_SECONDS,
    },
    dataEncryption: {
      key: e.DATA_ENCRYPTION_KEY,
      keyId: e.DATA_ENCRYPTION_KEY_ID,
      previousKeys: e.DATA_ENCRYPTION_PREVIOUS_KEYS,
    },
    version: "0.1.0",
    deprecations: bedrockSwitched.deprecation ? [bedrockSwitched.deprecation] : [],
  };
}

/**
 * The Bedrock switch. BEDROCK_ENABLED is the name; BEDROCK_FALLBACK_ENABLED, its former name, is still
 * read so existing environments keep working. BEDROCK_ENABLED wins only by being the same: when both
 * are set to different values the server refuses to start, so a half-finished rename can never
 * switch Bedrock on or off silently.
 */
export function bedrockSwitch(current: "true" | "false" | undefined, deprecated: "true" | "false" | undefined): { enabled: boolean; deprecation: string | null } {
  if (current !== undefined && deprecated !== undefined && current !== deprecated) {
    throw new ConfigError(
      `Invalid configuration: BEDROCK_ENABLED=${current} and the deprecated BEDROCK_FALLBACK_ENABLED=${deprecated} disagree. ` +
        "Remove BEDROCK_FALLBACK_ENABLED and keep the value you want in BEDROCK_ENABLED.",
    );
  }
  const deprecation =
    deprecated === undefined
      ? null
      : current === undefined
        ? `BEDROCK_FALLBACK_ENABLED is deprecated: rename it to BEDROCK_ENABLED (same value, ${deprecated}).`
        : "BEDROCK_FALLBACK_ENABLED is deprecated and set to the same value as BEDROCK_ENABLED: remove it.";
  return { enabled: (current ?? deprecated ?? "false") === "true", deprecation };
}

/**
 * Explicit production settings that weaken security. Insecure *defaults* are refused elsewhere
 * (no database, no encryption key, malformed keys); these are deliberate opt-outs, so they are
 * logged loudly at start-up instead.
 */
export function configWarnings(config: AppConfig): string[] {
  if (config.nodeEnv !== "production") return [...config.deprecations];
  const warnings: string[] = [...config.deprecations];
  if (config.database.url && config.database.ssl === "disable") {
    warnings.push("DATABASE_SSL=disable in production: database traffic (including session hashes and ciphertext) is not encrypted in transit.");
  }
  if (config.database.url && config.database.ssl === "no-verify") {
    warnings.push("DATABASE_SSL=no-verify in production: the database certificate is not verified, so a network attacker can impersonate the database.");
  }
  if (config.logLevel === "debug" || config.logLevel === "trace") {
    warnings.push(`LOG_LEVEL=${config.logLevel} in production: verbose logs are larger and record more request detail. Use info.`);
  }
  if (config.rateLimits.backend === "memory") {
    warnings.push(
      "RATE_LIMIT_BACKEND=memory in production: rate limits, the per-account stream limit, Stop and account-deletion cancels are per instance. " +
        "With more than one API instance, set RATE_LIMIT_BACKEND=redis and REDIS_URL (a multi-instance deployment without shared Redis is not valid).",
    );
  }
  if (config.rateLimits.redisUrl?.startsWith("redis://") && config.rateLimits.backend === "redis") {
    warnings.push("REDIS_URL uses redis:// in production: traffic to Redis is not encrypted in transit. Use rediss:// unless Redis is on a private network.");
  }
  if (config.push.transport === "fake") {
    warnings.push("PUSH_TRANSPORT=fake in production: push notifications are recorded but never delivered. Use fcm, or none.");
  }
  if (config.providerMode === "fake") {
    warnings.push("PROVIDER_MODE=fake in production: every answer is a labelled demonstration, not a real model.");
  }
  if (
    config.providerMode === "live" &&
    liveProviderCount({ ...config, bedrockEnabled: config.ai.bedrockEnabled, compatible: config.compatibleProviders }) === 1
  ) {
    warnings.push("Only one AI provider is configured in production: if it fails, DASH AI has no second provider to fall back to. Configure another live provider for failover.");
  }
  return warnings;
}
