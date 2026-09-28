import { SMART_ROUTING, type HealthResponse, type ProvidersResponse } from "@dash-ai/contracts";
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.js";

export function systemRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const health = async (): Promise<HealthResponse> => ({
    status: "ok",
    version: ctx.config.version,
    uptimeSeconds: Math.round((Date.now() - ctx.startedAt) / 1000),
  });
  app.get("/health", health);
  app.get("/v1/health", health);

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
