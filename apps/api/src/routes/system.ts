import { SMART_ROUTING, type AssistantStatusResponse, type HealthResponse, type ProvidersResponse } from "@dash-ai/contracts";
import { hideProviders } from "../chat/publicSurface.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "../errors.js";
import { TaskType } from "../intelligence/policy.js";
import type { RouteContext } from "./context.js";

export function systemRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const health = async (): Promise<HealthResponse> => ({
    status: "ok",
    version: ctx.config.version,
    uptimeSeconds: Math.round((Date.now() - ctx.startedAt) / 1000),
  });
  app.get("/health", health);
  app.get("/v1/health", health);

  /**
   * Readiness for a load balancer: 200 when this instance can serve requests (the database answers),
   * 503 otherwise. A shared rate-limit backend that is down is reported as degraded but does not make
   * the instance unready: limits fall back to per-instance ones. Shared stream state that is down is
   * also "degraded": new answers are refused on every instance alike, so taking this one out of
   * rotation would not help. A draining instance (shutting down) is 503. No details beyond up/down.
   */
  app.get("/ready", async (_request: FastifyRequest, reply: FastifyReply) => {
    const [database, rateLimits, streams] = await Promise.all([ctx.store.ping(), ctx.rateLimits.store.healthy(), ctx.streams.sharedHealthy()]);
    ctx.metrics.databaseUp.set({ store: storeKind(ctx) }, database ? 1 : 0);
    ctx.metrics.rateLimitBackendUp.set({ backend: ctx.rateLimits.store.kind }, rateLimits ? 1 : 0);
    const draining = ctx.lifecycle.draining;
    reply.code(database && !draining ? 200 : 503);
    return {
      status: draining ? "draining" : database ? (rateLimits && streams ? "ready" : "degraded") : "not_ready",
      checks: { database: database ? "up" : "down", rateLimits: rateLimits ? "up" : "down", streams: streams ? "up" : "down" },
    };
  });

  /** True when the request's bearer token is exactly `token` (configured). Constant-time comparison. */
  const bearerMatches = (request: FastifyRequest, token: string | undefined): boolean => {
    if (!token) return false;
    const given = request.headers.authorization?.startsWith("Bearer ") ? request.headers.authorization.slice(7).trim() : "";
    const a = createHash("sha256").update(given).digest();
    const b = createHash("sha256").update(token).digest();
    return timingSafeEqual(a, b);
  };

  /**
   * Prometheus metrics, only when METRICS_TOKEN is configured, and only with that bearer token.
   * Without a token configured the route answers 404 like any unknown path.
   */
  // Event-loop delay between scrapes: a saturated instance shows it before requests start failing.
  const LOOP_RESOLUTION_MS = 20;
  const loopDelay = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
  loopDelay.enable();
  app.addHook("onClose", async () => loopDelay.disable());

  app.get("/metrics", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!ctx.config.metricsToken) throw new AppError("not_found", "Not found.");
    if (!bearerMatches(request, ctx.config.metricsToken)) throw new AppError("unauthorized", "Not authorized.");
    reply.type("text/plain; version=0.0.4");
    // The histogram measures whole timer intervals; report only the delay beyond the sampling interval.
    const beyond = (ns: number) => Math.max(0, ns / 1e9 - LOOP_RESOLUTION_MS / 1000);
    ctx.metrics.eventLoopDelay.set({ stat: "p50" }, beyond(loopDelay.percentile(50)));
    ctx.metrics.eventLoopDelay.set({ stat: "p99" }, beyond(loopDelay.percentile(99)));
    ctx.metrics.eventLoopDelay.set({ stat: "max" }, beyond(loopDelay.max));
    loopDelay.reset();
    ctx.metrics.residentMemory.set({}, process.memoryUsage.rss());
    const pool = ctx.store.poolStats?.();
    if (pool) {
      ctx.metrics.databasePool.set({ state: "total" }, pool.total);
      ctx.metrics.databasePool.set({ state: "idle" }, pool.idle);
      ctx.metrics.databasePool.set({ state: "waiting" }, pool.waiting);
      ctx.metrics.databasePool.set({ state: "max" }, pool.max);
    }
    return ctx.metrics.render();
  });

  const research = {
    liveSearchAvailable: false,
    note: "No live web search is connected. Research answers use DASH AI's built-in knowledge only.",
  };

  /** What consumer apps may know: can DASH AI answer, and are answers demonstrations. No provider identity. */
  app.get("/v1/assistant", async (): Promise<AssistantStatusResponse> => {
    const statuses = ctx.providers.status().filter((p) => p.configured);
    return { available: statuses.length > 0, demo: statuses.length > 0 && statuses.every((p) => p.mode === "fake"), research };
  });

  /**
   * OPERATOR VIEW of the internal provider configuration. With provider details hidden (production)
   * it needs the operator token (OPERATOR_TOKEN, never METRICS_TOKEN or a user session) and is
   * otherwise indistinguishable from an unknown path.
   */
  app.get("/v1/providers", async (request: FastifyRequest): Promise<ProvidersResponse> => {
    if (hideProviders(ctx.config) && !bearerMatches(request, ctx.config.operatorToken)) throw new AppError("not_found", "Not found.");
    const configured = ctx.providers.configured();
    return {
      providers: ctx.providers.status(),
      compareAvailable: configured.has("openai") && configured.has("anthropic"),
      smartRouting: { ...SMART_ROUTING } as ProvidersResponse["smartRouting"],
      research,
    };
  });

  /**
   * OPERATOR VIEW of the DASH Intelligence Router: the active policy, what this instance has observed
   * about each provider (reliability, latency, circuit), and the route each task would take right now.
   * Same protection as /v1/providers. Counts and codes only; never content.
   */
  app.get("/v1/router", async (request: FastifyRequest) => {
    if (hideProviders(ctx.config) && !bearerMatches(request, ctx.config.operatorToken)) throw new AppError("not_found", "Not found.");
    const routes = Object.fromEntries(
      TaskType.options.map((task) => {
        const d = ctx.router.route({ task });
        return [task, d.ok ? { providers: d.providers, candidates: d.candidates } : { unavailable: d.reason, rejected: d.rejected }];
      }),
    );
    return {
      policy: ctx.router.policy,
      health: ctx.router.health.snapshot([...ctx.providers.configured()]),
      routes,
      platform: await ctx.ai.catalog(ctx.router),
    };
  });
}

const storeKind = (ctx: RouteContext): string => (ctx.store.constructor.name === "PostgresStore" ? "postgres" : "memory");
