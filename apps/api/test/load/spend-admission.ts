/**
 * Spend admission under concurrency (ADR 0015/0016), measured at the store on real PostgreSQL, with
 * several Node processes standing in for API instances. Every request reserves a hold and settles it
 * (no provider is called). Prints throughput, latency percentiles and the limit check per scenario.
 *
 *   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/dash_test npx tsx test/load/spend-admission.ts
 *
 * Scenarios: per-user limits only (no shared lock) vs. with system daily+monthly limits (one shared
 * lock per scope), at 1 and 3 processes; then a tight system limit, to show the cap is never exceeded
 * while the processes race.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PostgresStore } from "../../src/store/postgresStore.js";
import type { SpendLimit } from "../../src/store/store.js";
import { testCipher } from "../pgTestStore.js";

const env = process.env;
const DAY = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())).toISOString();
const MONTH = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();

function limitsFor(kind: string, userId: string, systemUsd: number): SpendLimit[] {
  const user: SpendLimit = { scope: "user_daily", limitUsd: 1_000_000, since: DAY, userId };
  if (kind === "user") return [user];
  return [{ scope: "system_monthly", limitUsd: systemUsd * 30, since: MONTH }, { scope: "system_daily", limitUsd: systemUsd, since: DAY }, user];
}

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;

if (env.SPEND_WORKER) {
  // One "instance": CONCURRENCY closed-loop callers for DURATION_MS, each reserve → settle.
  const store = await PostgresStore.connect({ connectionString: env.TEST_DATABASE_URL!, cipher: testCipher(), schema: env.WORKER_SCHEMA!, poolMax: 10, autoMigrate: false });
  const concurrency = Number(env.CONCURRENCY);
  const until = Number(env.START_AT) + Number(env.DURATION_MS);
  const hold = env.HOLD === "1"; // tight-limit run: keep admitted holds (do not settle) so the cap fills
  await new Promise((r) => setTimeout(r, Math.max(0, Number(env.START_AT) - Date.now())));
  const latencies: number[] = [];
  let admitted = 0;
  let denied = 0;
  let errors = 0;
  let admittedUsd = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async (_, c) => {
      const userId = `${env.WORKER_NAME}-u${c}`;
      let i = 0;
      while (Date.now() < until) {
        const started = performance.now();
        try {
          const r = await store.reserveSpend({ id: `${userId}-r${i}`, inferenceId: `${userId}-i${i}`, userId, plan: "standard", task: "chat", provider: "openai", model: "m", amountUsd: Number(env.AMOUNT), leaseMs: 60_000, limits: limitsFor(env.KIND!, userId, Number(env.SYSTEM_USD)) });
          if (r.ok) {
            admitted++;
            admittedUsd += Number(env.AMOUNT);
            if (!hold) await store.settleSpendReservation(r.reservation.id);
          } else denied++;
        } catch {
          errors++;
        }
        latencies.push(performance.now() - started);
        i++;
      }
    }),
  );
  await store.close();
  process.stdout.write(`${JSON.stringify({ admitted, denied, errors, admittedUsd, latencies })}\n`);
  process.exit(0);
}

async function scenario(name: string, opts: { processes: number; concurrency: number; kind: "user" | "system"; durationMs: number; systemUsd?: number; amount?: number; hold?: boolean }) {
  const schema = `t_${randomBytes(6).toString("hex")}`;
  const setup = await PostgresStore.connect({ connectionString: env.TEST_DATABASE_URL!, cipher: testCipher(), schema, poolMax: 2 });
  const startAt = Date.now() + 2_500;
  const self = fileURLToPath(import.meta.url);
  const runs = await Promise.all(
    Array.from({ length: opts.processes }, (_, p) =>
      new Promise<{ admitted: number; denied: number; errors: number; admittedUsd: number; latencies: number[] }>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", self], {
          env: { ...env, SPEND_WORKER: "1", WORKER_SCHEMA: schema, WORKER_NAME: `p${p}`, CONCURRENCY: String(opts.concurrency), DURATION_MS: String(opts.durationMs), START_AT: String(startAt), KIND: opts.kind, SYSTEM_USD: String(opts.systemUsd ?? 1_000_000), AMOUNT: String(opts.amount ?? 0.01), HOLD: opts.hold ? "1" : "0" },
          stdio: ["ignore", "pipe", "inherit"],
        });
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        child.on("exit", (code) => (code === 0 ? resolve(JSON.parse(out.trim().split("\n").at(-1)!)) : reject(new Error(`worker exit ${code}`))));
      }),
    ),
  );
  const latencies = runs.flatMap((r) => r.latencies).sort((a, b) => a - b);
  const admitted = runs.reduce((n, r) => n + r.admitted, 0);
  const admittedUsd = runs.reduce((n, r) => n + r.admittedUsd, 0);
  const usage = opts.kind === "system" ? (await setup.spendUsage([{ scope: "system_daily", limitUsd: opts.systemUsd ?? 1_000_000, since: DAY }]))[0] : undefined;
  await setup.dropSchema(schema).catch(() => undefined);
  await setup.close();
  return {
    name,
    ...opts,
    requests: latencies.length,
    admitted,
    denied: runs.reduce((n, r) => n + r.denied, 0),
    errors: runs.reduce((n, r) => n + r.errors, 0),
    admissionsPerSecond: Math.round(latencies.length / (opts.durationMs / 1000)),
    latencyMs: { p50: Math.round(pct(latencies, 50)), p95: Math.round(pct(latencies, 95)), p99: Math.round(pct(latencies, 99)), max: Math.round(latencies.at(-1) ?? 0) },
    ...(opts.hold ? { admittedUsd: Math.round(admittedUsd * 100) / 100, reservedUsdInDb: usage?.reservedUsd, limitUsd: opts.systemUsd, neverOver: admittedUsd <= (opts.systemUsd ?? 0) + 1e-9 } : {}),
  };
}

const report = [];
const durationMs = Number(env.DURATION_MS ?? 8_000);
for (const processes of [1, 3]) {
  for (const kind of ["user", "system"] as const) {
    report.push(await scenario(`${kind}-limits ×${processes} processes`, { processes, concurrency: 16, kind, durationMs }));
    process.stderr.write(`${report.at(-1)!.name} done\n`);
  }
}
report.push(await scenario("tight system limit, 3 processes racing, holds kept", { processes: 3, concurrency: 16, kind: "system", durationMs: 4_000, systemUsd: 5, amount: 0.07, hold: true }));
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
