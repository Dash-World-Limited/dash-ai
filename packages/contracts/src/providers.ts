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

/**
 * What a consumer client may know about the assistant: whether DASH AI can answer, and whether
 * answers are demonstrations. No provider identity (see ProvidersResponse for the operator view).
 */
export const AssistantStatusResponse = z.object({
  /** False when no AI infrastructure is configured: chat requests will fail with "unavailable". */
  available: z.boolean(),
  /** True when the server runs demonstration adapters: answers must be labelled as demonstrations. */
  demo: z.boolean(),
  research: z.object({ liveSearchAvailable: z.boolean(), note: z.string() }),
});
export type AssistantStatusResponse = z.infer<typeof AssistantStatusResponse>;

/** OPERATOR ONLY (needs the operator token in production): the internal provider configuration. */
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
