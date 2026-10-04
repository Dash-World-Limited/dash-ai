import type { FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import type { AppConfig } from "../config.js";
import type { StreamRegistry } from "../chat/streamRegistry.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { RateLimiter } from "../security/rateLimiter.js";
import type { Store } from "../store/store.js";
import type { ToolRuntime } from "../tools/runtime.js";

/** Shared dependencies handed to every route module. */
export interface RouteContext {
  config: AppConfig;
  store: Store;
  providers: ProviderRegistry;
  tools: ToolRuntime;
  streams: StreamRegistry;
  limiters: {
    api: RateLimiter;
    auth: RateLimiter;
    chat: RateLimiter;
    sync: RateLimiter;
    upload: RateLimiter;
  };
  requireAuth: (request: FastifyRequest) => Promise<void>;
  rateLimit: (limiter: keyof RouteContext["limiters"], key: (request: FastifyRequest) => string) => preHandlerAsyncHookHandler;
  now: () => Date;
  startedAt: number;
}
