import type pg from "pg";
import type { ProviderId } from "@dash-ai/contracts";
import type { InferenceAttempt, UsageSource } from "./attemptLedger.js";
import { spendWindowBounds, type SpendWindow } from "./spendWindow.js";

export type AttemptLedgerQueryable = Pick<pg.Pool | pg.PoolClient, "query">;

/**
 * Additive schema for durable provider-attempt accounting. This SQL is kept separate until it is
 * appended as the next numbered migration; do not execute it ad-hoc in production.
 */
export const INFERENCE_ATTEMPTS_SCHEMA_SQL = `
CREATE TABLE inference_attempts (
  id                 text PRIMARY KEY,
  inference_id       text NOT NULL,
  user_id            text REFERENCES users (id) ON DELETE CASCADE,
  task               text NOT NULL,
  provider           text NOT NULL,
  configured_model   text NOT NULL,
  served_model       text,
  attempt_index      integer NOT NULL CHECK (attempt_index >= 0),
  fallback_index     integer NOT NULL CHECK (fallback_index >= 0),
  started_at         timestamptz NOT NULL,
  finished_at        timestamptz NOT NULL,
  latency_ms         integer NOT NULL CHECK (latency_ms >= 0),
  status             text NOT NULL CHECK (status IN ('success', 'failure', 'cancelled')),
  error_code         text,
  input_tokens       bigint,
  output_tokens      bigint,
  cached_tokens      bigint,
  usage_source       text NOT NULL CHECK (usage_source IN ('provider_reported', 'estimated', 'unknown')),
  estimated_cost_usd double precision,
  actual_cost_usd    double precision,
  currency           text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  CHECK (input_tokens IS NULL OR input_tokens >= 0),
  CHECK (output_tokens IS NULL OR output_tokens >= 0),
  CHECK (cached_tokens IS NULL OR cached_tokens >= 0),
  CHECK (estimated_cost_usd IS NULL OR estimated_cost_usd >= 0),
  CHECK (actual_cost_usd IS NULL OR actual_cost_usd >= 0),
  CHECK (finished_at >= started_at)
);
CREATE INDEX inference_attempts_inference_idx ON inference_attempts (inference_id, fallback_index, attempt_index, started_at);
CREATE INDEX inference_attempts_finished_idx ON inference_attempts (finished_at);
CREATE INDEX inference_attempts_user_finished_idx ON inference_attempts (user_id, finished_at) WHERE user_id IS NOT NULL;
`;

interface AttemptRow {
  id: string;
  inference_id: string;
  user_id: string | null;
  task: string;
  provider: string;
  configured_model: string;
  served_model: string | null;
  attempt_index: number;
  fallback_index: number;
  started_at: Date;
  finished_at: Date;
  latency_ms: number;
  status: string;
  error_code: string | null;
  input_tokens: string | number | null;
  output_tokens: string | number | null;
  cached_tokens: string | number | null;
  usage_source: string;
  estimated_cost_usd: number | null;
  actual_cost_usd: number | null;
  currency: string;
}

const tokenCount = (value: string | number | null): number | null => (value === null ? null : Number(value));
const iso = (value: Date): string => value.toISOString();

const toAttempt = (row: AttemptRow): InferenceAttempt => ({
  id: row.id,
  inferenceId: row.inference_id,
  userId: row.user_id,
  task: row.task,
  provider: row.provider as ProviderId,
  configuredModel: row.configured_model,
  servedModel: row.served_model,
  attemptIndex: row.attempt_index,
  fallbackIndex: row.fallback_index,
  startedAt: iso(row.started_at),
  finishedAt: iso(row.finished_at),
  latencyMs: row.latency_ms,
  status: row.status as InferenceAttempt["status"],
  errorCode: row.error_code,
  inputTokens: tokenCount(row.input_tokens),
  outputTokens: tokenCount(row.output_tokens),
  cachedTokens: tokenCount(row.cached_tokens),
  usageSource: row.usage_source as UsageSource,
  estimatedCostUsd: row.estimated_cost_usd,
  actualCostUsd: row.actual_cost_usd,
  currency: "USD",
});

/** Durable, append-only provider-attempt ledger. It stores metadata only, never prompt/response text. */
export class PostgresAttemptLedger {
  constructor(private readonly db: AttemptLedgerQueryable) {}

  async record(attempt: InferenceAttempt): Promise<void> {
    await this.db.query(
      `INSERT INTO inference_attempts (
         id, inference_id, user_id, task, provider, configured_model, served_model,
         attempt_index, fallback_index, started_at, finished_at, latency_ms, status, error_code,
         input_tokens, output_tokens, cached_tokens, usage_source,
         estimated_cost_usd, actual_cost_usd, currency)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [
        attempt.id,
        attempt.inferenceId,
        attempt.userId,
        attempt.task,
        attempt.provider,
        attempt.configuredModel,
        attempt.servedModel,
        attempt.attemptIndex,
        attempt.fallbackIndex,
        attempt.startedAt,
        attempt.finishedAt,
        attempt.latencyMs,
        attempt.status,
        attempt.errorCode,
        attempt.inputTokens,
        attempt.outputTokens,
        attempt.cachedTokens,
        attempt.usageSource,
        attempt.estimatedCostUsd,
        attempt.actualCostUsd,
        attempt.currency,
      ],
    );
  }

  async listByInference(inferenceId: string): Promise<InferenceAttempt[]> {
    const { rows } = await this.db.query<AttemptRow>(
      `SELECT * FROM inference_attempts
       WHERE inference_id = $1
       ORDER BY fallback_index, attempt_index, started_at, id`,
      [inferenceId],
    );
    return rows.map(toAttempt);
  }

  /**
   * Spend controls use settled/provider cost where present and otherwise the estimate. UTC boundaries
   * are explicit so every API instance agrees regardless of PostgreSQL's session timezone.
   */
  async spendWindow(nowIso: string, userId: string | null): Promise<SpendWindow> {
    const { dayStart, dayEnd, monthStart, monthEnd } = spendWindowBounds(nowIso);
    const { rows } = await this.db.query<{ user_daily: number | string; system_daily: number | string; system_monthly: number | string }>(
      `SELECT
         COALESCE(SUM(CASE
           WHEN $1::text IS NOT NULL AND user_id = $1
            AND finished_at >= $2::timestamptz AND finished_at < $3::timestamptz
           THEN COALESCE(actual_cost_usd, estimated_cost_usd, 0) ELSE 0 END), 0) AS user_daily,
         COALESCE(SUM(CASE
           WHEN finished_at >= $2::timestamptz AND finished_at < $3::timestamptz
           THEN COALESCE(actual_cost_usd, estimated_cost_usd, 0) ELSE 0 END), 0) AS system_daily,
         COALESCE(SUM(CASE
           WHEN finished_at >= $4::timestamptz AND finished_at < $5::timestamptz
           THEN COALESCE(actual_cost_usd, estimated_cost_usd, 0) ELSE 0 END), 0) AS system_monthly
       FROM inference_attempts
       WHERE finished_at >= $4::timestamptz AND finished_at < $5::timestamptz`,
      [userId, dayStart, dayEnd, monthStart, monthEnd],
    );
    const row = rows[0] ?? { user_daily: 0, system_daily: 0, system_monthly: 0 };
    return {
      userDailyUsd: Number(row.user_daily),
      systemDailyUsd: Number(row.system_daily),
      systemMonthlyUsd: Number(row.system_monthly),
    };
  }
}
