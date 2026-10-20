import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/store/memoryStore.js";
import { assertMigrated, migrate } from "../src/store/migrate.js";
import { MIGRATIONS } from "../src/store/migrations.js";
import { PostgresStore } from "../src/store/postgresStore.js";
import type { ExtendSpendInput, ExtendSpendResult, InferenceAttemptRow, ReserveSpendInput, SpendLimit, Store } from "../src/store/store.js";
import { TEST_DATABASE_URL, createTestPgStore, testCipher } from "./pgTestStore.js";

// Retry and fallback spend accounting (ADR 0016) at the store boundary: extending one request's hold so it
// covers one more provider attempt. The rules on both stores, then real concurrency on PostgreSQL with
// gates that hold every extension (and admission) open inside its critical section, so that an
// implementation without the row lock, the scope locks or the idempotency key is caught racing.

if (process.env.REQUIRE_DB_TESTS === "1" && !TEST_DATABASE_URL) {
  throw new Error("REQUIRE_DB_TESTS=1 but TEST_DATABASE_URL is not set");
}

let n = 0;
const uid = (p: string) => `${p}-${(++n).toString().padStart(6, "0")}-${Math.random().toString(16).slice(2, 8)}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const DAY = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())).toISOString();
const systemDaily = (limitUsd: number): SpendLimit => ({ scope: "system_daily", limitUsd, since: DAY });
const userDaily = (userId: string, limitUsd: number): SpendLimit => ({ scope: "user_daily", limitUsd, since: DAY, userId });

function hold(amountUsd: number, limits: SpendLimit[], over: Partial<ReserveSpendInput> = {}): ReserveSpendInput {
  return { id: uid("res"), inferenceId: uid("inf"), userId: null, plan: "standard", task: "chat", provider: "openai", model: "paid-model", amountUsd, leaseMs: 60_000, limits, ...over };
}

async function reserved(store: Store, amountUsd: number, limits: SpendLimit[], over: Partial<ReserveSpendInput> = {}) {
  const r = await store.reserveSpend(hold(amountUsd, limits, over));
  if (!r.ok) throw new Error("expected a hold");
  return r.reservation;
}

/** One more attempt for a hold: by default the first retry of round 0 on the first provider. */
function more(reservationId: string, attemptUsd: number, priorUsd: number, limits: SpendLimit[], at: Partial<ExtendSpendInput["attempt"]> = {}): ExtendSpendInput {
  return { reservationId, attempt: { fallbackIndex: 0, round: 0, retry: 1, provider: "openai", model: "paid-model", ...at }, attemptUsd, priorUsd, limits };
}

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

const okResult = (r: ExtendSpendResult) => (r.ok ? r : (() => { throw new Error(`expected an extension, got ${JSON.stringify(r)}`); })());

function rulesContract(name: string, make: () => Promise<{ store: Store; dispose: () => Promise<void> }>) {
  describe(`spend hold extensions: ${name}`, () => {
    const disposers: Array<() => Promise<void>> = [];
    afterAll(async () => {
      for (const d of disposers) await d();
    });
    const fresh = async () => {
      const made = await make();
      disposers.push(made.dispose);
      return made.store;
    };

    it("CASE A: $0.60 held under $1.00, a retry needs +$0.30: extended to $0.90", async () => {
      const store = await fresh();
      const limits = [systemDaily(1)];
      const r = await reserved(store, 0.6, limits);
      // The first attempt failed with uncertain billing: the caller still counts its $0.60 worst case.
      const x = okResult(await store.extendSpendReservation(more(r.id, 0.3, 0.6, limits)));
      expect(x).toMatchObject({ extendedUsd: 0.3, duplicate: false, reservation: { reservedUsd: 0.9, status: "active" } });
      expect((await store.spendUsage(limits))[0]).toMatchObject({ reservedUsd: 0.9, availableUsd: 0.1 });
    });

    it("CASE B: $0.60 held under $0.80, a retry needs +$0.30: refused, nothing changes", async () => {
      const store = await fresh();
      const limits = [systemDaily(0.8)];
      const r = await reserved(store, 0.6, limits);
      const x = await store.extendSpendReservation(more(r.id, 0.3, 0.6, limits));
      expect(x).toMatchObject({ ok: false, reason: "limit", blockedBy: "system_daily" });
      expect(await store.getSpendReservation(r.id)).toMatchObject({ reservedUsd: 0.6 });
      // A refused attempt was not registered: the same attempt may be asked again once room exists.
      const y = okResult(await store.extendSpendReservation(more(r.id, 0.1, 0.6, limits)));
      expect(y).toMatchObject({ extendedUsd: 0.1, duplicate: false });
    });

    it("the same attempt asked twice extends once (idempotent); a covered attempt is only registered", async () => {
      const store = await fresh();
      const limits = [systemDaily(10)];
      const r = await reserved(store, 0.6, limits);
      expect(okResult(await store.extendSpendReservation(more(r.id, 0.3, 0.6, limits)))).toMatchObject({ extendedUsd: 0.3 });
      expect(okResult(await store.extendSpendReservation(more(r.id, 0.3, 0.6, limits)))).toMatchObject({ extendedUsd: 0, duplicate: true, reservation: { reservedUsd: 0.9 } });
      // CASE H shape: a cheaper attempt that already fits in what is held needs no increase.
      expect(okResult(await store.extendSpendReservation(more(r.id, 0.1, 0.3, limits, { fallbackIndex: 1, retry: 0 })))).toMatchObject({ extendedUsd: 0, duplicate: false, reservation: { reservedUsd: 0.9 } });
    });

    it("counts the request's own ledger rows and attempts still in flight, whichever the caller missed", async () => {
      const store = await fresh();
      const limits = [systemDaily(10)];
      const r = await reserved(store, 0.5, limits);
      // Another code path billed $0.45 for this request that the caller does not know about.
      await store.recordInferenceAttempt(attempt(r.inferenceId, 0.45, { retry: 0 }));
      expect(okResult(await store.extendSpendReservation(more(r.id, 0.2, 0.1, limits)))).toMatchObject({ extendedUsd: 0.15, reservation: { reservedUsd: 0.65 } });
      // Retry 1 is registered but has no ledger row yet (in flight): retry 2 must be held beside it.
      expect(okResult(await store.extendSpendReservation(more(r.id, 0.2, 0.45, limits, { retry: 2 })))).toMatchObject({ extendedUsd: 0.2, reservation: { reservedUsd: 0.85 } });
      // Once retry 1's row is written its actual replaces its worst case.
      await store.recordInferenceAttempt(attempt(r.inferenceId, 0.05, { retry: 1 }));
      await store.recordInferenceAttempt(attempt(r.inferenceId, 0.05, { retry: 2 }));
      expect(okResult(await store.extendSpendReservation(more(r.id, 0.2, 0, limits, { retry: 3 })))).toMatchObject({ extendedUsd: 0, reservation: { reservedUsd: 0.85 } });
      // Settlement still records exactly the request's paid ledger rows (several under one hold).
      expect((await store.settleSpendReservation(r.id))?.reservation).toMatchObject({ status: "settled", actualUsd: 0.55, reservedUsd: 0.85 });
    });

    it("a hold that ended (settled, released or expired) is never extended", async () => {
      const store = await fresh();
      const limits = [systemDaily(10)];
      const settled = await reserved(store, 0.2, limits);
      await store.settleSpendReservation(settled.id);
      expect(await store.extendSpendReservation(more(settled.id, 0.1, 0.2, limits))).toEqual({ ok: false, reason: "inactive" });
      const lapsing = await reserved(store, 0.2, limits, { leaseMs: 100 });
      await sleep(250);
      expect(await store.extendSpendReservation(more(lapsing.id, 0.1, 0.2, limits))).toEqual({ ok: false, reason: "inactive" });
      expect(await store.extendSpendReservation(more("no-such-hold", 0.1, 0, limits))).toEqual({ ok: false, reason: "inactive" });
    });

    it("the person's own limit applies to an extension while the system has room", async () => {
      const store = await fresh();
      const u = await addUser(store);
      const limits = [systemDaily(10), userDaily(u, 0.7)];
      const r = await reserved(store, 0.5, limits, { userId: u });
      expect(await store.extendSpendReservation(more(r.id, 0.3, 0.5, limits))).toMatchObject({ ok: false, reason: "limit", blockedBy: "user_daily" });
      expect(okResult(await store.extendSpendReservation(more(r.id, 0.2, 0.5, limits)))).toMatchObject({ extendedUsd: 0.2 });
    });
  });
}

rulesContract("memory", async () => {
  const store = new MemoryStore();
  return { store, dispose: () => store.close() };
});

describe.skipIf(!TEST_DATABASE_URL)("spend hold extensions on PostgreSQL", () => {
  rulesContract("postgres", async () => {
    const t = await createTestPgStore();
    return { store: t.store, dispose: t.dispose };
  });

  const disposers: Array<() => Promise<void>> = [];
  afterAll(async () => {
    for (const d of disposers.reverse()) await d();
  });

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

  const GROW = "UPDATE spend_reservations SET reserved_usd";
  const ADMIT = "INSERT INTO spend_reservations";

  /**
   * Holds every transaction's critical statement (growing a hold, or admitting one) open until `parties`
   * of them are inside together, or `waitMs` passes. With correct locks, only one holder per scope (and
   * per reservation row) can be inside, so `maxInside` stays 1; without them, every party reads the same
   * state and they race.
   */
  function gate(stores: PostgresStore[], parties: number, waitMs = 300, statements = [GROW, ADMIT]) {
    const state = { inside: 0, maxInside: 0, arrived: 0, fail: 0 };
    let open!: () => void;
    const all = new Promise<void>((resolve) => (open = resolve));
    const wrapped = Symbol.for("dash.test.extension-gated");
    for (const store of stores) {
      const pool = store.pool as pg.Pool & { [k: symbol]: boolean };
      if (pool[wrapped]) throw new Error("gate already installed");
      pool[wrapped] = true;
      const connect = pool.connect.bind(pool) as (...args: unknown[]) => Promise<pg.PoolClient>;
      (pool as { connect: (...args: unknown[]) => unknown }).connect = (...args: unknown[]) => (args.length > 0 ? connect(...args) : gated());
      const gated = async () => {
        const client = (await connect()) as pg.PoolClient & { [k: symbol]: boolean };
        if (!client[wrapped]) {
          client[wrapped] = true;
          const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
          (client as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = async (...args: unknown[]) => {
            const text = typeof args[0] === "string" ? args[0] : "";
            if (!statements.some((s) => text.includes(s))) return query(...args);
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

  it("CASE C: two code paths extend the same hold for the same retry at once: exactly one extension", async () => {
    const { stores } = await instances(1);
    const store = stores[0]!;
    const limits = [systemDaily(10)];
    const r = await reserved(store, 0.6, limits);
    const g = gate(stores, 2);
    const results = await Promise.all([store.extendSpendReservation(more(r.id, 0.3, 0.6, limits)), store.extendSpendReservation(more(r.id, 0.3, 0.6, limits))]);
    expect(results.map((x) => okResult(x).extendedUsd).sort()).toEqual([0, 0.3]);
    expect(results.filter((x) => x.ok && x.duplicate)).toHaveLength(1);
    expect(await store.getSpendReservation(r.id)).toMatchObject({ reservedUsd: 0.9 });
    expect(g.maxInside).toBe(1);
  });

  it("CASE D: two different attempts extend the same hold at once: both are held when the total fits, one when it does not", async () => {
    const { stores } = await instances(1);
    const store = stores[0]!;
    const roomy = [systemDaily(1.5)];
    const r = await reserved(store, 0.6, roomy);
    const g = gate(stores, 2);
    const both = await Promise.all([
      store.extendSpendReservation(more(r.id, 0.3, 0.6, roomy, { retry: 1 })),
      store.extendSpendReservation(more(r.id, 0.3, 0.6, roomy, { fallbackIndex: 1, retry: 0 })),
    ]);
    // Neither attempt has a ledger row yet: each extension holds the other one too.
    expect(both.every((x) => x.ok && x.extendedUsd === 0.3)).toBe(true);
    expect(await store.getSpendReservation(r.id)).toMatchObject({ reservedUsd: 1.2 });
    expect(g.maxInside).toBe(1);

    const tight = [systemDaily(1)];
    const t2 = await instances(1);
    const s2 = t2.stores[0]!;
    const h = await reserved(s2, 0.6, tight);
    gate(t2.stores, 2);
    const one = await Promise.all([
      s2.extendSpendReservation(more(h.id, 0.3, 0.6, tight, { retry: 1 })),
      s2.extendSpendReservation(more(h.id, 0.3, 0.6, tight, { fallbackIndex: 1, retry: 0 })),
    ]);
    expect(one.filter((x) => x.ok)).toHaveLength(1);
    expect(one.find((x) => !x.ok)).toMatchObject({ reason: "limit", blockedBy: "system_daily" });
    expect(await s2.getSpendReservation(h.id)).toMatchObject({ reservedUsd: 0.9 });
  });

  it("CASE E: an extension racing another request's admission still respects the system limit", async () => {
    const { stores } = await instances(1);
    const store = stores[0]!;
    const limits = [systemDaily(1)];
    const r = await reserved(store, 0.6, limits);
    const g = gate(stores, 2);
    const [extended, admitted] = await Promise.all([store.extendSpendReservation(more(r.id, 0.3, 0.6, limits)), store.reserveSpend(hold(0.3, limits))]);
    // 0.60 + 0.30 + 0.30 > 1.00: exactly one of them gets the room.
    expect([extended.ok, admitted.ok].filter(Boolean)).toHaveLength(1);
    const usage = (await store.spendUsage(limits))[0]!;
    expect(usage.reservedUsd).toBeCloseTo(0.9, 10);
    expect(usage.availableUsd).toBeGreaterThanOrEqual(0);
    expect(g.maxInside).toBe(1);
  });

  it("CASE E (person scope): an extension racing the same person's admission respects their limit; another person is not blocked", async () => {
    const { stores } = await instances(1);
    const store = stores[0]!;
    const u = await addUser(store);
    const v = await addUser(store);
    const forU = [userDaily(u, 1)];
    const r = await reserved(store, 0.6, forU, { userId: u });
    const g = gate(stores, 3, 1_500);
    const started = Date.now();
    const [mine, again, theirs] = await Promise.all([
      store.extendSpendReservation(more(r.id, 0.3, 0.6, forU)),
      store.reserveSpend(hold(0.3, forU, { userId: u })),
      store.reserveSpend(hold(0.3, [userDaily(v, 1)], { userId: v })),
    ]);
    expect([mine.ok, again.ok].filter(Boolean)).toHaveLength(1);
    expect(theirs.ok).toBe(true);
    expect(g.maxInside).toBe(2); // U's two writers never inside together; V's admission ran beside them
    expect(Date.now() - started).toBeLessThan(3 * 1_500);
  });

  it("CASE F: extensions from separate pools (API instances): one effect per attempt, and the limit holds", async () => {
    const { stores } = await instances(3);
    const [s1, s2, s3] = stores as [PostgresStore, PostgresStore, PostgresStore];
    const limits = [systemDaily(1)];
    const r = await reserved(s1, 0.4, limits);
    const g = gate(stores, 3);
    const same = await Promise.all([s1, s2, s3].map((s) => s.extendSpendReservation(more(r.id, 0.2, 0.4, limits))));
    expect(same.filter((x) => x.ok && x.extendedUsd > 0)).toHaveLength(1);
    expect(same.filter((x) => x.ok && x.duplicate)).toHaveLength(2);
    expect(await s3.getSpendReservation(r.id)).toMatchObject({ reservedUsd: 0.6 });
    expect(g.maxInside).toBe(1);

    // Different attempts of the same hold and two other requests' admissions, all at once, across instances.
    // Retry 1 (above) is registered with no ledger row yet: the store holds it beside each new attempt.
    const mixed = await Promise.all([
      s1.extendSpendReservation(more(r.id, 0.2, 0.4, limits, { retry: 2 })),
      s2.extendSpendReservation(more(r.id, 0.2, 0.4, limits, { fallbackIndex: 1, retry: 0 })),
      s3.reserveSpend(hold(0.2, limits)),
      s2.reserveSpend(hold(0.2, limits)),
    ]);
    // 0.60 already held; 0.40 left: exactly two of the four 0.20 increases fit.
    expect(mixed.filter((x) => x.ok && ("extendedUsd" in x ? x.extendedUsd > 0 : true))).toHaveLength(2);
    const usage = (await s1.spendUsage(limits))[0]!;
    expect(usage.reservedUsd).toBeCloseTo(1, 10);
    expect(usage.availableUsd).toBeCloseTo(0, 10);
  });

  it("an extension racing its own settlement: either it lands before (and settlement records the ledger) or it is refused", async () => {
    const { stores } = await instances(2);
    const [s1, s2] = stores as [PostgresStore, PostgresStore];
    const limits = [systemDaily(10)];
    for (let i = 0; i < 5; i++) {
      const r = await reserved(s1, 0.3, limits);
      await s1.recordInferenceAttempt(attempt(r.inferenceId, 0.1));
      const [extended, settled] = await Promise.all([s1.extendSpendReservation(more(r.id, 0.3, 0.3, limits)), s2.settleSpendReservation(r.id)]);
      const end = await s1.getSpendReservation(r.id);
      expect(end).toMatchObject({ status: "settled", actualUsd: 0.1 });
      expect(settled?.reservation.status).toBe("settled");
      if (extended.ok) expect(end!.reservedUsd).toBeCloseTo(0.6, 10);
      else expect(extended).toEqual({ ok: false, reason: "inactive" });
    }
    expect((await s1.spendUsage(limits))[0]!.reservedUsd).toBe(0);
  });

  it("CASE J: deadlocks are retried; a lock timeout or an unreachable database throws, and nothing half-done remains", async () => {
    const { stores, raw } = await instances(1);
    const store = stores[0]!;
    const limits = [systemDaily(1)];
    const r = await reserved(store, 0.4, limits);
    const g = gate(stores, 1, 0, [GROW]);
    g.fail = 2;
    expect(okResult(await store.extendSpendReservation(more(r.id, 0.1, 0.4, limits)))).toMatchObject({ extendedUsd: 0.1 });
    g.fail = 3;
    await expect(store.extendSpendReservation(more(r.id, 0.1, 0.5, limits, { retry: 2 }))).rejects.toMatchObject({ code: "40P01" });
    expect(await store.getSpendReservation(r.id)).toMatchObject({ reservedUsd: 0.5 });
    expect((await raw.query("SELECT count(*)::int AS n FROM spend_reservation_attempts WHERE reservation_id = $1", [r.id])).rows[0].n).toBe(1);

    // The system scope held elsewhere longer than the lock timeout: refused rather than waiting forever.
    const blocker = await raw.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(7262025, hashtext('system'))");
      const started = Date.now();
      await expect(store.extendSpendReservation(more(r.id, 0.1, 0.5, limits, { retry: 3 }))).rejects.toMatchObject({ code: "55P03" });
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
    expect(await store.getSpendReservation(r.id)).toMatchObject({ reservedUsd: 0.5 });

    const closed = await PostgresStore.connect({ connectionString: TEST_DATABASE_URL!, cipher: testCipher(), schema: (await instances(1)).schema, poolMax: 2 });
    await closed.close();
    await expect(closed.extendSpendReservation(more(r.id, 0.1, 0.5, limits))).rejects.toThrow();
  });

  it("an extension reads only this hold's rows through their indexes (no ledger or reservation scan)", async () => {
    const { stores, raw } = await instances(1);
    const store = stores[0]!;
    const r = await reserved(store, 0.4, [systemDaily(100)]);
    await raw.query(
      `INSERT INTO inference_attempts (id, inference_id, user_id, plan, task, provider, model, pricing, created_at, latency_ms, outcome, retry, round,
         fallback_index, estimated_input_tokens, estimated_output_tokens, token_source, estimated_cost_usd, currency, route)
       SELECT 'att-' || g, 'inf-' || (g % 2000), NULL, 'standard', 'chat', 'openai', 'm', CASE WHEN g % 4 = 0 THEN 'free' ELSE 'paid' END,
              now() - (g % 720) * interval '1 hour', 1, 'success', g % 3, 0, 0, 10, 10, 'estimated', 0.0001, 'USD', '{}'
         FROM generate_series(1, 20000) AS g`,
    );
    await raw.query(
      `INSERT INTO spend_reservations (id, inference_id, plan, task, provider, reserved_usd, actual_usd, status, created_at, expires_at, finished_at)
       SELECT 'old-' || g, 'old-inf-' || g, 'standard', 'chat', 'openai', 0.01, 0.01, 'settled', now() - interval '1 day', now() - interval '23 hours', now() - interval '23 hours'
         FROM generate_series(1, 5000) AS g`,
    );
    await raw.query(
      `INSERT INTO spend_reservation_attempts (reservation_id, fallback_index, round, retry, provider, model, attempt_usd, extended_usd, created_at)
       SELECT 'old-' || g, 0, 0, 1, 'openai', 'm', 0.01, 0.01, now() FROM generate_series(1, 5000) AS g`,
    );
    await raw.query("ANALYZE inference_attempts");
    await raw.query("ANALYZE spend_reservations");
    await raw.query("ANALYZE spend_reservation_attempts");
    let captured = "";
    const pool = store.pool as pg.Pool;
    const connect = pool.connect.bind(pool) as () => Promise<pg.PoolClient>;
    (pool as { connect: (...a: unknown[]) => unknown }).connect = (...args: unknown[]) => {
      if (args.length > 0) return (connect as (...a: unknown[]) => unknown)(...args);
      return connect().then((client) => {
        const query = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
        (client as unknown as { query: (...a: unknown[]) => Promise<unknown> }).query = async (...a: unknown[]) => {
          const text = typeof a[0] === "string" ? a[0] : "";
          if (text.includes("AS inflight_usd")) {
            const plan = (await query(`EXPLAIN ${text}`, a[1])) as { rows: Array<Record<string, string>> };
            captured = plan.rows.map((row) => row["QUERY PLAN"]).join("\n");
          }
          return query(...a);
        };
        return client;
      });
    };
    okResult(await store.extendSpendReservation(more(r.id, 0.5, 0.4, [systemDaily(100)])));
    expect(captured).toMatch(/spend_reservations_pkey/);
    expect(captured).toMatch(/inference_attempts_inference_idx/);
    expect(captured).toMatch(/spend_reservation_attempts_pkey/);
    expect(captured).not.toMatch(/Seq Scan on (inference_attempts|spend_reservations|spend_reservation_attempts)/);
    if (process.env.DASH_PRINT_PLANS) writeFileSync(process.env.DASH_PRINT_PLANS, `${captured}\n`);
  }, 60_000);

  it("migration 13 upgrades a database at the merged baseline (1–12) without touching its data, re-runs cleanly and fails atomically", async () => {
    const schema = `t_${randomBytes(6).toString("hex")}`;
    const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 2 });
    try {
      await pool.query(`CREATE TABLE schema_migrations (id integer PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
      for (const m of MIGRATIONS.filter((x) => x.id <= 12)) {
        await pool.query(m.sql);
        await pool.query("INSERT INTO schema_migrations (id, name, checksum) VALUES ($1, $2, $3)", [m.id, m.name, createHash("sha256").update(m.sql).digest("hex")]);
      }
      await pool.query(
        `INSERT INTO spend_reservations (id, inference_id, plan, task, provider, reserved_usd, status, created_at, expires_at)
         VALUES ('baseline-hold', 'baseline-inference', 'standard', 'chat', 'openai', 0.6, 'active', now(), now() + interval '10 minutes')`,
      );
      await expect(assertMigrated(pool)).rejects.toThrow(/missing 1 migration/);

      await pool.query("CREATE TABLE spend_reservation_attempts (id text)");
      await expect(migrate(pool)).rejects.toThrow(/Migration 13 \(spend_reservation_attempts\) failed/);
      expect((await pool.query("SELECT max(id) AS id FROM schema_migrations")).rows[0].id).toBe(12);
      await pool.query("DROP TABLE spend_reservation_attempts");

      expect((await migrate(pool)).applied).toEqual(["13_spend_reservation_attempts"]);
      expect((await migrate(pool)).applied).toEqual([]);
      await assertMigrated(pool);
      expect((await pool.query("SELECT id, reserved_usd::float8 AS usd, status FROM spend_reservations")).rows).toEqual([{ id: "baseline-hold", usd: 0.6, status: "active" }]);

      // The constraints refuse impossible rows; rows go with their hold.
      const add = (over: Record<string, unknown>) => {
        const row = { reservation_id: "baseline-hold", fallback_index: 0, round: 0, retry: 1, attempt_usd: 0.1, extended_usd: 0.1, ...over };
        return pool.query(
          `INSERT INTO spend_reservation_attempts (reservation_id, fallback_index, round, retry, provider, model, attempt_usd, extended_usd, created_at)
           VALUES ($1, $2, $3, $4, 'openai', 'm', $5, $6, now())`,
          [row.reservation_id, row.fallback_index, row.round, row.retry, row.attempt_usd, row.extended_usd],
        );
      };
      await add({});
      await expect(add({})).rejects.toThrow(/spend_reservation_attempts_pkey/);
      await expect(add({ retry: -1 })).rejects.toThrow(/spend_reservation_attempts_counts_check/);
      await expect(add({ retry: 5, attempt_usd: -0.1 })).rejects.toThrow(/spend_reservation_attempts_amounts_check/);
      await expect(add({ reservation_id: "no-such-hold" })).rejects.toThrow(/foreign key/);
      const { rows } = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'spend_reservation_attempts' AND table_schema = $1 ORDER BY ordinal_position", [schema]);
      expect(rows.map((r: { column_name: string }) => r.column_name)).toEqual([
        "reservation_id", "fallback_index", "round", "retry", "provider", "model", "attempt_usd", "extended_usd", "created_at",
      ]);
      await pool.query("UPDATE spend_reservations SET status = 'released', actual_usd = 0, finished_at = now()");
      await pool.query("DELETE FROM spend_reservations");
      expect((await pool.query("SELECT count(*)::int AS n FROM spend_reservation_attempts")).rows[0].n).toBe(0);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
});
