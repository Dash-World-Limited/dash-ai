import { createHash } from "node:crypto";
import pg from "pg";
import type { AssistantMode, AutomationRunStatus, AutomationRunTrigger, AutomationSchedule, AutomationStatus, NotificationKind, PushPlatform, DocumentKind, DocumentStatus, MessageRole, MessageStatus, ProviderId } from "@dash-ai/contracts";
import type { PluginSettingRecord, ToolInvocationRow } from "../tools/types.js";
import { DataKeyError, type DataCipher } from "../security/dataCrypto.js";
import { assertMigrated, migrate } from "./migrate.js";
import {
  type AutomationRecord,
  type AutomationRunRecord,
  type FinishRunInput,
  type NotificationRecord,
  type ClaimedPushDelivery,
  type FinishPushDeliveryInput,
  type PushDeliveryRecord,
  type PushDeliveryStatus,
  type PushDeviceRecord,
  type UpsertPushDeviceInput,
  type ScheduleRunInput,
  type ConversationChange,
  type ConversationChangePage,
  type ConversationRecord,
  type ConversationState,
  type DocumentRecord,
  type DocumentSummary,
  type MessageRecord,
  type PushConversationInput,
  type PushConversationResult,
  type RenameResult,
  type SessionRecord,
  type Store,
  type UsageRow,
  type InferenceAttemptRow,
  type InferenceSpend,
  type InferenceSpendQuery,
  type ExtendSpendInput,
  type ExtendSpendResult,
  type ReserveSpendInput,
  type ReserveSpendResult,
  type SettleSpendResult,
  type SpendLimit,
  type SpendReservationRecord,
  type SpendScope,
  type SpendUsage,
  type UserRecord,
  type ExportCursor,
  type ExportItem,
} from "./store.js";

export interface PostgresOptions {
  connectionString: string;
  cipher: DataCipher;
  ssl?: "disable" | "require" | "no-verify";
  poolMax?: number;
  /** How long a query may wait for a pooled connection before it fails (default 5 s). */
  acquireTimeoutMs?: number;
  /** Apply pending migrations on connect (otherwise the schema must already be current). */
  autoMigrate?: boolean;
  /** Isolated schema, used by tests. Must be a plain identifier. */
  schema?: string;
}

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

const iso = (d: Date | string): string => (typeof d === "string" ? new Date(d).toISOString() : d.toISOString());
const num = (v: string | number | null): number | null => (v === null ? null : Number(v));

interface UserRow { id: string; email: string; display_name: string; password_hash: string; created_at: Date }
interface ConversationRow {
  id: string; user_id: string; title_is_custom: boolean; mode: string;
  created_at: Date; updated_at: Date; deleted_at: Date | null; sync_seq: string; title_rev: number;
  /** Legacy plaintext (only rows written before migration 4 and not yet backfilled). */
  title: string | null; title_enc: Buffer | null; title_key_id: string | null;
}
interface MessageRow {
  id: string; conversation_id: string; role: string; origin: string | null; model: string | null;
  demo: boolean; status: string; compare_group_id: string | null; attachment_ids: string[]; created_at: Date;
  content: string | null; content_enc: Buffer | null; content_key_id: string | null;
}
interface DocumentRow {
  id: string; user_id: string; name: string; kind: string; mime_type: string; size_bytes: string; status: string;
  status_detail: string; extracted_chars: number; page_count: number | null; created_at: Date;
}

const toUser = (r: UserRow): UserRecord => ({
  id: r.id, email: r.email, displayName: r.display_name, passwordHash: r.password_hash, createdAt: iso(r.created_at),
});
const toSummary = (r: DocumentRow): DocumentSummary => ({
  id: r.id, userId: r.user_id, name: r.name, kind: r.kind as DocumentKind, mimeType: r.mime_type,
  sizeBytes: Number(r.size_bytes), status: r.status as DocumentStatus, statusDetail: r.status_detail,
  extractedChars: r.extracted_chars, pageCount: r.page_count, createdAt: iso(r.created_at),
});

// Additional authenticated data binds every ciphertext to its row: copied elsewhere, it fails to decrypt.
const documentAad = (userId: string, id: string) => `dash-ai:document:${userId}:${id}`;
const titleAad = (conversationId: string) => `dash-ai:conversation-title:${conversationId}`;
const contentAad = (conversationId: string, messageId: string) => `dash-ai:message:${conversationId}:${messageId}`;

const automationNameAad = (id: string) => `dash-ai:automation-name:${id}`;
const automationPromptAad = (id: string) => `dash-ai:automation-prompt:${id}`;
const runContentAad = (automationId: string, runId: string) => `dash-ai:automation-run:${automationId}:${runId}`;

interface AutomationRow {
  id: string; user_id: string; name_enc: Buffer; prompt_enc: Buffer; enc_key_id: string; mode: string;
  schedule: AutomationSchedule; time_zone: string; status: string; next_run_at: Date | null; created_at: Date; updated_at: Date;
}
interface RunRow {
  id: string; automation_id: string; user_id: string; trigger: string; status: string; content_enc: Buffer | null;
  content_key_id: string | null; error_code: string | null; created_at: Date; started_at: Date | null; finished_at: Date | null;
  lease_until: Date | null; edited_at: Date | null; provider: string | null; model: string | null; demo: boolean;
}
interface NotificationRow {
  id: string; user_id: string; kind: string; automation_id: string; run_id: string; created_at: Date; read_at: Date | null;
}
const isoOrNull = (d: Date | null): string | null => (d === null ? null : iso(d));

// ---- spend reservations ------------------------------------------------------------------------

/** Namespace of the spend admission advisory locks (the migration lock uses a different key). */
const SPEND_LOCK_CLASS = 7_262_025;
/** How long an admission waits for a busy scope before refusing (fail closed). */
const SPEND_LOCK_TIMEOUT = "3s";
/** Deadlock / serialization failure: retried. Lock timeout (55P03) is not. */
const RETRYABLE_TX = new Set(["40P01", "40001"]);
const SPEND_TX_ATTEMPTS = 3;

/** Paid ledger cost of one row, exactly as the spend limits count it (sumInferenceSpend). */
const LEDGER_COST = "COALESCE(provider_cost_usd, estimated_cost_usd, 0)::numeric";

/**
 * The advisory lock keys an admission under these limits must hold: one per scope with a limit.
 * Every writer that could change a scope's total holds that scope's lock while it checks and inserts.
 */
function spendLockKeys(limits: readonly SpendLimit[]): string[] {
  const keys = new Set<string>();
  for (const l of limits) {
    if (l.scope === "system_daily" || l.scope === "system_monthly") keys.add("system");
    else if (l.scope === "plan_daily") keys.add(`plan:${l.plan ?? ""}`);
    else keys.add(`user:${l.userId ?? ""}`);
  }
  return [...keys];
}

/** Takes the advisory lock of every scope with a limit, deduplicated and in one total order (no deadlock). */
async function lockSpendScopes(client: pg.PoolClient, limits: readonly SpendLimit[]): Promise<void> {
  const keys = spendLockKeys(limits);
  if (keys.length === 0) return;
  await client.query(
    `SELECT pg_advisory_xact_lock(${SPEND_LOCK_CLASS}, h)
       FROM (SELECT DISTINCT hashtext(k) AS h FROM unnest($1::text[]) AS k ORDER BY 1) AS locks`,
    [keys],
  );
}

const round10 = (usd: number): number => Math.round(usd * 1e10) / 1e10;

/**
 * One statement's worth of CTEs computing every limit's actual and outstanding (reserved) spend from a
 * single snapshot: `holds` (active, unexpired reservations in the scopes involved, each minus its own
 * paid ledger rows so far, never below zero) and `usage` (one row per limit, in order). Parameters are
 * appended to `params`.
 */
export function spendUsageCtes(limits: readonly SpendLimit[], params: unknown[]): string {
  const p = (v: unknown) => `$${params.push(v)}`;
  const system = limits.some((l) => l.scope === "system_daily" || l.scope === "system_monthly");
  const narrow: string[] = [];
  if (!system) {
    for (const l of limits) {
      if (l.scope === "plan_daily") narrow.push(`r.plan = ${p(l.plan ?? "")}`);
      if (l.scope === "user_daily") narrow.push(`r.user_id = ${p(l.userId ?? "")}`);
    }
  }
  const holds = `holds AS (
    SELECT r.user_id, r.plan,
           GREATEST(r.reserved_usd - COALESCE((SELECT sum(${LEDGER_COST}) FROM inference_attempts a
                                                WHERE a.inference_id = r.inference_id AND a.pricing = 'paid'), 0), 0) AS held
      FROM spend_reservations r
     WHERE r.status = 'active' AND r.expires_at > statement_timestamp()${narrow.length ? ` AND (${narrow.join(" OR ")})` : ""})`;
  const rows = limits.map((l, i) => {
    // System and plan windows start at a UTC midnight: read the per-day totals (equal to the ledger in
    // every snapshot, kept by trigger) rather than a month of ledger rows. Person limits, and any window
    // that does not start at midnight, read the ledger itself.
    const daily = l.scope !== "user_daily" && isUtcMidnight(l.since);
    const where = daily ? [`day >= ${p(l.since.slice(0, 10))}::date`] : ["pricing = 'paid'", `created_at >= ${p(l.since)}::timestamptz`];
    let held = "";
    if (l.scope === "plan_daily") {
      const plan = p(l.plan ?? "");
      where.push(`plan = ${plan}`);
      held = ` WHERE plan = ${plan}`;
    } else if (l.scope === "user_daily") {
      const user = p(l.userId ?? "");
      where.push(`user_id = ${user}`);
      held = ` WHERE user_id = ${user}`;
    }
    const actual = daily
      ? `(SELECT COALESCE(sum(paid_usd), 0) FROM inference_spend_daily WHERE ${where.join(" AND ")})`
      : `(SELECT COALESCE(sum(${LEDGER_COST}), 0) FROM inference_attempts WHERE ${where.join(" AND ")})`;
    return `SELECT ${i} AS ord, ${p(l.scope)}::text AS scope, ${p(String(l.limitUsd))}::numeric AS limit_usd,
           ${actual} AS actual_usd,
           (SELECT COALESCE(sum(held), 0) FROM holds${held}) AS reserved_usd`;
  });
  return `${holds}, usage AS (${rows.join(" UNION ALL ")})`;
}

/** True for an ISO time at exactly 00:00:00.000 UTC (the start of every system and plan window). */
const isUtcMidnight = (iso: string): boolean => {
  const t = Date.parse(iso);
  return Number.isFinite(t) && t % 86_400_000 === 0 && new Date(t).toISOString().slice(0, 10) === iso.slice(0, 10);
};

interface SpendUsageRow { scope: SpendScope; limit_usd: string; actual_usd: string; reserved_usd: string }
const toSpendUsage = (r: SpendUsageRow): SpendUsage => {
  const limitUsd = Number(r.limit_usd);
  const actualUsd = Number(r.actual_usd);
  const reservedUsd = Number(r.reserved_usd);
  return { scope: r.scope, limitUsd, actualUsd, reservedUsd, availableUsd: Math.round((limitUsd - actualUsd - reservedUsd) * 1e10) / 1e10 };
};

