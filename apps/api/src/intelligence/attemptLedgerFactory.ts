import { PostgresStore } from "../store/postgresStore.js";
import type { Store } from "../store/store.js";
import type { AttemptRecorder, InferenceAttempt } from "./attemptLedger.js";
import { InMemoryAttemptLedger } from "./attemptLedgerMemory.js";
import { PostgresAttemptLedger } from "./attemptLedgerPersistence.js";
import type { SpendLedger } from "./spendAdmission.js";

/** Common boundary used by inference: append attempts and read the current spend window. */
export interface AttemptLedger extends AttemptRecorder, SpendLedger {}

/**
 * Chooses the attempt ledger beside the app's primary store. Production Postgres shares the same pool;
 * isolated/local memory stores keep attempt accounting in memory. Unknown Store implementations fall
 * back to memory rather than guessing how to persist.
 */
export function attemptLedgerForStore(store: Store): AttemptLedger {
  if (store instanceof PostgresStore) {
    const ledger = new PostgresAttemptLedger(store.pool);
    return {
      record: (attempt: InferenceAttempt) => ledger.record(attempt),
      spend: (nowIso: string, userId: string | null) => ledger.spendWindow(nowIso, userId),
    };
  }
  const ledger = new InMemoryAttemptLedger();
  return {
    record: (attempt: InferenceAttempt) => ledger.record(attempt),
    spend: (nowIso: string, userId: string | null) => ledger.spend(nowIso, userId),
  };
}
