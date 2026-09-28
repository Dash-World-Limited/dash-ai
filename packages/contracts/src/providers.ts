import { z } from "zod";
import { AssistantMode, ProviderId } from "./common.js";

export const ProviderStatus = z.object({
  id: ProviderId,
  displayName: z.string(),
  /** True when an API key and a model are configured on the server (or fake mode is on). */
  configured: z.boolean(),
  /** Model identifier from server configuration, or null when not configured. */
  model: z.string().nullable(),
  /** "fake" means the server is using a demonstration adapter, never a real provider. */
  mode: z.enum(["live", "fake", "unconfigured"]),
});
export type ProviderStatus = z.infer<typeof ProviderStatus>;

export const ProvidersResponse = z.object({
  providers: z.array(ProviderStatus),
  compareAvailable: z.boolean(),
  smartRouting: z.record(AssistantMode, z.array(ProviderId)),
  research: z.object({
    liveSearchAvailable: z.boolean(),
    note: z.string(),
  }),
});
export type ProvidersResponse = z.infer<typeof ProvidersResponse>;

export const HealthResponse = z.object({
  status: z.literal("ok"),
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
