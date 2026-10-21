import type { FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import type { AppConfig } from "../config.js";
import type { StreamRegistry } from "../chat/streamRegistry.js";
import type { ExtractionGate } from "../documents/gate.js";
import type { AutomationService } from "../automations/service.js";
import type { PushService } from "../push/service.js";
import type { AiPlatform } from "../intelligence/platform.js";
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
  /** Provider and cost controls: switches, quotas, spend limits and the inference ledger. */
  ai: AiPlatform;
  /** DASH Automates: scheduler and executor (started by index.ts, not by buildApp). */
  automations: AutomationService;
  /** Automates push delivery (started by index.ts, not by buildApp). */
  push: PushService;
  tools: ToolRuntime;
  streams: StreamRegistry;
  /** Bounded document-upload backpressure on this instance. */
  extraction: ExtractionGate;
  /** Set when shutdown begins: /ready answers 503 and new answers and uploads are refused. */
  lifecycle: { draining: boolean; /** Aborted when the drain window is over: remaining work stops. */ stopped: AbortController };
  rateLimits: RateLimitService;
  metrics: Metrics;
  requireAuth: (request: FastifyRequest) => Promise<void>;
  rateLimit: (limit: RateLimitName, key: (request: FastifyRequest) => string) => preHandlerAsyncHookHandler;
  now: () => Date;
  startedAt: number;
}
