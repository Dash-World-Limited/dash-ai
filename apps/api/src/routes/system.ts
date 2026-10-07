import { SMART_ROUTING, type HealthResponse, type ProvidersResponse } from "@dash-ai/contracts";
import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "../errors.js";
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
   * the instance unready: limits fall back to per-instance ones. No details beyond up/down.
   */
  app.get("/ready", async (_request: FastifyRequest, reply: FastifyReply) => {
    const [database, rateLimits] = await Promise.all([ctx.store.ping(), ctx.rateLimits.store.healthy()]);
    ctx.metrics.databaseUp.set({ store: storeKind(ctx) }, database ? 1 : 0);
    ctx.metrics.rateLimitBackendUp.set({ backend: ctx.rateLimits.store.kind }, rateLimits ? 1 : 0);
    reply.code(database ? 200 : 503);
    return {
      status: database ? (rateLimits ? "ready" : "degraded") : "not_ready",
      checks: { database: database ? "up" : "down", rateLimits: rateLimits ? "up" : "down" },
    };
  });

  /**
   * Prometheus metrics, only when METRICS_TOKEN is configured, and only with that bearer token.
   * Without a token configured the route answers 404 like any unknown path.
   */
  app.get("/metrics", async (request: FastifyRequest, reply: FastifyReply) => {
    const token = ctx.config.metricsToken;
    if (!token) throw new AppError("not_found", "Not found.");
    const given = request.headers.authorization?.startsWith("Bearer ") ? request.headers.authorization.slice(7).trim() : "";
    const a = createHash("sha256").update(given).digest();
    const b = createHash("sha256").update(token).digest();
    if (!timingSafeEqual(a, b)) throw new AppError("unauthorized", "Not authorized.");
    reply.type("text/plain; version=0.0.4");
    return ctx.metrics.render();
  });

  app.get("/v1/providers", async (): Promise<ProvidersResponse> => {
    const configured = ctx.providers.configured();
    return {
      providers: ctx.providers.status(),
      compareAvailable: configured.has("openai") && configured.has("anthropic"),
      smartRouting: { ...SMART_ROUTING } as ProvidersResponse["smartRouting"],
      research: {
        liveSearchAvailable: false,
        note: "No live web search provider is configured. Research answers use the model's built-in knowledge only.",
      },
    };
  });
}

const storeKind = (ctx: RouteContext): string => (ctx.store.constructor.name === "PostgresStore" ? "postgres" : "memory");
