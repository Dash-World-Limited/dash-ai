import multipart from "@fastify/multipart";
import { LIMITS } from "@dash-ai/contracts";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from "fastify";
import { makeRequireAuth } from "./auth/requireAuth.js";
import { StreamRegistry } from "./chat/streamRegistry.js";
import type { AppConfig } from "./config.js";
import { AppError } from "./errors.js";
import { loggerOptions, type LogStream } from "./logging.js";
import { AiPlatform } from "./intelligence/platform.js";
import { IntelligenceRouter } from "./intelligence/router.js";
import { ProviderRegistry } from "./providers/registry.js";
import { AutomationService } from "./automations/service.js";
import { FakePushTransport } from "./push/fake.js";
import { FcmTransport } from "./push/fcm.js";
import { PushService } from "./push/service.js";
import type { PushTransport } from "./push/types.js";
import { pushRoutes } from "./routes/push.js";
import { accountRoutes } from "./routes/account.js";
import { automationRoutes } from "./routes/automations.js";
import { authRoutes } from "./routes/auth.js";
import { chatRoutes } from "./routes/chat.js";
import type { RouteContext } from "./routes/context.js";
import { conversationRoutes } from "./routes/conversations.js";
import { documentRoutes } from "./routes/documents.js";
import { pluginRoutes } from "./routes/plugins.js";
import { syncRoutes } from "./routes/sync.js";
import { systemRoutes } from "./routes/system.js";
import { Metrics } from "./observability/metrics.js";
import { MemoryRateLimitStore, RateLimitService, type RateLimitStore } from "./security/rateLimit.js";
import { MemoryStore } from "./store/memoryStore.js";
import type { Store } from "./store/store.js";
import { ToolRuntime } from "./tools/runtime.js";
import type { PluginRegistry } from "./tools/registry.js";

export interface AppDependencies {
  config: AppConfig;
  store?: Store;
  providers?: ProviderRegistry;
  /** Plugins this server knows about. Defaults to the built-in demo plugin only. */
  plugins?: PluginRegistry;
  logStream?: LogStream;
  now?: () => Date;
  /** Where rate-limit buckets live. Defaults to per-process memory; index.ts passes Redis when configured. */
  rateLimitStore?: RateLimitStore;
  metrics?: Metrics;
  /** Push transports. Defaults to what PUSH_TRANSPORT configures (tests pass a fake). */
  pushTransports?: PushTransport[];
}

/** The transports PUSH_TRANSPORT asks for: none, FCM for Android, or a recording fake. */
export function pushTransportsFor(config: AppConfig): PushTransport[] {
  switch (config.push.transport) {
    case "fcm":
      return config.push.fcm ? [new FcmTransport({ account: config.push.fcm })] : [];
    case "fake":
      return [new FakePushTransport()];
    default:
      return [];
  }
}

export interface DashApp {
  app: FastifyInstance;
  context: RouteContext;
}

/** Maps framework errors to the public error shape without leaking internals. */
function toAppError(err: FastifyError & { code?: string }): AppError {
  if (err instanceof AppError) return err;
  switch (err.code) {
    case "FST_ERR_CTP_BODY_TOO_LARGE":
    case "FST_REQ_FILE_TOO_LARGE":
    case "FST_FILES_LIMIT":
    case "FST_PARTS_LIMIT":
      return new AppError("payload_too_large", "The request is too large.");
    case "FST_ERR_CTP_INVALID_MEDIA_TYPE":
    case "FST_INVALID_MULTIPART_CONTENT_TYPE":
      return new AppError("unsupported_media_type", "Unsupported content type.");
    case "FST_ERR_CTP_EMPTY_JSON_BODY":
    case "FST_ERR_CTP_INVALID_JSON_BODY":
      return new AppError("bad_request", "The request body is not valid JSON.");
    default:
      break;
  }
  if (typeof err.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 500) {
    return new AppError("bad_request", "The request could not be processed.", { statusCode: err.statusCode });
  }
  return new AppError("internal_error", "Something went wrong on the Dash AI server.");
}

