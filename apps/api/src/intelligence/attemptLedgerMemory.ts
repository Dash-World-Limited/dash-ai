import type { InferenceAttempt } from "./attemptLedger.js";
import { aggregateSpendWindow, type SpendWindow } from "./spendWindow.js";

/** Lightweight in-memory attempt store for tests/development; durable production storage is PostgreSQL. */
export class InMemoryAttemptLedger {
  private readonly rows: InferenceAttempt[] = [];

  record(attempt: InferenceAttempt): void {
    this.rows.push({ ...attempt });
  }

  list(): InferenceAttempt[] {
    return this.rows.map((row) => ({ ...row }));
  }

  spend(nowIso: string, userId: string | null): SpendWindow {
    return aggregateSpendWindow(this.rows, nowIso, userId);
  }
}
