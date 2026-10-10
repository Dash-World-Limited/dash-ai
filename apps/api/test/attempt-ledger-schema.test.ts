import { describe, expect, it } from "vitest";
import { INFERENCE_ATTEMPTS_SCHEMA_SQL } from "../src/intelligence/attemptLedgerPersistence.js";
import { MIGRATIONS } from "../src/store/migrations.js";

const executableSql = (sql: string) =>
  sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .trim();

describe("inference-attempt schema", () => {
  it("keeps the persistence contract in sync with migration 10", () => {
    const migration = MIGRATIONS.find((m) => m.id === 10);
    expect(migration?.name).toBe("inference_attempt_ledger");
    expect(executableSql(migration?.sql ?? "")).toBe(executableSql(INFERENCE_ATTEMPTS_SCHEMA_SQL));
  });
});
