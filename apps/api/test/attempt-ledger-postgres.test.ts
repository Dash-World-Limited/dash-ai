import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { InferenceAttempt } from "../src/intelligence/attemptLedger.js";
import { PostgresAttemptLedger } from "../src/intelligence/attemptLedgerPersistence.js";
import { TEST_DATABASE_URL, createTestPgStore, type TestPgStore } from "./pgTestStore.js";

if (process.env.REQUIRE_DB_TESTS === "1" && !TEST_DATABASE_URL) {
  throw new Error("REQUIRE_DB_TESTS=1 but TEST_DATABASE_URL is not set");
}

const dbDescribe = TEST_DATABASE_URL ? describe : describe.skip;

let seq = 0;
const nextId = (prefix: string) => `${prefix}_${++seq}_${Math.random().toString(16).slice(2, 10)}`;

const attempt = (overrides: Partial<InferenceAttempt> = {}): InferenceAttempt => ({
  id: nextId("attempt"),
  inferenceId: "inference_a",
  userId: null,
  task: "chat",
  provider: "bedrock",
  configuredModel: "configured-model",
  servedModel: "served-model",
  attemptIndex: 0,
  fallbackIndex: 0,
  startedAt: "2026-10-10T01:00:00.000Z",
  finishedAt: "2026-10-10T01:00:01.000Z",
  latencyMs: 1000,
  status: "success",
  errorCode: null,
  inputTokens: 100,
  outputTokens: 20,
  cachedTokens: null,
  usageSource: "provider_reported",
  estimatedCostUsd: 0.01,
  actualCostUsd: null,
  currency: "USD",
  ...overrides,
});

dbDescribe("PostgresAttemptLedger", () => {
  let pg: TestPgStore;
  let ledger: PostgresAttemptLedger;
  let userA: string;
  let userB: string;

  beforeAll(async () => {
    pg = await createTestPgStore();
    ledger = new PostgresAttemptLedger(pg.store.pool);
    userA = nextId("user_a");
    userB = nextId("user_b");
    await pg.store.createUser({ id: userA, email: `${userA}@example.com`, displayName: "A", passwordHash: "hash", createdAt: "2026-10-01T00:00:00.000Z" });
    await pg.store.createUser({ id: userB, email: `${userB}@example.com`, displayName: "B", passwordHash: "hash", createdAt: "2026-10-01T00:00:00.000Z" });
  });

  afterAll(async () => {
    await pg.dispose();
  });

  it("persists retries/fallbacks as separate immutable rows in route order", async () => {
    const inferenceId = nextId("inference");
    await ledger.record(attempt({ inferenceId, userId: userA, attemptIndex: 0, fallbackIndex: 0, status: "failure", errorCode: "rate_limited", estimatedCostUsd: 0.002 }));
    await ledger.record(attempt({ inferenceId, userId: userA, attemptIndex: 1, fallbackIndex: 0, status: "failure", errorCode: "provider_timeout", estimatedCostUsd: 0.003 }));
    await ledger.record(attempt({ inferenceId, userId: userA, attemptIndex: 0, fallbackIndex: 1, status: "success", errorCode: null, estimatedCostUsd: 0.01, actualCostUsd: 0.009 }));

    const rows = await ledger.listByInference(inferenceId);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => [r.fallbackIndex, r.attemptIndex, r.status, r.errorCode])).toEqual([
      [0, 0, "failure", "rate_limited"],
      [0, 1, "failure", "provider_timeout"],
      [1, 0, "success", null],
    ]);
    expect(rows.every((r) => r.inferenceId === inferenceId && r.provider === "bedrock")).toBe(true);
  });

  it("aggregates user daily, system daily and system monthly spend from every attempt", async () => {
    const prefix = nextId("spend");
    await ledger.record(attempt({ id: `${prefix}_a`, inferenceId: `${prefix}_1`, userId: userA, estimatedCostUsd: 1, actualCostUsd: 0.75 }));
    await ledger.record(attempt({ id: `${prefix}_b`, inferenceId: `${prefix}_2`, userId: userB, estimatedCostUsd: 2, actualCostUsd: null, finishedAt: "2026-10-10T02:00:00.000Z", startedAt: "2026-10-10T01:59:59.000Z" }));
    await ledger.record(attempt({ id: `${prefix}_c`, inferenceId: `${prefix}_3`, userId: userA, estimatedCostUsd: 3, actualCostUsd: null, finishedAt: "2026-10-09T23:00:00.000Z", startedAt: "2026-10-09T22:59:59.000Z" }));
    await ledger.record(attempt({ id: `${prefix}_d`, inferenceId: `${prefix}_4`, userId: userA, estimatedCostUsd: 4, actualCostUsd: null, finishedAt: "2026-09-30T23:00:00.000Z", startedAt: "2026-09-30T22:59:59.000Z" }));

    const spend = await ledger.spendWindow("2026-10-10T12:00:00.000Z", userA);
    // Other tests in this schema may have tiny Oct-10 rows, so assert the exact contribution via a
    // fresh user plus system lower bounds rather than assuming the table was otherwise empty.
    expect(spend.userDailyUsd).toBeGreaterThanOrEqual(0.75);
    expect(spend.systemDailyUsd).toBeGreaterThanOrEqual(2.75);
    expect(spend.systemMonthlyUsd).toBeGreaterThanOrEqual(5.75);
  });

  it("cascades a user's attempt metadata when the account is deleted", async () => {
    const disposable = nextId("user_delete");
    await pg.store.createUser({ id: disposable, email: `${disposable}@example.com`, displayName: "Delete", passwordHash: "hash", createdAt: "2026-10-01T00:00:00.000Z" });
    const inferenceId = nextId("delete_inference");
    await ledger.record(attempt({ inferenceId, userId: disposable }));
    expect(await ledger.listByInference(inferenceId)).toHaveLength(1);
    await pg.store.deleteUserData(disposable);
    expect(await ledger.listByInference(inferenceId)).toEqual([]);
  });
});
