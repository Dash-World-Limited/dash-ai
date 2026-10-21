import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { MIGRATIONS, type Migration } from "./migrations.js";

// Arbitrary constant: serialises concurrent migrators (e.g. several instances starting at once).
const LOCK_KEY = 7_262_024_001;

const checksum = (m: Migration) => createHash("sha256").update(m.sql).digest("hex");

export interface MigrationReport {
  applied: string[];
  alreadyApplied: number;
}

async function ensureTable(client: PoolClient): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id         integer PRIMARY KEY,
    name       text NOT NULL,
    checksum   text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
}

async function readApplied(client: PoolClient): Promise<Map<number, { name: string; checksum: string }>> {
  const { rows } = await client.query<{ id: number; name: string; checksum: string }>("SELECT id, name, checksum FROM schema_migrations");
  return new Map(rows.map((r) => [r.id, { name: r.name, checksum: r.checksum }]));
}

function verify(applied: Map<number, { name: string; checksum: string }>): void {
  for (const [id, row] of applied) {
    const known = MIGRATIONS.find((m) => m.id === id);
    if (!known) throw new Error(`The database has migration ${id}, which this server version does not know. Deploy a newer server.`);
    // A different name means a different migration history (two branches once both used id 10), not an edit.
    if (row.name !== known.name) {
      throw new Error(
        `Migration ${id} in the database is "${row.name}", but this server's migration ${id} is "${known.name}": the database ran a ` +
          "different migration history. Do not migrate or repair it; see docs/provider-platform.md (Safe production rollout, step 0).",
      );
    }
    if (checksum(known) !== row.checksum) throw new Error(`Migration ${id} (${known.name}) was modified after it was applied.`);
  }
}

/** Applies pending migrations in order. Safe to run concurrently and repeatedly. */
export async function migrate(pool: Pool): Promise<MigrationReport> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await ensureTable(client);
    const applied = await readApplied(client);
    verify(applied);
    const report: MigrationReport = { applied: [], alreadyApplied: applied.size };
    for (const m of [...MIGRATIONS].sort((a, b) => a.id - b.id)) {
      if (applied.has(m.id)) continue;
      try {
        await client.query("BEGIN");
        await client.query(m.sql);
        await client.query("INSERT INTO schema_migrations (id, name, checksum) VALUES ($1, $2, $3)", [m.id, m.name, checksum(m)]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw new Error(`Migration ${m.id} (${m.name}) failed: ${(err as Error).message}`);
      }
      report.applied.push(`${m.id}_${m.name}`);
    }
    return report;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}

/** Throws unless every known migration has been applied (used when auto-migration is off). */
export async function assertMigrated(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    const exists = await client.query("SELECT to_regclass('schema_migrations') AS t");
    if (!exists.rows[0]?.t) throw new Error("The database has not been migrated. Run: pnpm --filter @dash-ai/api migrate");
    const applied = await readApplied(client);
    verify(applied);
    const pending = MIGRATIONS.filter((m) => !applied.has(m.id));
    if (pending.length > 0) {
      throw new Error(`The database is missing ${pending.length} migration(s). Run: pnpm --filter @dash-ai/api migrate`);
    }
  } finally {
    client.release();
  }
}