export async function buildApp(deps: AppDependencies): Promise<DashApp> {
  const { config } = deps;
  const now = deps.now ?? (() => new Date());
  const store = deps.store ?? new MemoryStore();
  const providers = deps.providers ?? ProviderRegistry.fromConfig(config);

  const app = Fastify({
    logger: loggerOptions(config.logLevel, deps.logStream),
    trustProxy: config.trustProxy,
    bodyLimit: 256 * 1024,
    requestTimeout: 0, // chat streams are long-lived; provider timeouts are enforced per stream
    return503OnClosing: true,
    genReqId: () => crypto.randomUUID(),
  });

  await app.register(multipart, {
    limits: { fileSize: LIMITS.maxUploadBytes, files: 1, fields: 0, parts: 1, headerPairs: 50 },
  });

  app.decorateRequest("authUser", null);
  app.decorateRequest("authTokenHash", null);

  const metrics = deps.metrics ?? new Metrics();
  const ai = new AiPlatform({ config, store, providers, log: app.log, metrics, now: () => now().getTime() });
  await ai.seedQuotas();
  const router = new IntelligenceRouter(config.routerPolicy, () => providers.configured(), Date.now, {
    quota: ai.quota,
    controls: () => ai.controls(),
  });
  const minute = 60_000;
  const rateLimits = new RateLimitService(
    deps.rateLimitStore ?? new MemoryRateLimitStore(),
    {
      api: { capacity: config.rateLimits.apiPerMinute, windowMs: minute },
      auth: { capacity: config.rateLimits.authPerMinute, windowMs: minute },
      login: { capacity: config.rateLimits.loginPerAccountPer15Min, windowMs: 15 * minute },
      chat: { capacity: config.rateLimits.chatPerMinute, windowMs: minute },
      sync: { capacity: config.rateLimits.syncPerMinute, windowMs: minute },
      upload: { capacity: config.rateLimits.uploadPerMinute, windowMs: minute },
    },
    { onRejected: (name) => metrics.rateLimitRejections.inc({ limit: name }) },
  );
  const tooMany = (retryAfterMs: number) =>
    new AppError("rate_limited", "Too many requests. Please wait a moment and try again.", {
      retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
    });

  const push = new PushService({ store, transports: deps.pushTransports ?? pushTransportsFor(config), config, log: app.log, metrics, now });
  const automations = new AutomationService({ store, providers, router, ai, config, log: app.log, metrics, now, push });
  const context: RouteContext = {
    config,
    store,
    providers,
    router,
    ai,
    automations,
    push,
    tools: ToolRuntime.fromConfig(config, store, deps.plugins),
    streams: new StreamRegistry(),
    rateLimits,
    metrics,
    requireAuth: makeRequireAuth(store, now),
    rateLimit: (name, key) => async (request: FastifyRequest) => {
      const decision = await rateLimits.consume(name, key(request));
      if (!decision.allowed) throw tooMany(decision.retryAfterMs);
    },
    now,
    startedAt: Date.now(),
  };

  // Broad abuse protection for every route, keyed by client IP.
  app.addHook("onRequest", async (request) => {
    // Load-balancer probes are not rate limited (they come from one address, very often).
    if (request.url === "/health" || request.url === "/ready") return;
    const decision = await rateLimits.consume("api", `api:${request.ip}`);
    if (!decision.allowed) throw tooMany(decision.retryAfterMs);
  });

  // Sync outcomes by operation and status class only (never bodies, ids or user data).
  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions.url;
    const operation = route === "/v1/sync/conversations" ? "pull" : route === "/v1/sync/push" ? "push" : undefined;
    if (!operation) return;
    metrics.syncRequests.inc({ operation });
    const status = reply.statusCode;
    if (status >= 400) {
      metrics.syncFailures.inc({ operation, code: status === 429 ? "rate_limited" : status === 401 ? "unauthorized" : status >= 500 ? "server_error" : "client_error" });
    }
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Cache-Control", "no-store");
    return payload;
  });

  app.setErrorHandler((err: FastifyError, request, reply) => {
    const appError = toAppError(err);
    if (appError.statusCode >= 500) request.log.error({ err }, "request failed");
    else request.log.info({ code: appError.code, statusCode: appError.statusCode }, "request rejected");
    if (appError.retryAfterSeconds !== undefined) reply.header("Retry-After", String(appError.retryAfterSeconds));
    void reply.code(appError.statusCode).send(appError.toResponse());
  });

  app.setNotFoundHandler((_request, reply) => {
    void reply.code(404).send(new AppError("not_found", "Not found.").toResponse());
  });

  systemRoutes(app, context);
  authRoutes(app, context);
  accountRoutes(app, context);
  conversationRoutes(app, context);
  chatRoutes(app, context);
  documentRoutes(app, context);
  pluginRoutes(app, context);
  syncRoutes(app, context);
  automationRoutes(app, context);
  pushRoutes(app, context);

  app.addHook("onClose", async () => {
    context.streams.cancelAll();
    await automations.stop();
    await push.stop();
  });
  // The caller that created the store (index.ts / tests) owns closing it.

  return { app, context };
}
