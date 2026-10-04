import { loadConfig, type AppConfig } from "../config.js";
import { ProviderRegistry } from "../providers/registry.js";
import { SMOKE_MAX_OUTPUT_TOKENS, runAdapterChecks } from "./adapterChecks.js";
import { runAppChecks } from "./appChecks.js";
import { formatResult, makeRedactor, type CheckResult } from "./report.js";

export interface SmokeIo {
  write(text: string): void;
}

export interface SmokeDeps {
  /** Tests inject scripted providers here; the real command always uses the configured live ones. */
  registryFactory?: (config: AppConfig) => ProviderRegistry;
}

export const SMOKE_ENABLE_HINT =
  "Live provider smoke tests are opt-in because they call the real APIs and may cost money.\n" +
  "To run them, put OPENAI_API_KEY/OPENAI_MODEL and/or ANTHROPIC_API_KEY/ANTHROPIC_MODEL in apps/api/.env\n" +
  "(never commit it), then run:  DASH_LIVE_SMOKE=1 PROVIDER_MODE=live pnpm smoke:live\n" +
  "Options: --provider openai|anthropic   --skip-tools\n";

/**
 * Exit codes: 0 all checks passed (or the run was not enabled), 1 a check failed, 2 the run could
 * not start (missing configuration). Secrets are redacted from everything it prints.
 */
export async function runSmokeCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  io: SmokeIo,
  deps: SmokeDeps = {},
): Promise<number> {
  const redact = makeRedactor([env.OPENAI_API_KEY, env.ANTHROPIC_API_KEY, env.DATA_ENCRYPTION_KEY, env.DATABASE_URL]);
  const out = (text: string) => io.write(redact(text));

  if (env.DASH_LIVE_SMOKE !== "1") {
    out(`Skipped: DASH_LIVE_SMOKE is not set to 1.\n${SMOKE_ENABLE_HINT}`);
    return 0;
  }
  const only = argv.includes("--provider") ? argv[argv.indexOf("--provider") + 1] : undefined;
  if (only !== undefined && only !== "openai" && only !== "anthropic") {
    out("--provider must be openai or anthropic.\n");
    return 2;
  }

  let config: AppConfig;
  try {
    config = loadConfig(env);
  } catch (err) {
    out(`${err instanceof Error ? err.message : "Invalid configuration"}\n`);
    return 2;
  }
  if (config.providerMode !== "live") {
    out("Refusing to run: smoke tests exercise the REAL providers, so PROVIDER_MODE must be live (it is fake).\n");
    return 2;
  }

  const registry = (deps.registryFactory ?? ProviderRegistry.fromConfig)(config);
  for (const warning of registry.warnings) out(`warning: ${warning}\n`);
  const adapters = (["openai", "anthropic"] as const).filter((p) => (only ? p === only : true)).flatMap((p) => {
    const adapter = registry.get(p);
    return adapter ? [adapter] : [];
  });
  if (adapters.length === 0) {
    out("No provider is configured for the requested run. Set the API key and model variables (see .env.example).\n");
    return 2;
  }

  out(
    `Running live smoke checks against ${adapters.map((a) => `${a.displayName} (${a.model})`).join(" and ")}.\n` +
      `This sends roughly ${adapters.length * 8 + 6} small requests (each limited to ≤ ${SMOKE_MAX_OUTPUT_TOKENS} output tokens,\n` +
      `thinking/reasoning included; most use far fewer).\n\n`,
  );

  const results: CheckResult[] = [];
  const emit = (batch: CheckResult[]) => {
    for (const r of batch) {
      results.push(r);
      out(`${formatResult(r)}\n`);
    }
  };
  for (const adapter of adapters) emit(await runAdapterChecks(adapter, { skipTools: argv.includes("--skip-tools") }));

  // App-level checks use only the providers selected for this run.
  const selected = only
    ? new ProviderRegistry(Object.fromEntries(adapters.map((a) => [a.id, a])))
    : registry;
  emit(await runAppChecks(config, selected));

  const failed = results.filter((r) => r.status === "fail").length;
  const skipped = results.filter((r) => r.status === "skip").length;
  out(`\n${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped.\n`);
  return failed > 0 ? 1 : 0;
}
