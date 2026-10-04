import { buildApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { startupErrorText } from "./startupError.js";
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

  const { app, context } = await buildApp({ config, store: selection.store });
  for (const warning of [...selection.warnings, ...context.providers.warnings]) app.log.warn(warning);
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

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    clearInterval(purge);
    await app.close();
    await selection.store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: config.host, port: config.port });
}

void main();

