import type { FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import type { AppConfig } from "../config.js";
import type { StreamRegistry } from "../chat/streamRegistry.js";
import type { AutomationService } from "../automations/service.js";
import type { IntelligenceRouter } from "../intelligence/router.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { Metrics } from "../observability/metrics.js";
import type { RateLimitName, RateLimitService } from "../security/rateLimit.js";
import type { Store } from "../store/store.js";
import type { ToolRuntime } from "../tools/runtime.js";

/** Shared dependencies handed to every route module. */
export interface RouteContext {
  config: AppConfig;
  store: Store;
  providers: ProviderRegistry;
  /** The DASH Intelligence Router: every AI request on this server is routed by it. */
  router: IntelligenceRouter;
  /** DASH Automates: scheduler and executor (started by index.ts, not by buildApp). */
  automations: AutomationService;
  tools: ToolRuntime;
  streams: StreamRegistry;
  rateLimits: RateLimitService;
  metrics: Metrics;
  requireAuth: (request: FastifyRequest) => Promise<void>;
  rateLimit: (limit: RateLimitName, key: (request: FastifyRequest) => string) => preHandlerAsyncHookHandler;
  now: () => Date;
  startedAt: number;
}
