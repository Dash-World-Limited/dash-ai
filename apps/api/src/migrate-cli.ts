import pg from "pg";
import { ConfigError, loadConfig } from "./config.js";
import { migrate } from "./store/migrate.js";

/** `pnpm --filter @dash-ai/api migrate` — applies pending database migrations and exits. */
async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.database.url) throw new ConfigError("DATABASE_URL is not set.");
  const pool = new pg.Pool({
    connectionString: config.database.url,
    max: 1,
    ...(config.database.ssl === "disable" ? {} : { ssl: { rejectUnauthorized: config.database.ssl === "require" } }),
  });
  try {
    const report = await migrate(pool);
    process.stdout.write(
      report.applied.length > 0
        ? `Applied ${report.applied.length} migration(s): ${report.applied.join(", ")}\n`
        : `Database is up to date (${report.alreadyApplied} migration(s) already applied).\n`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : "Migration failed"}\n`);
  process.exit(1);
});
