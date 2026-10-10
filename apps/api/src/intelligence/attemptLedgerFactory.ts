import { MemoryStore } from "../store/memoryStore.js";
import { PostgresStore } from "../store/postgresStore.js";
import type { Store } from "../store/store.js";
import { InMemoryAttemptLedger } from "./attemptLedgerMemory.js";
import { PostgresAttemptLedger } from "./attemptLedgerPersistence.js";

export type AttemptLedger = InMemoryAttemptLedger | PostgresAttemptLedger;

/**
 * Chooses the attempt ledger beside the app's primary store. Production Postgres shares the same pool;
 * isolated/local memory stores keep attempt accounting in memory. Unknown Store implementations fall
 * back to memory rather than guessing how to persist.
 */
export function attemptLedgerForStore(store: Store): AttemptLedger {
  if (store instanceof PostgresStore) return new PostgresAttemptLedger(store.pool);
  if (store instanceof MemoryStore) return new InMemoryAttemptLedger();
  return new InMemoryAttemptLedger();
}
