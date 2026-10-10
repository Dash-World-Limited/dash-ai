import { describe, expect, it } from "vitest";
import { INFERENCE_ATTEMPTS_SCHEMA_SQL } from "../src/intelligence/attemptLedgerPersistence.js";
import { MIGRATIONS } from "../src/store/migrations.js";

describe("inference-attempt schema", () => {
  it("keeps the persistence contract in sync with migration 10", () => {
    const migration = MIGRATIONS.find((m) => m.id === 10);
    expect(migration?.name).toBe("inference_attempt_ledger");
    expect(migration?.sql.trim()).toBe(INFERENCE_ATTEMPTS_SCHEMA_SQL.trim());
  });
});