interface SpendReservationRow {
  id: string; inference_id: string; user_id: string | null; plan: string; task: string; provider: string; model: string | null;
  reserved_usd: string | number; actual_usd: string | number | null; status: SpendReservationRecord["status"];
  created_at: Date | string; expires_at: Date | string; finished_at: Date | string | null;
}
const toSpendReservation = (r: SpendReservationRow): SpendReservationRecord => ({
  id: r.id, inferenceId: r.inference_id, userId: r.user_id, plan: r.plan, task: r.task, provider: r.provider, model: r.model,
  reservedUsd: Number(r.reserved_usd), actualUsd: r.actual_usd === null ? null : Number(r.actual_usd), status: r.status,
  createdAt: iso(r.created_at), expiresAt: iso(r.expires_at), finishedAt: r.finished_at === null ? null : iso(r.finished_at),
});

/** USD amounts go to numeric(20, 10): rounded up (ignoring float noise), so a hold is never smaller than what was asked. */
const holdAmount = (usd: number): string => (Math.ceil(Math.max(0, usd) * 1e10 - 1e-6) / 1e10).toFixed(10);
const toNotification = (r: NotificationRow): NotificationRecord => ({
  id: r.id, userId: r.user_id, kind: r.kind as NotificationKind, automationId: r.automation_id, runId: r.run_id,
  createdAt: iso(r.created_at), readAt: isoOrNull(r.read_at),
});
const pushTokenAad = (deviceId: string) => `dash-ai:push-token:${deviceId}`;
/** Uniqueness key for a push token (the token itself is only stored encrypted). */
const pushTokenHash = (token: string) => createHash("sha256").update(`dash-ai:push-token:${token}`).digest("hex");

interface PushDeviceRow {
  id: string; user_id: string; session_hash: string; platform: string; token_enc: Buffer; token_key_id: string;
  app_version: string | null; created_at: Date; updated_at: Date;
}
interface PushDeliveryRow {
  id: string; notification_id: string; device_id: string; user_id: string; status: string; attempts: number;
  next_attempt_at: Date | null; lease_until: Date | null; last_error: string | null; created_at: Date; updated_at: Date;
}
const toPushDelivery = (r: PushDeliveryRow): PushDeliveryRecord => ({
  id: r.id, notificationId: r.notification_id, deviceId: r.device_id, userId: r.user_id, status: r.status as PushDeliveryStatus,
  attempts: r.attempts, nextAttemptAt: isoOrNull(r.next_attempt_at), leaseUntil: isoOrNull(r.lease_until), lastError: r.last_error,
  createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
});
const PUSH_DEVICE_COLUMNS = "id, user_id, session_hash, platform, token_enc, token_key_id, app_version, created_at, updated_at";

const RUN_COLUMNS =
  "id, automation_id, user_id, trigger, status, content_enc, content_key_id, error_code, created_at, started_at, finished_at, lease_until, edited_at, provider, model, demo";

const MESSAGE_COLUMNS = "conversation_id, id, role, content_enc, content_key_id, origin, model, demo, status, compare_group_id, attachment_ids, created_at";

/** PostgreSQL-backed store (the production implementation). */
export class PostgresStore implements Store {
  private closed = false;

  private constructor(
    readonly pool: pg.Pool,
    private readonly cipher: DataCipher,
  ) {}

  /** Connects, verifies connectivity and brings the schema up to date (or checks that it is). */
  static async connect(options: PostgresOptions): Promise<PostgresStore> {
    if (options.schema !== undefined && !/^[a-z_][a-z0-9_]{0,62}$/.test(options.schema)) {
      throw new Error("Invalid schema name.");
    }
    const ssl =
      options.ssl === "require" ? { rejectUnauthorized: true } : options.ssl === "no-verify" ? { rejectUnauthorized: false } : undefined;
    const pool = new pg.Pool({
      connectionString: options.connectionString,
      max: options.poolMax ?? 10,
      // Bounded wait for a connection (also bounds connecting to an unreachable server): an exhausted
      // pool or a database that went away answers "busy" in this time instead of queueing for ever.
      connectionTimeoutMillis: options.acquireTimeoutMs ?? 5_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 30_000,
      ...(ssl ? { ssl } : {}),
      ...(options.schema ? { options: `-c search_path=${options.schema}` } : {}),
    });
    // An idle client erroring (e.g. the server restarting) must not crash the process.
    pool.on("error", () => undefined);
    try {
      if (options.schema) await pool.query(`CREATE SCHEMA IF NOT EXISTS ${options.schema}`);
      if (options.autoMigrate ?? true) await migrate(pool);
      else await assertMigrated(pool);
    } catch (err) {
      await pool.end().catch(() => undefined);
      throw err;
    }
    const store = new PostgresStore(pool, options.cipher);
    try {
      await store.verifyCurrentKey();
    } catch (err) {
      await pool.end().catch(() => undefined);
      throw err;
    }
    // Development convenience: finish any plaintext backfill / key rotation right away. Production runs
    // it deliberately (pnpm --filter @dash-ai/api data:encrypt) and only gets a start-up report.
    if (options.autoMigrate ?? true) await store.runEncryptionMaintenance();
    return store;
  }

  /**
   * Refuses to run with a DATA_ENCRYPTION_KEY that does not match data already stored under its key id
   * (for example a new key configured under the old id). Without this, the mistake would only show up
   * as failures when that data is read, and new writes would mix two keys under one id.
   */
  async verifyCurrentKey(): Promise<void> {
    const id = this.cipher.keyId;
    const samples: Array<{ sql: string; aad: (r: Record<string, string>) => string; column: string }> = [
      {
        sql: "SELECT id, title_enc AS payload FROM conversations WHERE title_key_id = $1 AND title_enc IS NOT NULL LIMIT 1",
        aad: (r) => titleAad(r.id!),
        column: "conversation titles",
      },
      {
        sql: "SELECT conversation_id, id, content_enc AS payload FROM messages WHERE content_key_id = $1 LIMIT 1",
        aad: (r) => contentAad(r.conversation_id!, r.id!),
        column: "messages",
      },
      {
        sql: "SELECT id, user_id, extracted_text_enc AS payload FROM documents WHERE enc_key_id = $1 LIMIT 1",
        aad: (r) => documentAad(r.user_id!, r.id!),
        column: "documents",
      },
    ];
    for (const sample of samples) {
      const { rows } = await this.pool.query<Record<string, string> & { payload: Buffer }>(sample.sql, [id]);
      const row = rows[0];
      if (!row) continue;
      try {
        this.cipher.decrypt({ keyId: id, payload: row.payload }, sample.aad(row));
      } catch {
        throw new DataKeyError(
          `DATA_ENCRYPTION_KEY does not match the ${sample.column} already encrypted under key id "${id}". ` +
            "Restore the original key, or configure the new key under a NEW key id and keep the old one in DATA_ENCRYPTION_PREVIOUS_KEYS.",
        );
      }
    }
  }

  /** Repeats encryptionMaintenanceBatch until nothing is left. Returns the totals changed. */
  async runEncryptionMaintenance(batch = 200): Promise<{ titles: number; messages: number; documents: number; automations: number }> {
    const total = { titles: 0, messages: 0, documents: 0, automations: 0 };
    for (;;) {
      const n = await this.encryptionMaintenanceBatch(batch);
      total.titles += n.titles;
      total.messages += n.messages;
      total.documents += n.documents;
      total.automations += n.automations;
      if (n.titles + n.messages + n.documents + n.automations === 0) return total;
    }
  }

  /** Drops the isolated test schema created by `connect({ schema })`. */
  async dropSchema(schema: string): Promise<void> {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error("Invalid schema name.");
    await this.pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  }

  // ---- DASH Automates (names, prompts and results encrypted at rest) ----------------------------

  private toAutomation(r: AutomationRow): AutomationRecord {
    return {
      id: r.id, userId: r.user_id,
      name: this.cipher.decrypt({ keyId: r.enc_key_id, payload: r.name_enc }, automationNameAad(r.id)),
      prompt: this.cipher.decrypt({ keyId: r.enc_key_id, payload: r.prompt_enc }, automationPromptAad(r.id)),
      mode: r.mode as AssistantMode, schedule: r.schedule, timeZone: r.time_zone, status: r.status as AutomationStatus,
      nextRunAt: isoOrNull(r.next_run_at), createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
    };
  }

  private toRun(r: RunRow): AutomationRunRecord {
    const content =
      r.content_enc && r.content_key_id ? this.cipher.decrypt({ keyId: r.content_key_id, payload: r.content_enc }, runContentAad(r.automation_id, r.id)) : "";
    return {
      id: r.id, automationId: r.automation_id, userId: r.user_id, trigger: r.trigger as AutomationRunTrigger,
      status: r.status as AutomationRunStatus, content, errorCode: r.error_code, createdAt: iso(r.created_at),
      startedAt: isoOrNull(r.started_at), finishedAt: isoOrNull(r.finished_at), leaseUntil: isoOrNull(r.lease_until),
      editedAt: isoOrNull(r.edited_at), provider: r.provider as ProviderId | null, model: r.model, demo: r.demo,
    };
  }

  private async insertRun(q: Queryable, run: AutomationRunRecord): Promise<boolean> {
    const enc = run.content ? this.cipher.encrypt(run.content, runContentAad(run.automationId, run.id)) : null;
    const res = await q.query(
      `INSERT INTO automation_runs (id, automation_id, user_id, trigger, status, content_enc, content_key_id, error_code,
         created_at, started_at, finished_at, lease_until, edited_at, provider, model, demo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (automation_id) WHERE status IN ('queued', 'running') DO NOTHING`,
      [run.id, run.automationId, run.userId, run.trigger, run.status, enc?.payload ?? null, enc?.keyId ?? null, run.errorCode,
        run.createdAt, run.startedAt, run.finishedAt, run.leaseUntil, run.editedAt, run.provider, run.model, run.demo],
    );
    return res.rowCount === 1;
  }

