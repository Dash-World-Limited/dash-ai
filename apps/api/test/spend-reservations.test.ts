import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/store/memoryStore.js";
import { assertMigrated, migrate } from "../src/store/migrate.js";
import { MIGRATIONS } from "../src/store/migrations.js";
import { PostgresStore, spendUsageCtes } from "../src/store/postgresStore.js";
import type { InferenceAttemptRow, ReserveSpendInput, ReserveSpendResult, SpendLimit, Store } from "../src/store/store.js";
import { TEST_DATABASE_URL, createTestPgStore, testCipher } from "./pgTestStore.js";

// Atomic in-flight spend reservations (ADR 0015) at the store boundary: the lifecycle on both stores,
// then real concurrency on PostgreSQL (several transactions, several pools as separate API instances,
// and separate Node processes), with a gate that holds every admission open inside its critical
// section so that an implementation without a correct atomic boundary is caught racing.

if (process.env.REQUIRE_DB_TESTS === "1" && !TEST_DATABASE_URL) {
  throw new Error("REQUIRE_DB_TESTS=1 but TEST_DATABASE_URL is not set");
}

let n = 0;
const uid = (p: string) => `${p}-${(++n).toString().padStart(6, "0")}-${Math.random().toString(16).slice(2, 8)}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const DAY = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())).toISOString();
const MONTH = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();

const systemDaily = (limitUsd: number): SpendLimit => ({ scope: "system_daily", limitUsd, since: DAY });
const systemMonthly = (limitUsd: number): SpendLimit => ({ scope: "system_monthly", limitUsd, since: MONTH });
const userDaily = (userId: string, limitUsd: number): SpendLimit => ({ scope: "user_daily", limitUsd, since: DAY, userId });
const planDaily = (plan: string, limitUsd: number): SpendLimit => ({ scope: "plan_daily", limitUsd, since: DAY, plan });

function hold(amountUsd: number, limits: SpendLimit[], over: Partial<ReserveSpendInput> = {}): ReserveSpendInput {
  return {
    id: uid("res"),
    inferenceId: uid("inf"),
    userId: null,
    plan: "standard",
    task: "chat",
    provider: "openai",
    model: "paid-model",
    amountUsd,
    leaseMs: 60_000,
    limits,
    ...over,
  };
}

/** A paid ledger row for one request, as AttemptRecorder writes it (now, so it is in today's window). */
function attempt(inferenceId: string, costUsd: number, over: Partial<InferenceAttemptRow> = {}): InferenceAttemptRow {
  return {
    id: uid("att"), inferenceId, userId: null, plan: "standard", task: "chat", mode: "general", provider: "openai",
    model: "paid-model", configuredModel: "paid-model", pricing: "paid", createdAt: new Date().toISOString(), latencyMs: 10,
    outcome: "success", errorCode: null, httpStatus: null, retry: 0, round: 0, fallbackIndex: 0, inputTokens: 100,
    outputTokens: 50, cachedInputTokens: null, estimatedInputTokens: 100, estimatedOutputTokens: 50, tokenSource: "provider",
    estimatedCostUsd: costUsd, providerCostUsd: null, currency: "USD", route: {}, ...over,
  };
}

async function addUser(store: Store): Promise<string> {
  const id = uid("user");
  await store.createUser({ id, email: `${id}@example.com`, displayName: "R", passwordHash: "h", createdAt: new Date().toISOString() });
  return id;
}

const admittedUsd = (results: ReserveSpendResult[]) =>
  Math.round(results.reduce((s, r) => s + (r.ok ? r.reservation.reservedUsd : 0), 0) * 1e10) / 1e10;

/** Lifecycle rules every Store implementation shares. */
function lifecycleContract(name: string, make: () => Promise<{ store: Store; dispose: () => Promise<void> }>) {
  describe(`spend reservations: ${name}`, () => {
    const disposers: Array<() => Promise<void>> = [];
    afterAll(async () => {
      for (const d of disposers) await d();
    });
    const fresh = async () => {
      const made = await make();
      disposers.push(made.dispose);
      return made.store;
    };

    it("admits a hold that fits and refuses one that does not, reporting actual, reserved and available", async () => {
      const store = await fresh();
      const limits = [systemDaily(1)];
      const a = await store.reserveSpend(hold(0.4, limits));
      expect(a.ok).toBe(true);
      const b = await store.reserveSpend(hold(0.5, limits));
      expect(b.ok).toBe(true); // CASE B: 0.40 + 0.50 fit under 1.00
      const c = await store.reserveSpend(hold(0.2, limits));
      expect(c).toMatchObject({ ok: false, blockedBy: "system_daily" });
      expect(c.usage[0]).toMatchObject({ scope: "system_daily", limitUsd: 1, actualUsd: 0, reservedUsd: 0.9, availableUsd: 0.1 });
      // A hold that fits exactly is admitted (limit inclusive), never past it.
      expect((await store.reserveSpend(hold(0.1, limits))).ok).toBe(true);
      expect((await store.spendUsage(limits))[0]).toMatchObject({ reservedUsd: 1, availableUsd: 0 });
    });

    it("counts an in-flight request's own ledger rows once: they move from reserved to actual", async () => {
      const store = await fresh();
      const limits = [systemDaily(1)];
      const r = await store.reserveSpend(hold(0.5, limits));
      if (!r.ok) throw new Error("expected a hold");
      await store.recordInferenceAttempt(attempt(r.reservation.inferenceId, 0.3)); // round 0 billed while still running
      expect((await store.spendUsage(limits))[0]).toMatchObject({ actualUsd: 0.3, reservedUsd: 0.2, availableUsd: 0.5 });
      expect((await store.reserveSpend(hold(0.5, limits))).ok).toBe(true); // 0.3 + 0.2 + 0.5 = 1.0
      expect((await store.reserveSpend(hold(0.01, limits))).ok).toBe(false);
    });

    it("settles to the ledger's actual and frees the rest (CASE C); settling twice changes nothing", async () => {
      const store = await fresh();
      const limits = [systemDaily(1)];
      const a = await store.reserveSpend(hold(0.7, limits));
      if (!a.ok) throw new Error("expected a hold");
      expect((await store.reserveSpend(hold(0.7, limits))).ok).toBe(false);
      await store.recordInferenceAttempt(attempt(a.reservation.inferenceId, 0.2));
      const settled = await store.settleSpendReservation(a.reservation.id);
      expect(settled).toMatchObject({ alreadyFinished: false, reservation: { status: "settled", actualUsd: 0.2, reservedUsd: 0.7 } });
      expect(settled!.reservation.finishedAt).not.toBeNull();
      expect((await store.spendUsage(limits))[0]).toMatchObject({ actualUsd: 0.2, reservedUsd: 0, availableUsd: 0.8 });
      expect((await store.reserveSpend(hold(0.7, limits))).ok).toBe(true); // freed capacity is usable
      const again = await store.settleSpendReservation(a.reservation.id);
      expect(again).toMatchObject({ alreadyFinished: true, reservation: { status: "settled", actualUsd: 0.2 } });
      expect(await store.settleSpendReservation("no-such-reservation")).toBeUndefined();
    });

    it("a request that never billed is released; free and demo rows are not paid cost", async () => {
      const store = await fresh();
      const r = await store.reserveSpend(hold(0.3, [systemDaily(1)]));
      if (!r.ok) throw new Error("expected a hold");
      await store.recordInferenceAttempt(attempt(r.reservation.inferenceId, 0, { outcome: "failure", errorCode: "provider_error", httpStatus: 503 }));
      await store.recordInferenceAttempt(attempt(r.reservation.inferenceId, 0.4, { pricing: "free", provider: "freepool" }));
      expect((await store.settleSpendReservation(r.reservation.id))?.reservation).toMatchObject({ status: "released", actualUsd: 0 });
    });

    it("an actual above the hold is recorded as it is (the ledger stays the truth), never clipped", async () => {
      const store = await fresh();
      const r = await store.reserveSpend(hold(0.1, [systemDaily(1)]));
      if (!r.ok) throw new Error("expected a hold");
      await store.recordInferenceAttempt(attempt(r.reservation.inferenceId, 0.15));
      expect((await store.settleSpendReservation(r.reservation.id))?.reservation).toMatchObject({ status: "settled", actualUsd: 0.15, reservedUsd: 0.1 });
    });

    it("CASE G/H: an expired hold no longer blocks; an unexpired one keeps blocking; sweeping is idempotent", async () => {
      const store = await fresh();
      const limits = [systemDaily(1)];
      const stale = await store.reserveSpend(hold(0.9, limits, { leaseMs: 150 }));
      const live = await store.reserveSpend(hold(0.05, limits, { leaseMs: 60_000 }));
      expect(stale.ok && live.ok).toBe(true);
      expect((await store.reserveSpend(hold(0.9, limits))).ok).toBe(false); // H: active, unexpired
      await sleep(300);
      // G: counting ignores the lapsed hold by time alone, before any sweep ran.
      expect((await store.spendUsage(limits))[0]).toMatchObject({ reservedUsd: 0.05 });
      expect((await store.reserveSpend(hold(0.9, limits))).ok).toBe(true);
      expect(await store.sweepSpendReservations(100, 60_000)).toMatchObject({ expired: 1 });
      expect(await store.sweepSpendReservations(100, 60_000)).toMatchObject({ expired: 0 });
      if (!stale.ok) throw new Error("unreachable");
      expect(await store.getSpendReservation(stale.reservation.id)).toMatchObject({ status: "expired", actualUsd: null });
      // A late settlement records what was spent, but the hold stays ended (expired).
      await store.recordInferenceAttempt(attempt(stale.reservation.inferenceId, 0.05));
      expect((await store.settleSpendReservation(stale.reservation.id))?.reservation).toMatchObject({ status: "expired", actualUsd: 0.05 });
      expect((await store.settleSpendReservation(stale.reservation.id))?.alreadyFinished).toBe(true);
      // Finished rows are purged after the retention period, active ones never.
      await sleep(20);
      const swept = await store.sweepSpendReservations(100, 1);
      expect(swept.purged).toBeGreaterThanOrEqual(1);
      expect(await store.getSpendReservation(stale.reservation.id)).toBeUndefined();
      if (!live.ok) throw new Error("unreachable");
      expect((await store.getSpendReservation(live.reservation.id))?.status).toBe("active");
    });

    it("CASE E/F: each scope counts its own holds; the tightest limit decides", async () => {
      const store = await fresh();
      const u = await addUser(store);
      const v = await addUser(store);
      const forU = [systemDaily(1), userDaily(u, 0.5)];
      const forV = [systemDaily(1), userDaily(v, 0.5)];
      expect((await store.reserveSpend(hold(0.3, forU, { userId: u }))).ok).toBe(true);
      // E: U's own limit refuses while the system still has room.
      expect(await store.reserveSpend(hold(0.3, forU, { userId: u }))).toMatchObject({ ok: false, blockedBy: "user_daily" });
      expect((await store.reserveSpend(hold(0.3, forV, { userId: v }))).ok).toBe(true);
      // F: the system limit refuses although V's own limit has room (0.3 + 0.3 + 0.3 + 0.2 > 1).
      const w = await addUser(store);
      expect((await store.reserveSpend(hold(0.3, [systemDaily(1), userDaily(w, 0.5)], { userId: w }))).ok).toBe(true);
      expect(await store.reserveSpend(hold(0.2, forV, { userId: v }))).toMatchObject({ ok: false, blockedBy: "system_daily" });
      // Plan and monthly scopes count their holds too; the monthly limit is reported first.
      const plan = [systemMonthly(0.95), systemDaily(5), planDaily("standard", 2)];
      expect(await store.reserveSpend(hold(0.1, plan))).toMatchObject({ ok: false, blockedBy: "system_monthly" });
      expect((await store.spendUsage([planDaily("standard", 2), planDaily("pro", 2)])).map((x) => x.reservedUsd)).toEqual([0.9, 0]);
    });

    it("account deletion unlinks the hold, which still counts for the system and settles normally", async () => {
      const store = await fresh();
      const u = await addUser(store);
      const r = await store.reserveSpend(hold(0.6, [systemDaily(1), userDaily(u, 1)], { userId: u }));
      if (!r.ok) throw new Error("expected a hold");
      await store.deleteUserData(u);
      expect(await store.getSpendReservation(r.reservation.id)).toMatchObject({ userId: null, status: "active" });
      expect((await store.spendUsage([systemDaily(1)]))[0]?.reservedUsd).toBe(0.6);
      expect((await store.settleSpendReservation(r.reservation.id))?.reservation.status).toBe("released");
      // A deleted account cannot take a new hold.
      await expect(store.reserveSpend(hold(0.1, [systemDaily(1)], { userId: u }))).rejects.toThrow();
    });

    it("one hold per request; no limits means nothing to check", async () => {
      const store = await fresh();
      const first = hold(0.1, [systemDaily(1)]);
      expect((await store.reserveSpend(first)).ok).toBe(true);
      await expect(store.reserveSpend({ ...first, id: uid("res") })).rejects.toThrow();
      const free = await store.reserveSpend(hold(1_000, []));
      expect(free.ok).toBe(true);
      expect(free.usage).toEqual([]);
    });
  });
}

lifecycleContract("memory", async () => {
  const store = new MemoryStore();
  return { store, dispose: () => store.close() };
});

describe.skipIf(!TEST_DATABASE_URL)("spend reservations on PostgreSQL", () => {
  lifecycleContract("postgres", async () => {
    const t = await createTestPgStore();
    return { store: t.store, dispose: t.dispose };
  });

  const disposers: Array<() => Promise<void>> = [];
  afterAll(async () => {
    for (const d of disposers.reverse()) await d();
  });

  /** One isolated schema and `instances` independent stores on it (each its own pool: separate API instances). */
  async function instances(count: number) {
    const t = await createTestPgStore();
    disposers.push(t.dispose);
    const stores: PostgresStore[] = [t.store];
    for (let i = 1; i < count; i++) {
      const s = await PostgresStore.connect({ connectionString: TEST_DATABASE_URL!, cipher: t.cipher, schema: t.schema, poolMax: 10 });
      disposers.push(() => s.close());
      stores.push(s);
    }
    const raw = new pg.Pool({ connectionString: TEST_DATABASE_URL, options: `-c search_path=${t.schema}`, max: 3 });
    disposers.push(() => raw.end());
    return { stores, schema: t.schema, raw };
  }

  /**
   * Holds every admission open just before its check-and-insert statement until `parties` admissions
   * are inside together, or `waitMs` passes. With correct per-scope locks only one admission per scope
   * can ever be inside, so `maxInside` stays 1 and each waits out `waitMs` alone; without them, all
   * parties read the same totals and race.
   */
  function gate(stores: PostgresStore[], parties: number, waitMs = 250) {
    const state = { inside: 0, maxInside: 0, arrived: 0, fail: 0 };
    let open!: () => void;
    const all = new Promise<void>((resolve) => (open = resolve));
    const wrapped = Symbol.for("dash.test.gated");
    for (const store of stores) {
      const pool = store.pool as pg.Pool & { [k: symbol]: boolean };
      if (pool[wrapped]) throw new Error("gate already installed");
      pool[wrapped] = true;
      const connect = pool.connect.bind(pool) as (...args: unknown[]) => Promise<pg.PoolClient>;
      // pool.query() connects with a callback: only promise-style connects (transactions) are gated.
      (pool as { connect: (...args: unknown[]) => unknown }).connect = (...args: unknown[]) => (args.length > 0 ? connect(...args) : gated());
      const gated = async () => {
        const client = (await connect()) as pg.PoolClient & { [k: symbol]: boolean };
        if (!client[wrapped]) {
          client[wrapped] = true;
          const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
          (client as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = async (...args: unknown[]) => {
            const text = typeof args[0] === "string" ? args[0] : "";
            if (!text.includes("INSERT INTO spend_reservations")) return query(...args);
            if (state.fail > 0) {
              state.fail -= 1;
              throw Object.assign(new Error("simulated deadlock"), { code: "40P01" });
            }
            state.inside += 1;
            state.arrived += 1;
            state.maxInside = Math.max(state.maxInside, state.inside);
            if (state.arrived >= parties) open();
            await Promise.race([all, sleep(waitMs)]);
            try {
              return await query(...args);
            } finally {
              state.inside -= 1;
            }
          };
        }
        return client;
      };
    }
    return state;
  }

  it("CASE A: two requests race for $0.70 each under $1.00: exactly one is admitted", async () => {
    const { stores } = await instances(1);
    const store = stores[0]!;
    const g = gate(stores, 2);
    const limits = [systemDaily(1)];
    const results = await Promise.all([store.reserveSpend(hold(0.7, limits)), store.reserveSpend(hold(0.7, limits))]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ blockedBy: "system_daily" });
    expect(g.maxInside).toBe(1); // never two admissions inside the critical section at once
    expect(g.arrived).toBe(2);
  });

  it("CASE B: $0.40 and $0.50 racing under $1.00 are both admitted", async () => {
    const { stores } = await instances(1);
    gate(stores, 2, 50);
    const limits = [systemDaily(1)];
    const results = await Promise.all([stores[0]!.reserveSpend(hold(0.4, limits)), stores[0]!.reserveSpend(hold(0.5, limits))]);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("CASE D: two API instances (separate pools) race: exactly one is admitted", async () => {
    const { stores } = await instances(2);
    const g = gate(stores, 2);
    const limits = [systemMonthly(10), systemDaily(1)];
    const results = await Promise.all([stores[0]!.reserveSpend(hold(0.7, limits)), stores[1]!.reserveSpend(hold(0.7, limits))]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(g.maxInside).toBe(1);
  });

  it("CASE E: one person's racing requests are held to their own limit while other people are admitted", async () => {
    const { stores } = await instances(2);
    const [s1, s2] = stores as [PostgresStore, PostgresStore];
    const u = await addUser(s1);
    const v = await addUser(s1);
    const g = gate(stores, 3);
    const forU = [systemDaily(10), userDaily(u, 0.5)];
    const forV = [systemDaily(10), userDaily(v, 0.5)];
    const results = await Promise.all([
      s1.reserveSpend(hold(0.3, forU, { userId: u })),
      s2.reserveSpend(hold(0.3, forU, { userId: u })),
      s2.reserveSpend(hold(0.3, forV, { userId: v })),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(results[2]!.ok).toBe(true); // V is never refused because of U
    expect(results.slice(0, 2).filter((r) => !r.ok)).toEqual([expect.objectContaining({ blockedBy: "user_daily" })]);
    expect(g.maxInside).toBe(1);
  });

  it("with only person limits, different people are admitted in parallel (no platform-wide lock)", async () => {
    const { stores } = await instances(2);
    const [s1, s2] = stores as [PostgresStore, PostgresStore];
    const u = await addUser(s1);
    const v = await addUser(s1);
    const g = gate(stores, 2, 2_000);
    const started = Date.now();
    const results = await Promise.all([s1.reserveSpend(hold(0.3, [userDaily(u, 0.5)], { userId: u })), s2.reserveSpend(hold(0.3, [userDaily(v, 0.5)], { userId: v }))]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(g.maxInside).toBe(2); // both were inside together: their scopes do not share a lock
    expect(Date.now() - started).toBeLessThan(2_000); // the gate opened because both arrived, not by timing out
  });

  it("CASE F: requests from different people race under the system limit: exactly one is admitted", async () => {
    const { stores } = await instances(2);
    const [s1, s2] = stores as [PostgresStore, PostgresStore];
    const u = await addUser(s1);
    const v = await addUser(s1);
    const g = gate(stores, 2);
    const results = await Promise.all([
      s1.reserveSpend(hold(0.7, [systemDaily(1), userDaily(u, 10)], { userId: u })),
      s2.reserveSpend(hold(0.7, [systemDaily(1), userDaily(v, 10)], { userId: v })),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ blockedBy: "system_daily" });
    expect(g.maxInside).toBe(1);
  });

  it("CASE C under concurrency: a settlement racing new admissions frees exactly its unused part", async () => {
    const { stores } = await instances(2);
    const [s1, s2] = stores as [PostgresStore, PostgresStore];
    const limits = [systemDaily(1)];
    const a = await s1.reserveSpend(hold(0.7, limits));
    if (!a.ok) throw new Error("expected a hold");
    await s1.recordInferenceAttempt(attempt(a.reservation.inferenceId, 0.2));
    gate(stores, 3, 100);
    const [, ...results] = await Promise.all([
      s2.settleSpendReservation(a.reservation.id),
      s1.reserveSpend(hold(0.35, limits)),
      s2.reserveSpend(hold(0.35, limits)),
      s1.reserveSpend(hold(0.35, limits)),
    ]);
    const usage = (await s1.spendUsage(limits))[0]!;
    // Whatever the interleaving, at most two fit beside the 0.20 actually spent, and nothing passes the limit.
    expect(results.filter((r) => r.ok).length).toBeLessThanOrEqual(2);
    expect(usage.actualUsd + usage.reservedUsd).toBeLessThanOrEqual(1);
    expect(usage.availableUsd).toBeGreaterThanOrEqual(0);
  });

  it("CASE I: 3 instances × 20 simultaneous $0.07 requests under $1.00: exactly 14 admitted, never over", async () => {
    const { stores } = await instances(3);
    const limits = [systemMonthly(5), systemDaily(1)];
    const all = await Promise.all(stores.flatMap((s) => Array.from({ length: 20 }, () => s.reserveSpend(hold(0.07, limits)))));
    expect(all.filter((r) => r.ok)).toHaveLength(14);
    expect(admittedUsd(all)).toBeLessThanOrEqual(1);
    for (const r of all) for (const u of r.usage) expect(u.availableUsd).toBeGreaterThanOrEqual(-1e-9);
    const usage = (await stores[0]!.spendUsage(limits))[1]!;
    expect(usage).toMatchObject({ reservedUsd: 0.98, availableUsd: 0.02 });
  });

  it("several Node processes race on one database: the limit holds across them", async () => {
    const { stores, schema } = await instances(1);
    const limits = [systemDaily(1)];
    const startAt = Date.now() + 2_500;
    const worker = fileURLToPath(new URL("./reserveWorker.ts", import.meta.url));
    const run = (name: string) =>
      new Promise<{ admitted: number; denied: number }>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", worker], {
          env: { ...process.env, WORKER_SCHEMA: schema, WORKER_LIMITS: JSON.stringify(limits), WORKER_COUNT: "15", WORKER_AMOUNT: "0.07", WORKER_START_AT: String(startAt), WORKER_NAME: name },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        child.stdout.on("data", (d: Buffer) => (out += d.toString()));
        child.stderr.on("data", (d: Buffer) => (err += d.toString()));
        child.on("exit", (code) => (code === 0 ? resolve(JSON.parse(out.trim().split("\n").pop()!)) : reject(new Error(`worker ${name} exited ${code}: ${err.slice(0, 500)}`))));
      });
    const parent = (async () => {
      await sleep(Math.max(0, startAt - Date.now()));
      const results = await Promise.all(Array.from({ length: 15 }, () => stores[0]!.reserveSpend(hold(0.07, limits))));
      return { admitted: results.filter((r) => r.ok).length, denied: results.filter((r) => !r.ok).length };
    })();
    const outcomes = await Promise.all([run("w1"), run("w2"), parent]);
    expect(outcomes.reduce((s, o) => s + o.admitted, 0)).toBe(14);
    expect(outcomes.reduce((s, o) => s + o.admitted + o.denied, 0)).toBe(45);
    expect((await stores[0]!.spendUsage(limits))[0]).toMatchObject({ reservedUsd: 0.98 });
  }, 60_000);

  it("CASE J: a deadlock or serialization failure is retried; repeated failures and lock timeouts refuse (fail closed)", async () => {
    const { stores, raw } = await instances(1);
    const store = stores[0]!;
    const g = gate(stores, 1, 0);
    const limits = [systemDaily(1)];
    g.fail = 2;
    expect((await store.reserveSpend(hold(0.1, limits))).ok).toBe(true); // two simulated deadlocks, then admitted

    g.fail = 3;
    await expect(store.reserveSpend(hold(0.1, limits))).rejects.toMatchObject({ code: "40P01" });
    // Nothing half-done remains from the failed attempts.
    expect((await store.spendUsage(limits))[0]?.reservedUsd).toBe(0.1);

    // A scope held elsewhere longer than the lock timeout: the admission refuses instead of waiting forever.
    const blocker = await raw.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(7262025, hashtext('system'))");
      const started = Date.now();
      await expect(store.reserveSpend(hold(0.1, limits))).rejects.toMatchObject({ code: "55P03" });
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
    expect((await store.reserveSpend(hold(0.1, limits))).ok).toBe(true);
  });

  it("an unreachable database refuses the admission (no hold, an error the caller must treat as a refusal)", async () => {
    const t = await createTestPgStore();
    disposers.push(t.dispose);
    const s = await PostgresStore.connect({ connectionString: TEST_DATABASE_URL!, cipher: testCipher(), schema: t.schema, poolMax: 2 });
    await s.close();
    await expect(s.reserveSpend(hold(0.1, [systemDaily(1)]))).rejects.toThrow();
  });

  it("migration 12 upgrades a database at the merged baseline (1–11) without touching its data, and fails atomically", async () => {
    const schema = `t_${randomBytes(6).toString("hex")}`;
    const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 2 });
    try {
      // The baseline: migrations 1–11 applied exactly as the merged server applies them, with a ledger row.
      await pool.query(`CREATE TABLE schema_migrations (id integer PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
      for (const m of MIGRATIONS.filter((x) => x.id <= 11)) {
        await pool.query(m.sql);
        await pool.query("INSERT INTO schema_migrations (id, name, checksum) VALUES ($1, $2, $3)", [m.id, m.name, createHash("sha256").update(m.sql).digest("hex")]);
      }
      const row = attempt("baseline-inference", 0.25);
      await pool.query(
        `INSERT INTO inference_attempts (id, inference_id, plan, task, provider, model, pricing, created_at, latency_ms, outcome, retry, round, fallback_index,
           estimated_input_tokens, estimated_output_tokens, token_source, estimated_cost_usd, currency, route)
         VALUES ($1, $2, 'standard', 'chat', 'openai', 'm', 'paid', now(), 1, 'success', 0, 0, 0, 1, 1, 'estimated', $3, 'USD', '{}')`,
        [row.id, row.inferenceId, 0.25],
      );
      await expect(assertMigrated(pool)).rejects.toThrow(/missing 1 migration/);

      // A failing migration 12 (a conflicting object) leaves nothing half-applied.
      await pool.query("CREATE TABLE spend_reservations (id text)");
      await expect(migrate(pool)).rejects.toThrow(/Migration 12 \(spend_reservations\) failed/);
      expect((await pool.query("SELECT max(id) AS id FROM schema_migrations")).rows[0].id).toBe(11);
      expect((await pool.query("SELECT to_regclass('inference_attempts_paid_plan_created_idx') AS i")).rows[0].i).toBeNull();
      await pool.query("DROP TABLE spend_reservations");

      expect((await migrate(pool)).applied).toEqual(["12_spend_reservations"]);
      expect((await migrate(pool)).applied).toEqual([]); // second run: up to date
      await assertMigrated(pool);
      const kept = await pool.query("SELECT inference_id, estimated_cost_usd FROM inference_attempts");
      expect(kept.rows).toEqual([{ inference_id: "baseline-inference", estimated_cost_usd: 0.25 }]);
      const indexes = await pool.query("SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename IN ('spend_reservations', 'inference_attempts') ORDER BY 1", [schema]);
      expect(indexes.rows.map((r: { indexname: string }) => r.indexname)).toEqual(
        expect.arrayContaining([
          "inference_attempts_paid_plan_created_idx", "spend_reservations_active_idx", "spend_reservations_active_plan_idx",
          "spend_reservations_active_user_idx", "spend_reservations_finished_idx", "spend_reservations_inference_key", "spend_reservations_pkey",
        ]),
      );
      // The upgraded database admits holds against the spend it already had.
      const upgraded = await PostgresStore.connect({ connectionString: TEST_DATABASE_URL!, cipher: testCipher(), schema, autoMigrate: false });
      try {
        expect(await upgraded.reserveSpend(hold(0.8, [systemDaily(1)]))).toMatchObject({ ok: false, usage: [{ actualUsd: 0.25, availableUsd: 0.75 }] });
        expect((await upgraded.reserveSpend(hold(0.75, [systemDaily(1)]))).ok).toBe(true);
      } finally {
        await upgraded.close();
      }
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });

  it("the schema refuses impossible rows and keeps holds free of content", async () => {
    const { raw } = await instances(1);
    const insert = (over: Record<string, unknown>) => {
      const row = { id: uid("r"), inference_id: uid("i"), plan: "standard", task: "chat", provider: "openai", reserved_usd: 0.1, status: "active", finished_at: null, actual_usd: null, ...over };
      return raw.query(
        `INSERT INTO spend_reservations (id, inference_id, plan, task, provider, reserved_usd, status, created_at, expires_at, finished_at, actual_usd)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now() + interval '1 minute', $8, $9)`,
        [row.id, row.inference_id, row.plan, row.task, row.provider, row.reserved_usd, row.status, row.finished_at, row.actual_usd],
      );
    };
    await insert({});
    await expect(insert({ reserved_usd: -0.1 })).rejects.toThrow(/spend_reservations_amounts_check/);
    await expect(insert({ status: "pending", finished_at: new Date() })).rejects.toThrow(/spend_reservations_status_check/);
    await expect(insert({ status: "settled", finished_at: new Date() })).rejects.toThrow(/spend_reservations_settled_check/);
    await expect(insert({ status: "released" })).rejects.toThrow(/spend_reservations_finished_check/);
    await expect(insert({ finished_at: new Date() })).rejects.toThrow(/spend_reservations_finished_check/);
    await expect(insert({ inference_id: "dup" }).then(() => insert({ inference_id: "dup" }))).rejects.toThrow(/spend_reservations_inference_key/);
    await expect(
      raw.query("INSERT INTO spend_reservations (id, inference_id, plan, task, provider, reserved_usd, status, created_at, expires_at) VALUES ('x', 'y', 'p', 't', 'o', 0, 'active', now(), now())"),
    ).rejects.toThrow(/spend_reservations_lease_check/);
    const { rows } = await raw.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'spend_reservations' AND table_schema = current_schema() ORDER BY ordinal_position");
    expect(rows.map((r: { column_name: string }) => r.column_name)).toEqual([
      "id", "inference_id", "user_id", "plan", "task", "provider", "model", "reserved_usd", "actual_usd", "status", "created_at", "expires_at", "finished_at",
    ]);
  });

  it("the admission reads only active holds through their indexes (no table-wide scan per request)", async () => {
    const { stores, raw } = await instances(1);
    const store = stores[0]!;
    const u = await addUser(store);
    // Many finished holds and a few active ones, then fresh statistics.
    await raw.query(
      `INSERT INTO spend_reservations (id, inference_id, user_id, plan, task, provider, reserved_usd, actual_usd, status, created_at, expires_at, finished_at)
       SELECT 'old-' || g, 'old-inf-' || g, NULL, 'standard', 'chat', 'openai', 0.01, 0.01, 'settled', now() - interval '1 day', now() - interval '23 hours', now() - interval '23 hours'
         FROM generate_series(1, 20000) AS g`,
    );
    // A month of ledger rows from many requests and people.
    await raw.query(
      `INSERT INTO inference_attempts (id, inference_id, user_id, plan, task, provider, model, pricing, created_at, latency_ms, outcome, retry, round,
         fallback_index, estimated_input_tokens, estimated_output_tokens, token_source, estimated_cost_usd, currency, route)
       SELECT 'att-' || g, 'inf-' || g, NULL, 'standard', 'chat', 'openai', 'm', CASE WHEN g % 4 = 0 THEN 'free' ELSE 'paid' END,
              now() - (g % 720) * interval '1 hour', 1, 'success', 0, 0, 0, 10, 10, 'estimated', 0.0001, 'USD', '{}'
         FROM generate_series(1, 50000) AS g`,
    );
    for (let i = 0; i < 3; i++) await store.reserveSpend(hold(0.01, [userDaily(u, 1)], { userId: u }));
    await raw.query("ANALYZE spend_reservations");
    await raw.query("ANALYZE inference_attempts");
    const explain = async (limits: SpendLimit[]) => {
      const params: unknown[] = [];
      const plan = await raw.query(`EXPLAIN WITH ${spendUsageCtes(limits, params)} SELECT * FROM usage`, params);
      return plan.rows.map((r: Record<string, string>) => r["QUERY PLAN"]).join("\n");
    };
    // The exact statement admission runs, for a person-only limit and for system limits.
    const personOnly = await explain([userDaily(u, 1)]);
    expect(personOnly).toMatch(/spend_reservations_active_user_idx/);
    expect(personOnly).not.toMatch(/Seq Scan on spend_reservations/);
    const system = await explain([systemMonthly(10), systemDaily(1), planDaily("standard", 5), userDaily(u, 1)]);
    expect(system).toMatch(/spend_reservations_active_idx/);
    // Each hold's own ledger rows are found by request id, never by scanning the ledger.
    expect(system).toMatch(/inference_attempts_inference_idx/);
    expect(system).not.toMatch(/Seq Scan on inference_attempts a\b/);
    if (process.env.DASH_PRINT_PLANS) writeFileSync(process.env.DASH_PRINT_PLANS, `${personOnly}\n---\n${system}\n`);
    const text = system;
    expect(text).not.toMatch(/Seq Scan on spend_reservations/);
  });
});
