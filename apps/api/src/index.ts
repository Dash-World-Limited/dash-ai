import { buildApp } from "./app.js";
import { ConfigError, configWarnings, loadConfig } from "./config.js";
import { startupErrorText } from "./startupError.js";
import { Metrics } from "./observability/metrics.js";
import { MemoryRateLimitStore, RedisRateLimitStore } from "./security/rateLimit.js";
import { createStore } from "./store/factory.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  let selection;
  try {
    selection = await createStore(config);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`Could not start the data store: ${startupErrorText(err, config.database.url)}\n`);
    process.exit(1);
  }

  const metrics = new Metrics();
  // Filled in once the app (and its logger) exists; Redis errors before that are only counted.
  let reportRateLimitError: (errorName: string) => void = () => undefined;
  const rateLimitStore =
    config.rateLimits.backend === "redis" && config.rateLimits.redisUrl
      ? new RedisRateLimitStore({
          url: config.rateLimits.redisUrl,
          onBackendError: (errorName) => {
            metrics.rateLimitBackendErrors.inc({ backend: "redis" });
            reportRateLimitError(errorName);
          },
        })
      : new MemoryRateLimitStore();
  const sharedLimitsReady = rateLimitStore instanceof RedisRateLimitStore ? await rateLimitStore.ready() : true;

  const { app, context } = await buildApp({ config, store: selection.store, rateLimitStore, metrics });
  reportRateLimitError = (errorName) =>
    app.log.warn({ errorName }, "rate-limit backend unavailable; using per-instance limits for a few seconds");
  if (!sharedLimitsReady) {
    app.log.warn("Redis is not reachable yet: rate limits are per instance until it is (it is retried automatically).");
  }
  app.log.info({ backend: rateLimitStore.kind }, "rate limiting");
  for (const warning of [...configWarnings(config), ...selection.warnings, ...context.providers.warnings]) app.log.warn(warning);
  app.log.info({ store: selection.kind }, "data store");

  // Expired sessions are also rejected on use; this just keeps the table small.
  const purge = setInterval(() => {
    selection.store.purgeExpiredSessions(new Date()).catch((err: unknown) => app.log.warn({ err }, "session purge failed"));
  }, 3_600_000);
  purge.unref();
  app.log.info(
    { providers: context.providers.status().map((p) => `${p.id}:${p.mode}`), providerMode: config.providerMode },
    "provider configuration",
  );

  // DASH Automates runs on every instance; the database coordinates them (see AutomationService).
  context.automations.start();
  app.log.info({ enabled: config.automations.enabled, concurrency: config.automations.concurrency }, "automations scheduler");

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    clearInterval(purge);
    await app.close();
    await rateLimitStore.close();
    await selection.store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: config.host, port: config.port });
}

void main();

