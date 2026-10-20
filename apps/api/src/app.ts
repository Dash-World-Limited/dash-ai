import multipart from "@fastify/multipart";
import { LIMITS } from "@dash-ai/contracts";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from "fastify";
import { makeRequireAuth } from "./auth/requireAuth.js";
import type { RedisStreamControl } from "./chat/streamControl.js";
import { StreamRegistry } from "./chat/streamRegistry.js";
import { ExtractionGate } from "./documents/gate.js";
import type { AppConfig } from "./config.js";
import { AppError, busyError } from "./errors.js";
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
  /**
   * Shared stream slots and cross-instance cancellation (index.ts passes Redis with
   * RATE_LIMIT_BACKEND=redis). Without it, the stream limit and cancel are per process.
   */
  streamControl?: RedisStreamControl;
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

/** Trusts the nearest `hops` addresses (the load balancers), never what the client wrote before them. */
const trustHops = (hops: number) => (_address: string, hop: number): boolean => hop < hops;

export interface DashApp {
  app: FastifyInstance;
  context: RouteContext;
  /**
   * Shutdown, step 1 (before app.close): the instance turns not-ready, accepts no new answers or
   * uploads, and its schedulers claim nothing new; work in progress gets up to `windowMs` to finish.
   * Whatever is still running at the deadline is stopped by app.close (answers saved as stopped,
   * automation runs as interrupted, spend holds settled).
   */
  drain(windowMs: number): Promise<"drained" | "deadline">;
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
    // A proxy count trusts exactly that many hops from the API (how proxy-addr reads a number).
    trustProxy: typeof config.trustProxy === "number" ? trustHops(config.trustProxy) : config.trustProxy,
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

  // At most one warning per operation per 5 s while Redis is unreachable (every failure is counted).
  const lastStreamControlWarning = new Map<string, number>();
  const reportStreamControlError = (op: string, errorName: string) => {
    const at = Date.now();
    if (at - (lastStreamControlWarning.get(op) ?? 0) < 5_000) return;
    lastStreamControlWarning.set(op, at);
    app.log.warn({ op, errorName }, "shared stream state unavailable: new answers are refused until Redis answers (fail closed)");
  };

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
    streams: new StreamRegistry(deps.streamControl, {
      onAdmission: (outcome) => metrics.streamAdmissions.inc({ outcome }),
      onStop: (source) => metrics.streamStops.inc({ source }),
      onBackendError: (op, errorName) => {
        metrics.streamControlErrors.inc({ op });
        reportStreamControlError(op, errorName);
      },
      onActiveChange: (active) => metrics.activeStreams.set({}, active),
    }),
    lifecycle: { draining: false, stopped: new AbortController() },
    extraction: new ExtractionGate(
      {
        maxActive: config.documentExtraction.concurrency,
        maxWaiting: config.documentExtraction.queue,
        maxPerAccount: config.documentExtraction.perAccount,
        maxWaitMs: config.documentExtraction.queueWaitMs,
      },
      (state) => {
        metrics.extractionActive.set({}, state.active);
        metrics.extractionWaiting.set({}, state.waiting);
      },
    ),
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

  // While draining, new long-running work goes to another instance; everything else (cancels,
  // reads, sync) is still served until the process exits.
  const newWork = (request: FastifyRequest) => request.method === "POST" && (request.url === "/v1/chat/stream" || request.url === "/v1/documents");

  // Broad abuse protection for every route, keyed by client IP.
  app.addHook("onRequest", async (request, reply) => {
    // Load-balancer probes are not rate limited (they come from one address, very often).
    if (request.url === "/health" || request.url === "/ready") return;
    if (context.lifecycle.draining && newWork(request)) {
      metrics.busyRejections.inc({ reason: "draining" });
      void reply.header("Connection", "close");
      throw busyError();
    }
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
    // A draining instance closes each connection after its response, so close() never waits on keep-alive.
    if (context.lifecycle.draining) reply.header("Connection", "close");
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

  // Before the server waits for in-flight requests: whatever the drain left running is stopped now,
  // so close() is bounded (answers end as stopped; runs as interrupted; spend holds settle).
  app.addHook("preClose", async () => {
    context.lifecycle.draining = true;
    context.streams.cancelAll("shutdown");
    context.extraction.close();
    context.lifecycle.stopped.abort("shutdown");
    // What was stopped writes its last event within milliseconds; after that, any connection still
    // open (a stuck client, an idle keep-alive) is closed so close() can never hang on it.
    setTimeout(() => app.server.closeAllConnections(), 1_500).unref();
    automations.beginDrain();
    push.beginDrain();
  });
  app.addHook("onClose", async () => {
    await automations.stop();
    await push.stop();
    await context.streams.close();
  });
  // The caller that created the store (index.ts / tests) owns closing it.

  const drain = async (windowMs: number): Promise<"drained" | "deadline"> => {
    context.lifecycle.draining = true;
    metrics.draining.set({}, 1);
    automations.beginDrain();
    push.beginDrain();
    const deadline = Date.now() + windowMs;
    const busy = () => context.streams.size > 0 || automations.busy || push.busy;
    while (busy() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    const outcome = busy() ? "deadline" : "drained";
    metrics.shutdownDrains.inc({ outcome });
    return outcome;
  };

  return { app, context, drain };
}
