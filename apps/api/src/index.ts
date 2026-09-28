import { buildApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";

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

  const { app, context } = await buildApp({ config });
  for (const warning of context.providers.warnings) app.log.warn(warning);
  app.log.info(
    { providers: context.providers.status().map((p) => `${p.id}:${p.mode}`), providerMode: config.providerMode },
    "provider configuration",
  );

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: config.host, port: config.port });
}

void main();