  async countAutomations(userId: string): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>("SELECT count(*) AS n FROM automations WHERE user_id = $1", [userId]);
    return Number(rows[0]!.n);
  }

  async createAutomation(a: AutomationRecord): Promise<boolean> {
    const name = this.cipher.encrypt(a.name, automationNameAad(a.id));
    const prompt = this.cipher.encrypt(a.prompt, automationPromptAad(a.id));
    try {
      const res = await this.pool.query(
        `INSERT INTO automations (id, user_id, name_enc, prompt_enc, enc_key_id, mode, schedule, time_zone, status, next_run_at, created_at, updated_at)
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12 WHERE EXISTS (SELECT 1 FROM users WHERE id = $2)
         ON CONFLICT (id) DO NOTHING`,
        [a.id, a.userId, name.payload, prompt.payload, name.keyId, a.mode, JSON.stringify(a.schedule), a.timeZone, a.status, a.nextRunAt, a.createdAt, a.updatedAt],
      );
      return res.rowCount === 1;
    } catch (err) {
      // The account was deleted between the check and the insert.
      if ((err as { code?: string }).code === "23503") return false;
      throw err;
    }
  }

  async getAutomation(userId: string, id: string): Promise<AutomationRecord | undefined> {
    const { rows } = await this.pool.query<AutomationRow>("SELECT * FROM automations WHERE id = $1 AND user_id = $2", [id, userId]);
    return rows[0] && this.toAutomation(rows[0]);
  }

  async listAutomations(userId: string): Promise<AutomationRecord[]> {
    const { rows } = await this.pool.query<AutomationRow>("SELECT * FROM automations WHERE user_id = $1 ORDER BY created_at DESC, id DESC", [userId]);
    return rows.map((r) => this.toAutomation(r));
  }

  async updateAutomation(a: AutomationRecord): Promise<boolean> {
    const name = this.cipher.encrypt(a.name, automationNameAad(a.id));
    const prompt = this.cipher.encrypt(a.prompt, automationPromptAad(a.id));
    const res = await this.pool.query(
      `UPDATE automations SET name_enc = $3, prompt_enc = $4, enc_key_id = $5, mode = $6, schedule = $7, time_zone = $8,
         status = $9, next_run_at = $10, updated_at = $11
       WHERE id = $1 AND user_id = $2`,
      [a.id, a.userId, name.payload, prompt.payload, name.keyId, a.mode, JSON.stringify(a.schedule), a.timeZone, a.status, a.nextRunAt, a.updatedAt],
    );
    return res.rowCount === 1;
  }

  async deleteAutomation(userId: string, id: string): Promise<boolean> {
    const res = await this.pool.query("DELETE FROM automations WHERE id = $1 AND user_id = $2", [id, userId]);
    return res.rowCount === 1;
  }

  async listDueAutomations(now: string, limit: number): Promise<AutomationRecord[]> {
    const { rows } = await this.pool.query<AutomationRow>(
      "SELECT * FROM automations WHERE status = 'active' AND next_run_at <= $1 ORDER BY next_run_at LIMIT $2",
      [now, limit],
    );
    return rows.map((r) => this.toAutomation(r));
  }

  async scheduleRun(input: ScheduleRunInput): Promise<"queued" | "skipped" | "lost"> {
    return this.tx(async (client) => {
      const moved = await client.query(
        `UPDATE automations SET next_run_at = $2, status = CASE WHEN $2::timestamptz IS NULL THEN 'completed' ELSE status END, updated_at = $3
         WHERE id = $1 AND status = 'active' AND next_run_at = $4`,
        [input.automationId, input.nextRunAt, input.updatedAt, input.expectedNextRunAt],
      );
      if (moved.rowCount !== 1) return "lost";
      return (await this.insertRun(client, input.run)) ? "queued" : "skipped";
    });
  }

  async enqueueRun(run: AutomationRunRecord): Promise<boolean> {
    try {
      const { rows } = await this.pool.query("SELECT 1 FROM automations WHERE id = $1 AND user_id = $2", [run.automationId, run.userId]);
      if (rows.length === 0) return false;
      return await this.insertRun(this.pool, run);
    } catch (err) {
      if ((err as { code?: string }).code === "23503") return false;
      throw err;
    }
  }

  async claimQueuedRun(now: string, leaseMs: number): Promise<AutomationRunRecord | undefined> {
    // The lease is on the database clock: one clock for every instance (listStaleRuns uses it too).
    const { rows } = await this.pool.query<RunRow>(
      `UPDATE automation_runs SET status = 'running', started_at = $1,
         lease_until = statement_timestamp() + $2::double precision * interval '1 millisecond'
       WHERE id = (SELECT id FROM automation_runs WHERE status = 'queued' ORDER BY position FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING ${RUN_COLUMNS}`,
      [now, Math.max(1, Math.round(leaseMs))],
    );
    return rows[0] && this.toRun(rows[0]);
  }

  async discardRun(runId: string): Promise<void> {
    await this.pool.query("DELETE FROM automation_runs WHERE id = $1 AND status = 'running'", [runId]);
  }

  async finishRun(input: FinishRunInput): Promise<boolean> {
    try {
      return await this.tx(async (client) => {
        const { rows } = await client.query<{ automation_id: string }>("SELECT automation_id FROM automation_runs WHERE id = $1 AND status = 'running' FOR UPDATE", [input.runId]);
        const automationId = rows[0]?.automation_id;
        if (!automationId) return false;
        const enc = input.content ? this.cipher.encrypt(input.content, runContentAad(automationId, input.runId)) : null;
        await client.query(
          `UPDATE automation_runs SET status = $2, content_enc = $3, content_key_id = $4, error_code = $5, finished_at = $6,
             lease_until = NULL, provider = $7, model = $8, demo = $9
           WHERE id = $1`,
          [input.runId, input.status, enc?.payload ?? null, enc?.keyId ?? null, input.errorCode, input.finishedAt, input.provider, input.model, input.demo],
        );
        const n = input.notification;
        await client.query(
          "INSERT INTO notifications (id, user_id, kind, automation_id, run_id, created_at, read_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
          [n.id, n.userId, n.kind, n.automationId, n.runId, n.createdAt, n.readAt],
        );
        if (input.pushAt !== null) {
          // One delivery per live device of this user (a valid session, Automates pushes on), in this transaction.
          await client.query(
            `INSERT INTO push_deliveries (id, notification_id, device_id, user_id, status, attempts, next_attempt_at, created_at, updated_at)
             SELECT gen_random_uuid()::text, $1, d.id, d.user_id, 'pending', 0, $3, $3, $3
             FROM push_devices d
             JOIN sessions s ON s.token_hash = d.session_hash AND s.expires_at > $3
             JOIN users u ON u.id = d.user_id AND u.push_automates
             WHERE d.user_id = $2
             ON CONFLICT (notification_id, device_id) DO NOTHING`,
            [n.id, n.userId, input.pushAt],
          );
        }
        // Keep the newest finished runs; their notifications go with them (FK cascade).
        await client.query(
          `DELETE FROM automation_runs WHERE automation_id = $1 AND status IN ('ready', 'failed') AND id NOT IN (
             SELECT id FROM automation_runs WHERE automation_id = $1 AND status IN ('ready', 'failed') ORDER BY position DESC LIMIT $2)`,
          [automationId, input.keep],
        );
        return true;
      });
    } catch (err) {
      // The automation or account was deleted while the run was finishing.
      if ((err as { code?: string }).code === "23503") return false;
      throw err;
    }
  }

  async listStaleRuns(_now: string, limit: number): Promise<AutomationRunRecord[]> {
    // Database clock, not the caller's: an instance whose clock runs fast cannot expire a healthy run.
    const { rows } = await this.pool.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM automation_runs WHERE status = 'running' AND lease_until < statement_timestamp() ORDER BY lease_until LIMIT $1`,
      [limit],
    );
    return rows.map((r) => this.toRun(r));
  }

  async getRun(userId: string, automationId: string, runId: string): Promise<AutomationRunRecord | undefined> {
    const { rows } = await this.pool.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM automation_runs WHERE id = $1 AND automation_id = $2 AND user_id = $3`,
      [runId, automationId, userId],
    );
    return rows[0] && this.toRun(rows[0]);
  }

  async listRuns(userId: string, automationId: string, limit: number): Promise<AutomationRunRecord[]> {
    const { rows } = await this.pool.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM automation_runs WHERE automation_id = $1 AND user_id = $2 ORDER BY position DESC LIMIT $3`,
      [automationId, userId, limit],
    );
    return rows.map((r) => this.toRun(r));
  }

  async updateRunContent(userId: string, automationId: string, runId: string, content: string, editedAt: string): Promise<boolean> {
    const enc = this.cipher.encrypt(content, runContentAad(automationId, runId));
    const res = await this.pool.query(
      `UPDATE automation_runs SET content_enc = $4, content_key_id = $5, edited_at = $6
       WHERE id = $1 AND automation_id = $2 AND user_id = $3 AND status = 'ready'`,
      [runId, automationId, userId, enc.payload, enc.keyId, editedAt],
    );
    return res.rowCount === 1;
  }

  async listNotifications(userId: string, limit: number): Promise<NotificationRecord[]> {
    const { rows } = await this.pool.query<NotificationRow>(
      "SELECT id, user_id, kind, automation_id, run_id, created_at, read_at FROM notifications WHERE user_id = $1 ORDER BY position DESC LIMIT $2",
      [userId, limit],
    );
    return rows.map(toNotification);
  }

  async countUnreadNotifications(userId: string): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>("SELECT count(*) AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL", [userId]);
    return Number(rows[0]!.n);
  }

  async markNotificationsRead(userId: string, ids: string[] | null, readAt: string): Promise<number> {
    const res = ids
      ? await this.pool.query("UPDATE notifications SET read_at = $3 WHERE user_id = $1 AND id = ANY($2) AND read_at IS NULL", [userId, ids, readAt])
      : await this.pool.query("UPDATE notifications SET read_at = $2 WHERE user_id = $1 AND read_at IS NULL", [userId, readAt]);
    return res.rowCount ?? 0;
  }

  // ---- Push notifications (tokens encrypted at rest) ---------------------------------------------

  private toPushDevice(r: PushDeviceRow): PushDeviceRecord {
    return {
      id: r.id, userId: r.user_id, sessionHash: r.session_hash, platform: r.platform as PushPlatform,
      token: this.cipher.decrypt({ keyId: r.token_key_id, payload: r.token_enc }, pushTokenAad(r.id)),
      appVersion: r.app_version, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
    };
  }

  async upsertPushDevice(input: UpsertPushDeviceInput): Promise<PushDeviceRecord | undefined> {
    const hash = pushTokenHash(input.token);
    try {
      return await this.tx(async (client) => {
        // The session must still exist and belong to this user (locked so a sign-out waits for us).
        const session = await client.query("SELECT 1 FROM sessions WHERE token_hash = $1 AND user_id = $2 FOR KEY SHARE", [input.sessionHash, input.userId]);
        if (session.rowCount !== 1) return undefined;
        // This session's other token, and this token under another session or account, are replaced.
        await client.query(
          `DELETE FROM push_devices WHERE (session_hash = $1 OR token_hash = $2)
             AND NOT (session_hash = $1 AND token_hash = $2 AND user_id = $3)`,
          [input.sessionHash, hash, input.userId],
        );
        const same = await client.query<PushDeviceRow>(
          `UPDATE push_devices SET platform = $2, app_version = $3, updated_at = $4 WHERE session_hash = $1 RETURNING ${PUSH_DEVICE_COLUMNS}`,
          [input.sessionHash, input.platform, input.appVersion, input.now],
        );
        if (same.rows[0]) return this.toPushDevice(same.rows[0]);
        const enc = this.cipher.encrypt(input.token, pushTokenAad(input.id));
        const { rows } = await client.query<PushDeviceRow>(
          `INSERT INTO push_devices (id, user_id, session_hash, platform, token_hash, token_enc, token_key_id, app_version, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING ${PUSH_DEVICE_COLUMNS}`,
          [input.id, input.userId, input.sessionHash, input.platform, hash, enc.payload, enc.keyId, input.appVersion, input.now],
        );
        return this.toPushDevice(rows[0]!);
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      // 23503: the session or account went away meanwhile. 23505: the same token registered concurrently.
      if (code === "23503") return undefined;
      if (code === "23505") return this.upsertPushDevice(input);
      throw err;
    }
  }

  async getPushDeviceForSession(sessionHash: string): Promise<PushDeviceRecord | undefined> {
    const { rows } = await this.pool.query<PushDeviceRow>(`SELECT ${PUSH_DEVICE_COLUMNS} FROM push_devices WHERE session_hash = $1`, [sessionHash]);
    return rows[0] && this.toPushDevice(rows[0]);
  }

  async listPushDevices(userId: string): Promise<PushDeviceRecord[]> {
    const { rows } = await this.pool.query<PushDeviceRow>(
      `SELECT ${PUSH_DEVICE_COLUMNS} FROM push_devices WHERE user_id = $1 ORDER BY created_at, id`,
      [userId],
    );
    return rows.map((r) => this.toPushDevice(r));
  }

  async deletePushDevice(userId: string, id: string): Promise<boolean> {
    const res = await this.pool.query("DELETE FROM push_devices WHERE id = $1 AND user_id = $2", [id, userId]);
    return res.rowCount === 1;
  }

  async deletePushDeviceForSession(sessionHash: string): Promise<boolean> {
    const res = await this.pool.query("DELETE FROM push_devices WHERE session_hash = $1", [sessionHash]);
    return (res.rowCount ?? 0) > 0;
  }

  async removeInvalidPushDevice(id: string): Promise<boolean> {
    const res = await this.pool.query("DELETE FROM push_devices WHERE id = $1", [id]);
    return res.rowCount === 1;
  }

  async getPushPreferences(userId: string): Promise<{ automates: boolean }> {
    const { rows } = await this.pool.query<{ push_automates: boolean }>("SELECT push_automates FROM users WHERE id = $1", [userId]);
    return { automates: rows[0]?.push_automates ?? true };
  }

  async setPushPreferences(userId: string, prefs: { automates: boolean }): Promise<void> {
    await this.pool.query("UPDATE users SET push_automates = $2 WHERE id = $1", [userId, prefs.automates]);
  }

  async claimPushDeliveries(now: string, leaseMs: number, limit: number): Promise<ClaimedPushDelivery[]> {
    return this.tx(async (client) => {
      // Send leases are on the database clock (one clock for every instance); retry times stay the caller's.
      const claimed = await client.query<PushDeliveryRow>(
        `UPDATE push_deliveries SET status = 'sending', attempts = attempts + 1,
           lease_until = statement_timestamp() + $2::double precision * interval '1 millisecond', updated_at = $1
         WHERE id IN (
           SELECT id FROM push_deliveries
           WHERE (status = 'pending' AND next_attempt_at <= $1) OR (status = 'sending' AND lease_until < statement_timestamp())
           ORDER BY coalesce(next_attempt_at, created_at) LIMIT $3 FOR UPDATE SKIP LOCKED)
         RETURNING *`,
        [now, Math.max(1, Math.round(leaseMs)), limit],
      );
      if (claimed.rows.length === 0) return [];
      const deviceIds = [...new Set(claimed.rows.map((r) => r.device_id))];
      const devices = await client.query<PushDeviceRow & { expires_at: Date | null; push_automates: boolean }>(
        `SELECT d.id, d.user_id, d.session_hash, d.platform, d.token_enc, d.token_key_id, d.app_version, d.created_at, d.updated_at,
                s.expires_at, u.push_automates
         FROM push_devices d JOIN users u ON u.id = d.user_id LEFT JOIN sessions s ON s.token_hash = d.session_hash
         WHERE d.id = ANY($1)`,
        [deviceIds],
      );
      const notes = await client.query<NotificationRow>(
        "SELECT id, user_id, kind, automation_id, run_id, created_at, read_at FROM notifications WHERE id = ANY($1)",
        [[...new Set(claimed.rows.map((r) => r.notification_id))]],
      );
      const deviceById = new Map(devices.rows.map((d) => [d.id, d]));
      const noteById = new Map(notes.rows.map((n) => [n.id, toNotification(n)]));
      const t = Date.parse(now);
      const out: ClaimedPushDelivery[] = [];
      for (const r of claimed.rows.sort((a, b) => Date.parse(iso(a.next_attempt_at ?? a.created_at)) - Date.parse(iso(b.next_attempt_at ?? b.created_at)))) {
        const d = deviceById.get(r.device_id);
        const notification = noteById.get(r.notification_id);
        if (!d || !notification) continue;
        out.push({
          delivery: toPushDelivery(r),
          device: this.toPushDevice(d),
          notification,
          sessionValid: d.expires_at !== null && d.expires_at.getTime() > t,
          automatesEnabled: d.push_automates,
        });
      }
      return out;
    });
  }

  async finishPushDelivery(input: FinishPushDeliveryInput): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE push_deliveries SET status = $2, next_attempt_at = $3, lease_until = NULL, last_error = $4, updated_at = $5
       WHERE id = $1 AND status = 'sending'`,
      [input.id, input.status, input.nextAttemptAt, input.lastError, input.now],
    );
    return res.rowCount === 1;
  }

  async listPushDeliveries(userId: string): Promise<PushDeliveryRecord[]> {
    const { rows } = await this.pool.query<PushDeliveryRow>("SELECT * FROM push_deliveries WHERE user_id = $1 ORDER BY created_at, id", [userId]);
    return rows.map(toPushDelivery);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }

  private async tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Bumps the owner's change counter and stamps the conversation with it. The user row lock is
   * held until commit, so one user's sequence numbers become visible in order and a sync cursor
   * can never skip a change.
   *
   * Lock order (every transaction in this store): the conversation row first, then the user row.
   * Taking them the other way round here once deadlocked against saveConversation when the same
   * message was sent twice at once (a reconnecting client). `FOR NO KEY UPDATE` is enough (keys never
   * change) and does not conflict with the key-share locks that message inserts take.
   */
  private async touch(q: Queryable, conversationId: string): Promise<void> {
    await q.query(
      `WITH c AS (SELECT user_id FROM conversations WHERE id = $1 FOR NO KEY UPDATE),
       u AS (
         UPDATE users SET sync_counter = sync_counter + 1
         WHERE id = (SELECT user_id FROM c)
         RETURNING sync_counter)
       UPDATE conversations SET sync_seq = (SELECT sync_counter FROM u) WHERE id = $1`,
      [conversationId],
    );
  }

  // ---- users and sessions ----------------------------------------------------------------------

  poolStats(): { total: number; idle: number; waiting: number; max: number } {
    return { total: this.pool.totalCount, idle: this.pool.idleCount, waiting: this.pool.waitingCount, max: this.pool.options.max ?? 10 };
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async createUser(user: UserRecord): Promise<boolean> {
    const res = await this.pool.query(
      `INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (email) DO NOTHING`,
      [user.id, user.email.toLowerCase(), user.displayName, user.passwordHash, user.createdAt],
    );
    return res.rowCount === 1;
  }

  async findUserByEmail(email: string): Promise<UserRecord | undefined> {
    const { rows } = await this.pool.query<UserRow>("SELECT * FROM users WHERE email = $1", [email.toLowerCase()]);
    return rows[0] && toUser(rows[0]);
  }

  async findUserById(id: string): Promise<UserRecord | undefined> {
    const { rows } = await this.pool.query<UserRow>("SELECT * FROM users WHERE id = $1", [id]);
    return rows[0] && toUser(rows[0]);
  }

  async replacePasswordHash(userId: string, expected: string, next: string): Promise<boolean> {
    const res = await this.pool.query("UPDATE users SET password_hash = $3 WHERE id = $1 AND password_hash = $2", [userId, expected, next]);
    return res.rowCount === 1;
  }

  async deleteUserData(userId: string): Promise<void> {
    // Every owned table cascades from users. The account's conversations are locked first, in id
    // order, then the user row: the same order every chat write takes (lockConversation), so a
    // deletion and an answer that is still being saved can no longer deadlock. A deadlock with any
    // other writer is still possible in principle; PostgreSQL then aborts one side and this retries.
    for (let attempt = 1; ; attempt++) {
      try {
        await this.tx(async (client) => {
          await client.query("SELECT id FROM conversations WHERE user_id = $1 ORDER BY id FOR UPDATE", [userId]);
          await client.query("DELETE FROM users WHERE id = $1", [userId]);
        });
        return;
      } catch (err) {
        const code = (err as { code?: string }).code;
        if ((code !== "40P01" && code !== "40001") || attempt >= 4) throw err;
        await new Promise((r) => setTimeout(r, 20 * attempt + Math.floor(Math.random() * 30)));
      }
    }
  }

  async createSession(session: SessionRecord): Promise<void> {
    await this.pool.query("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ($1,$2,$3,$4)", [
      session.tokenHash, session.userId, session.createdAt, session.expiresAt,
    ]);
  }

  async findSession(tokenHash: string): Promise<SessionRecord | undefined> {
    const { rows } = await this.pool.query<{ token_hash: string; user_id: string; created_at: Date; expires_at: Date }>(
      "SELECT * FROM sessions WHERE token_hash = $1",
      [tokenHash],
    );
    const r = rows[0];
    return r && { tokenHash: r.token_hash, userId: r.user_id, createdAt: iso(r.created_at), expiresAt: iso(r.expires_at) };
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.pool.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash]);
  }

  async deleteSessionsForUser(userId: string): Promise<number> {
    const res = await this.pool.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
    return res.rowCount ?? 0;
  }

  async purgeExpiredSessions(now: Date): Promise<number> {
    const res = await this.pool.query("DELETE FROM sessions WHERE expires_at <= $1", [now.toISOString()]);
    return res.rowCount ?? 0;
  }

  // ---- conversations and messages (titles and content encrypted at rest) ------------------------

  private titleOf(r: ConversationRow): string {
    if (r.title_enc && r.title_key_id) return this.cipher.decrypt({ keyId: r.title_key_id, payload: r.title_enc }, titleAad(r.id));
    return r.title ?? "";
  }

  private toConversation(r: ConversationRow): ConversationRecord {
    return {
      id: r.id, userId: r.user_id, title: this.titleOf(r), titleIsCustom: r.title_is_custom, mode: r.mode as AssistantMode,
      createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
    };
  }

  private toMessage(r: MessageRow): MessageRecord {
    const content =
      r.content_enc && r.content_key_id
        ? this.cipher.decrypt({ keyId: r.content_key_id, payload: r.content_enc }, contentAad(r.conversation_id, r.id))
        : (r.content ?? "");
    return {
      id: r.id, conversationId: r.conversation_id, role: r.role as MessageRole, content,
      origin: r.origin as ProviderId | null, model: r.model, demo: r.demo, status: r.status as MessageStatus,
      compareGroupId: r.compare_group_id, attachmentIds: r.attachment_ids, createdAt: iso(r.created_at),
    };
  }

  private messageParams(m: MessageRecord): unknown[] {
    const enc = this.cipher.encrypt(m.content, contentAad(m.conversationId, m.id));
    return [m.conversationId, m.id, m.role, enc.payload, enc.keyId, m.origin, m.model, m.demo, m.status, m.compareGroupId, m.attachmentIds, m.createdAt];
  }

  private async lockConversation(client: pg.PoolClient, id: string): Promise<ConversationRow | undefined> {
    const { rows } = await client.query<ConversationRow>("SELECT * FROM conversations WHERE id = $1 FOR NO KEY UPDATE", [id]);
    return rows[0];
  }

  async getConversation(userId: string, id: string): Promise<ConversationRecord | undefined> {
    const { rows } = await this.pool.query<ConversationRow>(
      "SELECT * FROM conversations WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
      [id, userId],
    );
    return rows[0] && this.toConversation(rows[0]);
  }

  async conversationExists(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query("SELECT 1 FROM conversations WHERE id = $1", [id]);
    return (rowCount ?? 0) > 0;
  }

  async conversationState(userId: string, id: string): Promise<ConversationState> {
    const { rows } = await this.pool.query<{ deleted_at: Date | null }>(
      "SELECT deleted_at FROM conversations WHERE id = $1 AND user_id = $2",
      [id, userId],
    );
    if (!rows[0]) return "absent";
    return rows[0].deleted_at ? "deleted" : "live";
  }

  async saveConversation(c: ConversationRecord): Promise<void> {
    await this.tx(async (client) => {
      const existing = await this.lockConversation(client, c.id);
      if (existing && (existing.user_id !== c.userId || existing.deleted_at)) return;
      const enc = this.cipher.encrypt(c.title, titleAad(c.id));
      if (!existing) {
        const res = await client.query(
          `INSERT INTO conversations (id, user_id, title, title_enc, title_key_id, title_is_custom, mode, created_at, updated_at)
           VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
          [c.id, c.userId, enc.payload, enc.keyId, c.titleIsCustom, c.mode, c.createdAt, c.updatedAt],
        );
        if (res.rowCount === 1) await this.touch(client, c.id);
        return;
      }
      const titleChanged = this.titleOf(existing) !== c.title;
      await client.query(
        `UPDATE conversations SET title = NULL, title_enc = $2, title_key_id = $3, title_is_custom = $4, mode = $5,
           updated_at = $6, title_rev = title_rev + $7 WHERE id = $1`,
        [c.id, enc.payload, enc.keyId, c.titleIsCustom, c.mode, c.updatedAt, titleChanged ? 1 : 0],
      );
      await this.touch(client, c.id);
    });
  }

  async listConversations(userId: string): Promise<ConversationRecord[]> {
    const { rows } = await this.pool.query<ConversationRow>(
      "SELECT * FROM conversations WHERE user_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC, id",
      [userId],
    );
    return rows.map((r) => this.toConversation(r));
  }

  async exportConversations(userId: string, after: ExportCursor | null, limit: number): Promise<Array<ExportItem<ConversationRecord>>> {
    // Keyset on (updated_at DESC, id) over conversations_user_updated_idx. The timestamp goes back
    // and forth as text, so the cursor keeps PostgreSQL's full precision.
    const { rows } = await this.pool.query<ConversationRow & { updated_key: string }>(
      `SELECT *, updated_at::text AS updated_key FROM conversations
       WHERE user_id = $1 AND deleted_at IS NULL
         AND ($2::timestamptz IS NULL OR updated_at < $2::timestamptz OR (updated_at = $2::timestamptz AND id > $3))
       ORDER BY updated_at DESC, id LIMIT $4`,
      [userId, after?.key ?? null, after?.conversationId ?? "", limit],
    );
    return rows.map((r) => ({ item: this.toConversation(r), cursor: { conversationId: r.id, key: r.updated_key } }));
  }

  async deleteConversation(userId: string, id: string): Promise<boolean> {
    return this.tx(async (client) => {
      const res = await client.query(
        `UPDATE conversations SET deleted_at = now(), title = NULL, title_enc = NULL, title_key_id = NULL
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [id, userId],
      );
      if (res.rowCount !== 1) return false;
      await client.query("DELETE FROM messages WHERE conversation_id = $1", [id]);
      await client.query("DELETE FROM tool_invocations WHERE conversation_id = $1 AND user_id = $2", [id, userId]);
      await this.touch(client, id);
      return true;
    });
  }

  async listConversationChanges(userId: string, afterSeq: number, limit: number): Promise<ConversationChangePage> {
    // One snapshot for the conversations and their messages, so a page never mixes two moments in time.
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const page = await this.readChanges(client, userId, afterSeq, limit);
      await client.query("COMMIT");
      return page;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async readChanges(q: Queryable, userId: string, afterSeq: number, limit: number): Promise<ConversationChangePage> {
    const { rows } = await q.query<ConversationRow>(
      "SELECT * FROM conversations WHERE user_id = $1 AND sync_seq > $2 ORDER BY sync_seq LIMIT $3",
      [userId, afterSeq, limit + 1],
    );
    const page = rows.slice(0, limit);
    const ids = page.filter((r) => r.deleted_at === null).map((r) => r.id);
    const byConversation = new Map<string, MessageRecord[]>();
    const toolsByConversation = new Map<string, ToolInvocationRow[]>();
    if (ids.length > 0) {
      for (const t of await this.readTools(q, userId, ids)) {
        const list = toolsByConversation.get(t.conversationId) ?? [];
        list.push(t);
        toolsByConversation.set(t.conversationId, list);
      }
      const messages = await q.query<MessageRow>(
        "SELECT * FROM messages WHERE conversation_id = ANY($1) ORDER BY conversation_id, position",
        [ids],
      );
      for (const m of messages.rows) {
        const list = byConversation.get(m.conversation_id) ?? [];
        list.push(this.toMessage(m));
        byConversation.set(m.conversation_id, list);
      }
    }
    const changes: ConversationChange[] = page.map((r) => ({
      seq: Number(r.sync_seq),
      titleRev: r.title_rev,
      deleted: r.deleted_at !== null,
      conversation: this.toConversation(r),
      messages: byConversation.get(r.id) ?? [],
      tools: toolsByConversation.get(r.id) ?? [],
    }));
    return { changes, hasMore: rows.length > limit };
  }

  async pushConversation(userId: string, input: PushConversationInput): Promise<PushConversationResult> {
    const c = input.conversation;
    const skippedAll = (status: "deleted" | "rejected"): PushConversationResult => ({ status, appended: 0, skipped: input.messages.length });
    return this.tx(async (client) => {
      let row = await this.lockConversation(client, c.id);
      let created = false;
      if (!row) {
        const enc = this.cipher.encrypt(c.title, titleAad(c.id));
        const res = await client.query(
          `INSERT INTO conversations (id, user_id, title, title_enc, title_key_id, title_is_custom, mode, created_at, updated_at)
           VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
          [c.id, userId, enc.payload, enc.keyId, c.titleIsCustom, c.mode, c.createdAt, c.updatedAt],
        );
        created = res.rowCount === 1;
        // Lost a race with a concurrent create: lock whatever won and judge it like any existing row.
        row = await this.lockConversation(client, c.id);
      }
      if (!row || row.user_id !== userId) return skippedAll("rejected");
      if (row.deleted_at) return skippedAll("deleted");

      const ids = input.messages.map((m) => m.id);
      const known = new Set(
        (await client.query<{ id: string }>("SELECT id FROM messages WHERE conversation_id = $1 AND id = ANY($2)", [c.id, ids])).rows.map((r) => r.id),
      );
      const { rows: [newestRow] } = await client.query<{ newest: Date | null }>(
        "SELECT max(created_at) AS newest FROM messages WHERE conversation_id = $1",
        [c.id],
      );
      // Only the tail may grow: anything not newer than the newest stored message is ignored.
      const baseline = newestRow?.newest ? newestRow.newest.getTime() : Number.NEGATIVE_INFINITY;
      let appended = 0;
      let newest = 0;
      for (const m of input.messages) {
        const at = Date.parse(m.createdAt);
        if (known.has(m.id) || at <= baseline) continue;
        await client.query(
          `INSERT INTO messages (${MESSAGE_COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (conversation_id, id) DO NOTHING`,
          this.messageParams({ ...m, conversationId: c.id, attachmentIds: [] }),
        );
        known.add(m.id);
        newest = Math.max(newest, at);
        appended += 1;
      }
      if (appended > 0) {
        await client.query("UPDATE conversations SET updated_at = GREATEST(updated_at, $2) WHERE id = $1", [c.id, new Date(newest).toISOString()]);
      }
      if (created || appended > 0) await this.touch(client, c.id);
      return { status: created ? "created" : "merged", appended, skipped: input.messages.length - appended };
    });
  }

  async renameConversationIfCurrent(userId: string, id: string, title: string, baseTitleRev: number | null, now: string): Promise<RenameResult> {
    return this.tx(async (client) => {
      const row = await this.lockConversation(client, id);
      if (!row || row.user_id !== userId) return { status: "not_found" };
      if (row.deleted_at) return { status: "deleted" };
      const current = this.titleOf(row);
      if (current === title && row.title_is_custom) return { status: "applied" };
      if (row.title_is_custom && baseTitleRev !== row.title_rev) return { status: "conflict" };
      const enc = this.cipher.encrypt(title, titleAad(id));
      await client.query(
        `UPDATE conversations SET title = NULL, title_enc = $2, title_key_id = $3, title_is_custom = true, updated_at = $4,
           title_rev = title_rev + $5 WHERE id = $1`,
        [id, enc.payload, enc.keyId, now, current === title ? 0 : 1],
      );
      await this.touch(client, id);
      return { status: "applied" };
    });
  }

  async latestSyncSeq(userId: string): Promise<number> {
    const { rows } = await this.pool.query<{ sync_counter: string }>("SELECT sync_counter FROM users WHERE id = $1", [userId]);
    return rows[0] ? Number(rows[0].sync_counter) : 0;
  }

  async exportMessages(userId: string, conversationIds: string[], after: ExportCursor | null, limit: number): Promise<Array<ExportItem<MessageRecord>>> {
    if (conversationIds.length === 0) return [];
    // Keyset on (conversation_id, position). Each conversation is read through
    // messages_conversation_position_idx in order and stops at `limit`, so one page reads at most
    // `limit` rows per conversation however long the conversations are (a plain ANY(...) ORDER BY
    // reads and sorts every message of the page's conversations on every page).
    const { rows } = await this.pool.query<MessageRow & { position: string }>(
      `SELECT m.* FROM unnest($1::text[]) AS k(cid)
       JOIN conversations c ON c.id = k.cid AND c.user_id = $2 AND c.deleted_at IS NULL
       CROSS JOIN LATERAL (
         SELECT * FROM messages m
         WHERE m.conversation_id = k.cid AND ($3::text IS NULL OR (m.conversation_id, m.position) > ($3::text, $4::bigint))
         ORDER BY m.position LIMIT $5) m
       WHERE $3::text IS NULL OR k.cid >= $3::text
       ORDER BY m.conversation_id, m.position LIMIT $5`,
      [conversationIds, userId, after?.conversationId ?? null, after?.key ?? "0", limit],
    );
    return rows.map((r) => ({ item: this.toMessage(r), cursor: { conversationId: r.conversation_id, key: String(r.position) } }));
  }

  async listMessages(conversationId: string): Promise<MessageRecord[]> {
    const { rows } = await this.pool.query<MessageRow>(
      `SELECT m.* FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE m.conversation_id = $1 AND c.deleted_at IS NULL ORDER BY m.position`,
      [conversationId],
    );
    return rows.map((r) => this.toMessage(r));
  }

  async saveMessage(m: MessageRecord): Promise<void> {
    await this.tx(async (client) => {
      const res = await client.query(
        `INSERT INTO messages (${MESSAGE_COLUMNS})
         SELECT $1::text,$2::text,$3::text,$4::bytea,$5::text,$6::text,$7::text,$8::boolean,$9::text,$10::text,$11::text[],$12::timestamptz
         WHERE EXISTS (SELECT 1 FROM conversations WHERE id = $1 AND deleted_at IS NULL)
         ON CONFLICT (conversation_id, id) DO UPDATE SET role = EXCLUDED.role, content = NULL,
           content_enc = EXCLUDED.content_enc, content_key_id = EXCLUDED.content_key_id,
           origin = EXCLUDED.origin, model = EXCLUDED.model, demo = EXCLUDED.demo, status = EXCLUDED.status,
           compare_group_id = EXCLUDED.compare_group_id, attachment_ids = EXCLUDED.attachment_ids,
           created_at = EXCLUDED.created_at`,
        this.messageParams(m),
      );
      if (res.rowCount === 1) await this.touch(client, m.conversationId);
    });
  }

  async truncateMessagesFrom(conversationId: string, messageId: string): Promise<void> {
    await this.tx(async (client) => {
      const res = await client.query(
        `DELETE FROM messages WHERE conversation_id = $1
         AND position >= (SELECT position FROM messages WHERE conversation_id = $1 AND id = $2)`,
        [conversationId, messageId],
      );
      if ((res.rowCount ?? 0) > 0) await this.touch(client, conversationId);
    });
  }

  // ---- encryption maintenance (backfill and key rotation) -----------------------------------------

  /**
   * Encrypts up to `limit` legacy plaintext titles and messages (rows written before migration 4) and
   * re-encrypts up to `limit` rows of each kind still under a retired key. Returns how many rows changed;
   * call until it returns 0. Safe to run while the server is serving traffic (row locks, SKIP LOCKED).
   */
  async encryptionMaintenanceBatch(limit = 200): Promise<{ titles: number; messages: number; documents: number; automations: number }> {
    const current = this.cipher.keyId;
    // Rows under a key this server does not hold are left alone (reading them fails clearly instead).
    const retired = this.cipher.keyIds.filter((k) => k !== current);
    return this.tx(async (client) => {
      // Tombstones keep no title at all.
      await client.query("UPDATE conversations SET title = NULL WHERE deleted_at IS NOT NULL AND title IS NOT NULL");
      const convs = await client.query<ConversationRow>(
        `SELECT * FROM conversations WHERE deleted_at IS NULL AND (title IS NOT NULL OR title_key_id = ANY($1))
         ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED`,
        [retired, limit],
      );
      for (const r of convs.rows) {
        const enc = this.cipher.encrypt(this.titleOf(r), titleAad(r.id));
        await client.query("UPDATE conversations SET title = NULL, title_enc = $2, title_key_id = $3 WHERE id = $1", [r.id, enc.payload, enc.keyId]);
      }
      const msgs = await client.query<MessageRow>(
        `SELECT * FROM messages WHERE content IS NOT NULL OR content_key_id = ANY($1)
         ORDER BY conversation_id, id LIMIT $2 FOR UPDATE SKIP LOCKED`,
        [retired, limit],
      );
      for (const r of msgs.rows) {
        const enc = this.cipher.encrypt(this.toMessage(r).content, contentAad(r.conversation_id, r.id));
        await client.query(
          "UPDATE messages SET content = NULL, content_enc = $3, content_key_id = $4 WHERE conversation_id = $1 AND id = $2",
          [r.conversation_id, r.id, enc.payload, enc.keyId],
        );
      }
      const docs = await client.query<{ id: string; user_id: string; extracted_text_enc: Buffer; enc_key_id: string }>(
        "SELECT id, user_id, extracted_text_enc, enc_key_id FROM documents WHERE enc_key_id = ANY($1) ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED",
        [retired, limit],
      );
      for (const d of docs.rows) {
        const text = this.cipher.decrypt({ keyId: d.enc_key_id, payload: d.extracted_text_enc }, documentAad(d.user_id, d.id));
        const enc = this.cipher.encrypt(text, documentAad(d.user_id, d.id));
        await client.query("UPDATE documents SET extracted_text_enc = $2, enc_key_id = $3 WHERE id = $1", [d.id, enc.payload, enc.keyId]);
      }
      const autos = await client.query<AutomationRow>(
        "SELECT * FROM automations WHERE enc_key_id = ANY($1) ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED",
        [retired, limit],
      );
      for (const r of autos.rows) {
        const a = this.toAutomation(r);
        const name = this.cipher.encrypt(a.name, automationNameAad(a.id));
        const prompt = this.cipher.encrypt(a.prompt, automationPromptAad(a.id));
        await client.query("UPDATE automations SET name_enc = $2, prompt_enc = $3, enc_key_id = $4 WHERE id = $1", [a.id, name.payload, prompt.payload, name.keyId]);
      }
      const runs = await client.query<RunRow>(
        `SELECT ${RUN_COLUMNS} FROM automation_runs WHERE content_key_id = ANY($1) ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED`,
        [retired, limit],
      );
      for (const r of runs.rows) {
        const enc = this.cipher.encrypt(this.toRun(r).content, runContentAad(r.automation_id, r.id));
        await client.query("UPDATE automation_runs SET content_enc = $2, content_key_id = $3 WHERE id = $1", [r.id, enc.payload, enc.keyId]);
      }
      const devices = await client.query<PushDeviceRow>(
        `SELECT ${PUSH_DEVICE_COLUMNS} FROM push_devices WHERE token_key_id = ANY($1) ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED`,
        [retired, limit],
      );
      for (const r of devices.rows) {
        const enc = this.cipher.encrypt(this.toPushDevice(r).token, pushTokenAad(r.id));
        await client.query("UPDATE push_devices SET token_enc = $2, token_key_id = $3 WHERE id = $1", [r.id, enc.payload, enc.keyId]);
      }
      return {
        titles: convs.rowCount ?? 0,
        messages: msgs.rowCount ?? 0,
        documents: docs.rowCount ?? 0,
        // Automates data, including the push tokens its notifications are delivered with.
        automations: (autos.rowCount ?? 0) + (runs.rowCount ?? 0) + (devices.rowCount ?? 0),
      };
    });
  }

  /** Rows still holding plaintext content, or ciphertext under a retired key. */
  async encryptionStatus(): Promise<{ plaintextTitles: number; plaintextMessages: number; retiredKeyRows: number }> {
    const current = this.cipher.keyId;
    const { rows } = await this.pool.query<{ t: string; m: string; r: string }>(
      `SELECT
         (SELECT count(*) FROM conversations WHERE title IS NOT NULL) AS t,
         (SELECT count(*) FROM messages WHERE content IS NOT NULL) AS m,
         (SELECT count(*) FROM conversations WHERE title_key_id IS NOT NULL AND title_key_id <> $1)
         + (SELECT count(*) FROM messages WHERE content_key_id IS NOT NULL AND content_key_id <> $1)
         + (SELECT count(*) FROM documents WHERE enc_key_id <> $1)
         + (SELECT count(*) FROM automations WHERE enc_key_id <> $1)
         + (SELECT count(*) FROM automation_runs WHERE content_key_id IS NOT NULL AND content_key_id <> $1)
         + (SELECT count(*) FROM push_devices WHERE token_key_id <> $1) AS r`,
      [current],
    );
    return { plaintextTitles: Number(rows[0]!.t), plaintextMessages: Number(rows[0]!.m), retiredKeyRows: Number(rows[0]!.r) };
  }

  // ---- documents (text encrypted at rest) ------------------------------------------------------

  async saveDocument(d: DocumentRecord): Promise<void> {
    const enc = this.cipher.encrypt(d.extractedText, documentAad(d.userId, d.id));
    await this.pool.query(
      `INSERT INTO documents (id, user_id, name, kind, mime_type, size_bytes, status, status_detail, extracted_chars,
         extracted_text_enc, enc_key_id, page_count, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind, mime_type = EXCLUDED.mime_type,
         size_bytes = EXCLUDED.size_bytes, status = EXCLUDED.status, status_detail = EXCLUDED.status_detail,
         extracted_chars = EXCLUDED.extracted_chars, extracted_text_enc = EXCLUDED.extracted_text_enc,
         enc_key_id = EXCLUDED.enc_key_id, page_count = EXCLUDED.page_count
       WHERE documents.user_id = EXCLUDED.user_id`,
      [d.id, d.userId, d.name, d.kind, d.mimeType, d.sizeBytes, d.status, d.statusDetail, d.extractedText.length,
        enc.payload, enc.keyId, d.pageCount, d.createdAt],
    );
  }

  async addDocument(d: DocumentRecord, maxPerAccount: number): Promise<"ok" | "limit" | "gone"> {
    const enc = this.cipher.encrypt(d.extractedText, documentAad(d.userId, d.id));
    return this.tx(async (client) => {
      // The account row lock serializes this account's uploads, so the count cannot be raced.
      const user = await client.query("SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE", [d.userId]);
      if (user.rowCount === 0) return "gone";
      const { rows } = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM documents WHERE user_id = $1", [d.userId]);
      if (rows[0]!.n >= maxPerAccount) return "limit";
      await client.query(
        `INSERT INTO documents (id, user_id, name, kind, mime_type, size_bytes, status, status_detail, extracted_chars,
           extracted_text_enc, enc_key_id, page_count, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [d.id, d.userId, d.name, d.kind, d.mimeType, d.sizeBytes, d.status, d.statusDetail, d.extractedText.length,
          enc.payload, enc.keyId, d.pageCount, d.createdAt],
      );
      return "ok";
    });
  }

  async getDocument(userId: string, id: string): Promise<DocumentRecord | undefined> {
    const { rows } = await this.pool.query<DocumentRow & { extracted_text_enc: Buffer; enc_key_id: string }>(
      "SELECT * FROM documents WHERE id = $1 AND user_id = $2",
      [id, userId],
    );
    const r = rows[0];
    if (!r) return undefined;
    const { extractedChars: _chars, ...meta } = toSummary(r);
    const extractedText = this.cipher.decrypt({ keyId: r.enc_key_id, payload: r.extracted_text_enc }, documentAad(userId, id));
    return { ...meta, extractedText };
  }

  async listDocuments(userId: string): Promise<DocumentSummary[]> {
    const { rows } = await this.pool.query<DocumentRow>(
      `SELECT id, user_id, name, kind, mime_type, size_bytes, status, status_detail, extracted_chars, page_count, created_at
       FROM documents WHERE user_id = $1 ORDER BY created_at DESC, id`,
      [userId],
    );
    return rows.map(toSummary);
  }

  async deleteDocument(userId: string, id: string): Promise<boolean> {
    const res = await this.pool.query("DELETE FROM documents WHERE id = $1 AND user_id = $2", [id, userId]);
    return res.rowCount === 1;
  }

  // ---- plugins and tool audit ------------------------------------------------------------------

  async getPluginSettings(userId: string): Promise<PluginSettingRecord[]> {
    const { rows } = await this.pool.query<{ plugin_id: string; enabled: boolean; granted_scopes: string[]; updated_at: Date }>(
      "SELECT * FROM plugin_settings WHERE user_id = $1 ORDER BY plugin_id",
      [userId],
    );
    return rows.map((r) => ({ pluginId: r.plugin_id, enabled: r.enabled, grantedScopes: r.granted_scopes, updatedAt: iso(r.updated_at) }));
  }

  async savePluginSetting(userId: string, s: PluginSettingRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO plugin_settings (user_id, plugin_id, enabled, granted_scopes, updated_at) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id, plugin_id) DO UPDATE SET enabled = EXCLUDED.enabled,
         granted_scopes = EXCLUDED.granted_scopes, updated_at = EXCLUDED.updated_at`,
      [userId, s.pluginId, s.enabled, s.grantedScopes, s.updatedAt],
    );
  }

  async recordToolInvocation(t: ToolInvocationRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO tool_invocations (user_id, conversation_id, message_id, call_id, provider, plugin_id, tool_name, status,
         duration_ms, arg_bytes, result_chars, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [t.userId, t.conversationId, t.messageId, t.callId, t.provider, t.plugin, t.tool, t.status, t.durationMs, t.argBytes, t.resultChars, t.createdAt],
    );
  }

  async claimToolExecution(claim: { keyHash: string; userId: string; createdAt: string }): Promise<boolean> {
    const res = await this.pool.query(
      "INSERT INTO tool_executions (key_hash, user_id, status, created_at) VALUES ($1,$2,'started',$3) ON CONFLICT (key_hash) DO NOTHING",
      [claim.keyHash, claim.userId, claim.createdAt],
    );
    return res.rowCount === 1;
  }

  async finishToolExecution(keyHash: string, status: string, finishedAt: string): Promise<void> {
    await this.pool.query("UPDATE tool_executions SET status = $2, finished_at = $3 WHERE key_hash = $1", [keyHash, status, finishedAt]);
  }

  async listToolInvocations(userId: string, limit: number): Promise<ToolInvocationRow[]> {
    const { rows } = await this.pool.query<ToolInvocationDbRow>(
      "SELECT * FROM tool_invocations WHERE user_id = $1 ORDER BY id DESC LIMIT $2",
      [userId, limit],
    );
    return rows.map(toToolInvocation);
  }

  async exportToolInvocations(userId: string, conversationIds: string[], after: ExportCursor | null, limit: number): Promise<Array<ExportItem<ToolInvocationRow>>> {
    if (conversationIds.length === 0) return [];
    // Same rows as readTools, keyset on (conversation_id, id), read per conversation through
    // tool_invocations_conversation_idx like exportMessages.
    const { rows } = await this.pool.query<ToolInvocationDbRow & { id: string }>(
      `SELECT t.* FROM unnest($2::text[]) AS k(cid)
       CROSS JOIN LATERAL (
         SELECT * FROM tool_invocations t
         WHERE t.conversation_id = k.cid AND t.user_id = $1
           AND EXISTS (SELECT 1 FROM messages m WHERE m.id = t.message_id AND m.conversation_id = t.conversation_id)
           AND ($3::text IS NULL OR (t.conversation_id, t.id) > ($3::text, $4::bigint))
         ORDER BY t.id LIMIT $5) t
       WHERE $3::text IS NULL OR k.cid >= $3::text
       ORDER BY t.conversation_id, t.id LIMIT $5`,
      [userId, conversationIds, after?.conversationId ?? null, after?.key ?? "0", limit],
    );
    return rows.map((r) => ({ item: toToolInvocation(r), cursor: { conversationId: r.conversation_id, key: String(r.id) } }));
  }

  async listConversationToolInvocations(userId: string, conversationId: string): Promise<ToolInvocationRow[]> {
    return this.readTools(this.pool, userId, [conversationId]);
  }

  /** Tool calls of these conversations whose message still exists, oldest first. */
  private async readTools(q: Queryable, userId: string, conversationIds: string[]): Promise<ToolInvocationRow[]> {
    const { rows } = await q.query<ToolInvocationDbRow>(
      `SELECT t.* FROM tool_invocations t
       WHERE t.user_id = $1 AND t.conversation_id = ANY($2)
         AND EXISTS (SELECT 1 FROM messages m WHERE m.id = t.message_id AND m.conversation_id = t.conversation_id)
       ORDER BY t.conversation_id, t.id`,
      [userId, conversationIds],
    );
    return rows.map(toToolInvocation);
  }

  // ---- usage -----------------------------------------------------------------------------------

  async recordUsage(u: UsageRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO usage_records (user_id, conversation_id, message_id, provider, model, demo, input_tokens, output_tokens, estimated_cost_usd, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [u.userId, u.conversationId, u.messageId, u.provider, u.model, u.demo, u.inputTokens, u.outputTokens, u.estimatedCostUsd ?? null, u.createdAt],
    );
  }

  async usageSummary(userId: string, recent: number) {
    const [totals, latest] = await Promise.all([
      this.pool.query<{ provider: string; requests: string; input_tokens: string | null; output_tokens: string | null }>(
        `SELECT provider, count(*) AS requests, sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens
         FROM usage_records WHERE user_id = $1 GROUP BY provider ORDER BY min(id)`,
        [userId],
      ),
      this.pool.query<{
        user_id: string; conversation_id: string; message_id: string; provider: string; model: string; demo: boolean;
        input_tokens: string | null; output_tokens: string | null; estimated_cost_usd: number | null; created_at: Date;
      }>("SELECT * FROM usage_records WHERE user_id = $1 ORDER BY id DESC LIMIT $2", [userId, recent]),
    ]);
    return {
      totals: totals.rows.map((t) => ({ provider: t.provider as ProviderId, requests: Number(t.requests), inputTokens: Number(t.input_tokens ?? 0), outputTokens: Number(t.output_tokens ?? 0) })),
      recent: latest.rows.map((r) => ({
        userId: r.user_id, conversationId: r.conversation_id, messageId: r.message_id, provider: r.provider as ProviderId,
        model: r.model, demo: r.demo, inputTokens: num(r.input_tokens), outputTokens: num(r.output_tokens),
        estimatedCostUsd: r.estimated_cost_usd, createdAt: iso(r.created_at),
      })),
    };
  }

  async listUsage(userId: string): Promise<UsageRow[]> {
    const { rows } = await this.pool.query<UsageDbRow>("SELECT * FROM usage_records WHERE user_id = $1 ORDER BY id", [userId]);
    return rows.map(toUsageRow);
  }

  async exportUsage(userId: string, after: ExportCursor | null, limit: number): Promise<Array<ExportItem<UsageRow>>> {
    // Keyset on id over usage_user_idx (user_id, id).
    const { rows } = await this.pool.query<UsageDbRow & { id: string }>(
      "SELECT * FROM usage_records WHERE user_id = $1 AND ($2::bigint IS NULL OR id > $2::bigint) ORDER BY id LIMIT $3",
      [userId, after?.key ?? null, limit],
    );
    return rows.map((r) => ({ item: toUsageRow(r), cursor: { key: String(r.id) } }));
  }
  async recordInferenceAttempt(a: InferenceAttemptRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO inference_attempts (id, inference_id, user_id, plan, task, mode, provider, model, pricing, created_at, latency_ms,
         outcome, error_code, http_status, retry, round, fallback_index, input_tokens, output_tokens, cached_input_tokens,
         estimated_input_tokens, estimated_output_tokens, token_source, estimated_cost_usd, provider_cost_usd, currency, route,
         configured_model)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)`,
      [
        a.id, a.inferenceId, a.userId, a.plan, a.task, a.mode, a.provider, a.model, a.pricing, a.createdAt, a.latencyMs,
        a.outcome, a.errorCode, a.httpStatus, a.retry, a.round, a.fallbackIndex, a.inputTokens, a.outputTokens, a.cachedInputTokens,
        a.estimatedInputTokens, a.estimatedOutputTokens, a.tokenSource, a.estimatedCostUsd, a.providerCostUsd, a.currency, JSON.stringify(a.route),
        a.configuredModel,
      ],
    );
  }

  async listInferenceAttempts(inferenceId: string): Promise<InferenceAttemptRow[]> {
    const { rows } = await this.pool.query<{
      id: string; inference_id: string; user_id: string | null; plan: string; task: string; mode: string | null; provider: string;
      model: string; pricing: InferenceAttemptRow["pricing"]; created_at: Date; latency_ms: number; outcome: InferenceAttemptRow["outcome"];
      error_code: string | null; http_status: number | null; retry: number; round: number; fallback_index: number;
      input_tokens: string | null; output_tokens: string | null; cached_input_tokens: string | null; estimated_input_tokens: string;
      estimated_output_tokens: string; token_source: InferenceAttemptRow["tokenSource"]; estimated_cost_usd: number | null;
      provider_cost_usd: number | null; currency: "USD"; route: Record<string, unknown>; configured_model: string | null;
    }>("SELECT * FROM inference_attempts WHERE inference_id = $1 ORDER BY created_at, id", [inferenceId]);
    return rows.map((r) => ({
      id: r.id, inferenceId: r.inference_id, userId: r.user_id, plan: r.plan, task: r.task, mode: r.mode, provider: r.provider as ProviderId,
      model: r.model, configuredModel: r.configured_model, pricing: r.pricing, createdAt: iso(r.created_at), latencyMs: r.latency_ms, outcome: r.outcome, errorCode: r.error_code,
      httpStatus: r.http_status, retry: r.retry, round: r.round, fallbackIndex: r.fallback_index, inputTokens: num(r.input_tokens),
      outputTokens: num(r.output_tokens), cachedInputTokens: num(r.cached_input_tokens), estimatedInputTokens: Number(r.estimated_input_tokens),
      estimatedOutputTokens: Number(r.estimated_output_tokens), tokenSource: r.token_source, estimatedCostUsd: r.estimated_cost_usd,
      providerCostUsd: r.provider_cost_usd, currency: r.currency, route: r.route,
    }));
  }

  async sumInferenceSpend(q: InferenceSpendQuery): Promise<InferenceSpend> {
    const where = ["created_at >= $1"];
    const params: unknown[] = [q.since];
    if (q.userId !== undefined) where.push(`user_id = $${params.push(q.userId)}`);
    if (q.plan !== undefined) where.push(`plan = $${params.push(q.plan)}`);
    if (q.provider !== undefined) where.push(`provider = $${params.push(q.provider)}`);
    if (q.pricing !== undefined) where.push(`pricing = ANY($${params.push([...q.pricing])})`);
    const { rows } = await this.pool.query<{ attempts: string; cost: number | null; tokens: string | null }>(
      `SELECT count(*) AS attempts,
              sum(COALESCE(provider_cost_usd, estimated_cost_usd, 0)) AS cost,
              sum(COALESCE(input_tokens, estimated_input_tokens) + COALESCE(output_tokens, estimated_output_tokens)) AS tokens
         FROM inference_attempts WHERE ${where.join(" AND ")}`,
      params,
    );
    const r = rows[0]!;
    return { attempts: Number(r.attempts), costUsd: Number(r.cost ?? 0), tokens: Number(r.tokens ?? 0) };
  }

  // ---- spend reservations ------------------------------------------------------------------------

  async spendUsage(limits: readonly SpendLimit[]): Promise<SpendUsage[]> {
    if (limits.length === 0) return [];
    const params: unknown[] = [];
    const { rows } = await this.pool.query<SpendUsageRow>(`WITH ${spendUsageCtes(limits, params)} SELECT * FROM usage ORDER BY ord`, params);
    return rows.map(toSpendUsage);
  }

  /**
   * One READ COMMITTED transaction: the advisory lock of every scope with a limit (deduplicated, taken
   * in one total order so admissions never deadlock each other), then ONE statement that reads every
   * scope's actual and outstanding spend from a single snapshot and inserts the hold only if all fit.
   * The snapshot is taken after the locks, so it sees every hold committed by earlier lock holders.
   * Ledger writes and settlements need no lock: they only move cost from outstanding to actual, or
   * drop a hold, so they can never make an admitted state exceed a limit.
   */
  async reserveSpend(input: ReserveSpendInput): Promise<ReserveSpendResult> {
    return this.spendTx(async (client) => {
      await lockSpendScopes(client, input.limits);
      const params: unknown[] = [];
      const amount = (v: string) => `$${params.push(v)}`;
      const usage = input.limits.length > 0 ? spendUsageCtes(input.limits, params) : null;
      const amt = amount(holdAmount(input.amountUsd));
      const values = [input.id, input.inferenceId, input.userId, input.plan, input.task, input.provider, input.model].map((v) => `$${params.push(v)}`);
      const lease = `$${params.push(Math.max(1, Math.round(input.leaseMs)))}`;
      const fits = usage ? `(SELECT COALESCE(bool_and(actual_usd + reserved_usd + ${amt}::numeric <= limit_usd), true) FROM usage)` : "true";
      const { rows } = await client.query<{ usage: SpendUsageRow[] | null; reservation: SpendReservationRow | null }>(
        `WITH ${usage ? `${usage},` : ""}
         ins AS (
           INSERT INTO spend_reservations (id, inference_id, user_id, plan, task, provider, model, reserved_usd, status, created_at, expires_at)
           SELECT ${values.join(", ")}, ${amt}::numeric, 'active', statement_timestamp(),
                  statement_timestamp() + ${lease}::double precision * interval '1 millisecond'
            WHERE ${fits}
           RETURNING *)
         SELECT ${usage ? "(SELECT json_agg(u ORDER BY u.ord) FROM usage u)" : "NULL::json"} AS usage,
                (SELECT row_to_json(ins) FROM ins) AS reservation`,
        params,
      );
      const row = rows[0]!;
      const used = (row.usage ?? []).map(toSpendUsage);
      if (row.reservation) return { ok: true as const, reservation: toSpendReservation(row.reservation), usage: used };
      const amountUsd = Number(holdAmount(input.amountUsd));
      const blocked = used.find((u) => Math.round((u.actualUsd + u.reservedUsd + amountUsd) * 1e10) > Math.round(u.limitUsd * 1e10)) ?? used[0]!;
      return { ok: false as const, blockedBy: blocked.scope, usage: used };
    });
  }

  /**
   * One READ COMMITTED transaction (ADR 0016). First the hold's own row is locked (every extension of one
   * request is serialized there), then read with what the request has already
   * spent (its paid ledger rows) and what is still in flight (attempts registered on this hold with no
   * ledger row yet). A repeated attempt changes nothing. If the hold already covers the attempt it is only
   * registered; otherwise the scope locks are taken in admission's order and ONE statement checks every
   * limit on one snapshot and grows the hold only if the increase fits. Lock order is always the
   * reservation row, then scopes; admission never locks an existing reservation row, settlement takes
   * only the row, so there is no cycle.
   */
  async extendSpendReservation(input: ExtendSpendInput): Promise<ExtendSpendResult> {
    const { fallbackIndex, round, retry, provider, model } = input.attempt;
    return this.spendTx(async (client) => {
      // Lock first, then read in a NEW statement: under READ COMMITTED a statement that waited for a row
      // lock still reads everything else from the snapshot it started with, so a single locking read would
      // miss the attempt and ledger rows the previous lock holder just committed.
      await client.query("SELECT id FROM spend_reservations WHERE id = $1 FOR UPDATE", [input.reservationId]);
      const { rows } = await client.query<SpendReservationRow & { recorded_usd: string; inflight_usd: string; duplicate: boolean; live: boolean }>(
        `SELECT r.*,
                COALESCE((SELECT sum(${LEDGER_COST}) FROM inference_attempts a WHERE a.inference_id = r.inference_id AND a.pricing = 'paid'), 0) AS recorded_usd,
                COALESCE((SELECT sum(x.attempt_usd) FROM spend_reservation_attempts x
                           WHERE x.reservation_id = r.id
                             AND NOT EXISTS (SELECT 1 FROM inference_attempts a
                                              WHERE a.inference_id = r.inference_id AND a.fallback_index = x.fallback_index
                                                AND a.round = x.round AND a.retry = x.retry)), 0) AS inflight_usd,
                EXISTS (SELECT 1 FROM spend_reservation_attempts x
                         WHERE x.reservation_id = r.id AND x.fallback_index = $2 AND x.round = $3 AND x.retry = $4) AS duplicate,
                r.expires_at > statement_timestamp() AS live
           FROM spend_reservations r WHERE r.id = $1`,
        [input.reservationId, fallbackIndex, round, retry],
      );
      const row = rows[0];
      if (!row || row.status !== "active" || !row.live) return { ok: false as const, reason: "inactive" as const };
      if (row.duplicate) return { ok: true as const, reservation: toSpendReservation(row), extendedUsd: 0, duplicate: true, usage: [] };
      const attemptUsd = holdAmount(input.attemptUsd);
      // The caller's own earlier attempts or the ledger (whichever is more), plus attempts other code paths
      // registered that are still in flight (no ledger row yet), plus this one.
      const target = Math.max(input.priorUsd, Number(row.recorded_usd)) + Number(row.inflight_usd) + Number(attemptUsd);
      const increase = holdAmount(target - Number(row.reserved_usd));
      const register = (extended: string, from: string) =>
        `INSERT INTO spend_reservation_attempts (reservation_id, fallback_index, round, retry, provider, model, attempt_usd, extended_usd, created_at)
         SELECT $1, $2, $3, $4, $5, $6, $7::numeric, ${extended}::numeric, statement_timestamp()${from}`;
      const base = [input.reservationId, fallbackIndex, round, retry, provider, model, attemptUsd];
      if (Number(increase) <= 0) {
        // Already covered: the hold does not grow, so no limit can be passed and no scope lock is needed.
        await client.query(register("0", ""), base);
        return { ok: true as const, reservation: toSpendReservation(row), extendedUsd: 0, duplicate: false, usage: [] };
      }
      await lockSpendScopes(client, input.limits);
      const params: unknown[] = [...base];
      const usage = input.limits.length > 0 ? spendUsageCtes(input.limits, params) : null;
      const inc = `$${params.push(increase)}`;
      const fits = usage ? `(SELECT COALESCE(bool_and(actual_usd + reserved_usd + ${inc}::numeric <= limit_usd), true) FROM usage)` : "true";
      const result = await client.query<{ usage: SpendUsageRow[] | null; reservation: SpendReservationRow | null }>(
        `WITH ${usage ? `${usage},` : ""}
         grown AS (
           UPDATE spend_reservations SET reserved_usd = reserved_usd + ${inc}::numeric
            WHERE id = $1 AND status = 'active' AND expires_at > statement_timestamp() AND ${fits}
           RETURNING *),
         registered AS (${register(inc, " FROM grown")} RETURNING 1)
         SELECT ${usage ? "(SELECT json_agg(u ORDER BY u.ord) FROM usage u)" : "NULL::json"} AS usage,
                (SELECT row_to_json(grown) FROM grown) AS reservation,
                (SELECT count(*) FROM registered) AS registered`,
        params,
      );
      const out = result.rows[0]!;
      const used = (out.usage ?? []).map(toSpendUsage);
      const increaseUsd = Number(increase);
      if (out.reservation) {
        // The usage snapshot was read before the hold grew: report it with the increase held.
        const after = used.map((u) => ({ ...u, reservedUsd: round10(u.reservedUsd + increaseUsd), availableUsd: round10(u.availableUsd - increaseUsd) }));
        return { ok: true as const, reservation: toSpendReservation(out.reservation), extendedUsd: increaseUsd, duplicate: false, usage: after };
      }
      const blocked = used.find((u) => Math.round((u.actualUsd + u.reservedUsd + increaseUsd) * 1e10) > Math.round(u.limitUsd * 1e10)) ?? used[0];
      if (!blocked) return { ok: false as const, reason: "inactive" as const };
      return { ok: false as const, reason: "limit" as const, blockedBy: blocked.scope, usage: used };
    });
  }

  /** A spend transaction: deadlocks and serialization failures are retried (defensive); a lock timeout is not. */
  private async spendTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.tx(async (client) => {
          await client.query(`SET LOCAL lock_timeout = '${SPEND_LOCK_TIMEOUT}'`);
          return fn(client);
        });
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (attempt < SPEND_TX_ATTEMPTS && code && RETRYABLE_TX.has(code)) {
          await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 20 * attempt));
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Records the request's paid ledger cost as the hold's actual and ends it: settled (> 0), released
   * (0), or expired when its lease had already run out (a late settlement). Only an active hold, or an
   * expired one not yet given its actual, changes; anything else is returned as already finished.
   */
  async settleSpendReservation(id: string): Promise<SettleSpendResult | undefined> {
    const { rows } = await this.pool.query<SpendReservationRow>(
      `WITH spent AS (
         SELECT COALESCE(sum(${LEDGER_COST}), 0) AS usd FROM inference_attempts
          WHERE pricing = 'paid' AND inference_id = (SELECT inference_id FROM spend_reservations WHERE id = $1))
       UPDATE spend_reservations r
          SET actual_usd = spent.usd,
              finished_at = COALESCE(r.finished_at, statement_timestamp()),
              status = CASE WHEN r.status = 'expired' OR r.expires_at <= statement_timestamp() THEN 'expired'
                            WHEN spent.usd > 0 THEN 'settled' ELSE 'released' END
         FROM spent
        WHERE r.id = $1 AND (r.status = 'active' OR (r.status = 'expired' AND r.actual_usd IS NULL))
       RETURNING r.*`,
      [id],
    );
    if (rows[0]) return { reservation: toSpendReservation(rows[0]), alreadyFinished: false };
    const existing = await this.getSpendReservation(id);
    return existing && { reservation: existing, alreadyFinished: true };
  }

  async getSpendReservation(id: string): Promise<SpendReservationRecord | undefined> {
    const { rows } = await this.pool.query<SpendReservationRow>("SELECT * FROM spend_reservations WHERE id = $1", [id]);
    return rows[0] && toSpendReservation(rows[0]);
  }

  async sweepSpendReservations(limit: number, retentionMs: number): Promise<{ expired: number; purged: number }> {
    const expired = await this.pool.query(
      `UPDATE spend_reservations SET status = 'expired', finished_at = statement_timestamp()
        WHERE id IN (SELECT id FROM spend_reservations WHERE status = 'active' AND expires_at <= statement_timestamp()
                      ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED)
          AND status = 'active'`,
      [limit],
    );
    const purged = await this.pool.query(
      `DELETE FROM spend_reservations
        WHERE id IN (SELECT id FROM spend_reservations
                      WHERE status <> 'active' AND finished_at < statement_timestamp() - $2::double precision * interval '1 millisecond'
                      ORDER BY finished_at LIMIT $1 FOR UPDATE SKIP LOCKED)`,
      [limit, Math.max(0, Math.round(retentionMs))],
    );
    return { expired: expired.rowCount ?? 0, purged: purged.rowCount ?? 0 };
  }

}

interface UsageDbRow {
  user_id: string; conversation_id: string; message_id: string; provider: string; model: string; demo: boolean;
  input_tokens: string | null; output_tokens: string | null; estimated_cost_usd: number | null; created_at: Date;
}

const toUsageRow = (r: UsageDbRow): UsageRow => ({
  userId: r.user_id, conversationId: r.conversation_id, messageId: r.message_id, provider: r.provider as ProviderId,
  model: r.model, demo: r.demo, inputTokens: num(r.input_tokens), outputTokens: num(r.output_tokens),
  estimatedCostUsd: r.estimated_cost_usd, createdAt: iso(r.created_at),
});

interface ToolInvocationDbRow {
  user_id: string; conversation_id: string; message_id: string; call_id: string; provider: string; plugin_id: string;
  tool_name: string; status: string; duration_ms: number; arg_bytes: number; result_chars: number; created_at: Date;
}

const toToolInvocation = (r: ToolInvocationDbRow): ToolInvocationRow => ({
  userId: r.user_id, conversationId: r.conversation_id, messageId: r.message_id, callId: r.call_id,
  provider: r.provider as ProviderId, plugin: r.plugin_id, tool: r.tool_name, status: r.status as ToolInvocationRow["status"],
  durationMs: r.duration_ms, argBytes: r.arg_bytes, resultChars: r.result_chars, createdAt: iso(r.created_at),
});
