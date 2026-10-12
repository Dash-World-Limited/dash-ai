import type { ProviderId, Usage } from "@dash-ai/contracts";
import { z } from "zod";
import { NOVA_PROFILES } from "../providers/nova.js";

/** USD per million tokens. */
export const ModelPrice = z.object({
  inputPerMillion: z.number().nonnegative().max(10_000),
  outputPerMillion: z.number().nonnegative().max(10_000),
});
export type ModelPrice = z.infer<typeof ModelPrice>;

/**
 * Operator prices (MODEL_PRICES): `{"<provider>:<model id or prefix>": {inputPerMillion, outputPerMillion}}`,
 * for example `{"bedrock:eu.amazon.nova-lite-v1:0": {...}, "openai:gpt-5": {...}}`. The provider is the
 * text before the first ":"; the rest is matched against the model that served the request, exactly
 * or as a prefix (so dated snapshots match). The longest match wins and always beats a built-in price.
 */
export const ModelPrices = z.record(
  z.string().regex(/^[a-z][a-z0-9-]{1,31}:.+$/, "keys look like <provider>:<model id or prefix>"),
  ModelPrice,
);
export type ModelPrices = z.infer<typeof ModelPrices>;

/**
 * Built-in ESTIMATES for the Amazon Nova tiers DASH ships profiles for: on-demand list prices in
 * USD per million tokens. Prices differ by Region and change over time, and cross-Region inference
 * profiles can be priced differently, so the operator confirms them for the deployed Region and
 * sets MODEL_PRICES where they differ. OpenAI and Anthropic models are configured by id at deploy
 * time, so they have no built-in price: their cost stays unknown (null) until MODEL_PRICES names
 * them. Nothing here is ever shown to consumers.
 */
export const BUILT_IN_PRICES: ReadonlyArray<{ provider: ProviderId; pattern: RegExp; price: ModelPrice }> = [
  { provider: "bedrock", pattern: NOVA_PROFILES.micro.idPattern, price: { inputPerMillion: 0.035, outputPerMillion: 0.14 } },
  { provider: "bedrock", pattern: NOVA_PROFILES.lite.idPattern, price: { inputPerMillion: 0.06, outputPerMillion: 0.24 } },
  { provider: "bedrock", pattern: NOVA_PROFILES.nova2Lite.idPattern, price: { inputPerMillion: 0.33, outputPerMillion: 2.75 } },
];

/** The price for the model that served a request: an operator price first, then a built-in one. */
export function priceFor(prices: ModelPrices, provider: ProviderId, model: string): ModelPrice | undefined {
  let best: { length: number; price: ModelPrice } | undefined;
  for (const [key, price] of Object.entries(prices)) {
    const separator = key.indexOf(":");
    if (key.slice(0, separator) !== provider) continue;
    const prefix = key.slice(separator + 1);
    if (model.startsWith(prefix) && (!best || prefix.length > best.length)) best = { length: prefix.length, price };
  }
  if (best) return best.price;
  return BUILT_IN_PRICES.find((p) => p.provider === provider && p.pattern.test(model))?.price;
}

/**
 * Estimated USD cost of one answer: 0 for demonstration answers (nothing was called), null when the
 * price or either token count is unknown (an honest "unknown", never a guess), else tokens × price,
 * rounded to 10 decimal places.
 */
export function estimateCostUsd(
  prices: ModelPrices,
  answer: { provider: ProviderId; model: string; demo: boolean; usage: Usage },
): number | null {
  if (answer.demo) return 0;
  const { inputTokens, outputTokens } = answer.usage;
  if (inputTokens === null || outputTokens === null) return null;
  const price = priceFor(prices, answer.provider, answer.model);
  if (!price) return null;
  const usd = (inputTokens * price.inputPerMillion + outputTokens * price.outputPerMillion) / 1_000_000;
  return Math.round(usd * 1e10) / 1e10;
}
