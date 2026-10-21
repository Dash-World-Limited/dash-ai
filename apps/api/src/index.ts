import { buildApp } from "./app.js";
import { RedisStreamControl } from "./chat/streamControl.js";
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
          prefix: `${config.rateLimits.redisKeyPrefix}rl:`,
          onBackendError: (errorName) => {
            metrics.rateLimitBackendErrors.inc({ backend: "redis" });
            reportRateLimitError(errorName);
          },
        })
      : new MemoryRateLimitStore();
  const sharedLimitsReady = rateLimitStore instanceof RedisRateLimitStore ? await rateLimitStore.ready() : true;
  // Shared stream slots and cancellation use the same Redis (several instances need it; ADR 0017).
  const streamControl =
    config.rateLimits.backend === "redis" && config.rateLimits.redisUrl
      ? new RedisStreamControl({ url: config.rateLimits.redisUrl, prefix: config.rateLimits.redisKeyPrefix, slotTtlMs: config.streamSlotTtlMs })
      : undefined;
  if (streamControl) await streamControl.ready();

  const { app, context, drain } = await buildApp({ config, store: selection.store, rateLimitStore, metrics, streamControl });
  reportRateLimitError = (errorName) =>
    app.log.warn({ errorName }, "rate-limit backend unavailable; using per-instance limits for a few seconds");
  if (!sharedLimitsReady) {
    app.log.warn("Redis is not reachable yet: rate limits are per instance and new chat answers are refused as busy until it is (it is retried automatically).");
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
  context.push.start();
  app.log.info({ transport: config.push.transport, available: context.push.available }, "push notifications");
  app.log.info({ enabled: config.automations.enabled, concurrency: config.automations.concurrency }, "automations scheduler");

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Whatever happens below, the process is gone shortly after the drain window.
    setTimeout(() => {
      app.log.error("shutdown did not finish in time; exiting");
      process.exit(1);
    }, config.shutdownDrainMs + 15_000).unref();
    app.log.info({ signal, drainMs: config.shutdownDrainMs, activeStreams: context.streams.size }, "shutting down: draining");
    clearInterval(purge);
    const started = Date.now();
    const outcome = await drain(config.shutdownDrainMs);
    app.log.info({ outcome, waitedMs: Date.now() - started, stoppedStreams: context.streams.size }, "drain finished");
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

