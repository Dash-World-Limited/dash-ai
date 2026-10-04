import pg from "pg";
import type { AssistantMode, DocumentKind, DocumentStatus, MessageRole, MessageStatus, ProviderId } from "@dash-ai/contracts";
import type { PluginSettingRecord, ToolInvocationRow } from "../tools/types.js";
import type { DataCipher } from "../security/dataCrypto.js";
import { assertMigrated, migrate } from "./migrate.js";
import {
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
  type UserRecord,
} from "./store.js";

export interface PostgresOptions {
  connectionString: string;
  cipher: DataCipher;
  ssl?: "disable" | "require" | "no-verify";
  poolMax?: number;
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
      connectionTimeoutMillis: 10_000,
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
    // Development convenience: finish any plaintext backfill / key rotation right away. Production runs
    // it deliberately (pnpm --filter @dash-ai/api data:encrypt) and only gets a start-up report.
    if (options.autoMigrate ?? true) await store.runEncryptionMaintenance();
    return store;
  }

  /** Repeats encryptionMaintenanceBatch until nothing is left. Returns the totals changed. */
  async runEncryptionMaintenance(batch = 200): Promise<{ titles: number; messages: number; documents: number }> {
    const total = { titles: 0, messages: 0, documents: 0 };
    for (;;) {
      const n = await this.encryptionMaintenanceBatch(batch);
      total.titles += n.titles;
      total.messages += n.messages;
      total.documents += n.documents;
      if (n.titles + n.messages + n.documents === 0) return total;
    }
  }

  /** Drops the isolated test schema created by `connect({ schema })`. */
  async dropSchema(schema: string): Promise<void> {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error("Invalid schema name.");
    await this.pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
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
   */
  private async touch(q: Queryable, conversationId: string): Promise<void> {
    await q.query(
      `WITH u AS (
         UPDATE users SET sync_counter = sync_counter + 1
         WHERE id = (SELECT user_id FROM conversations WHERE id = $1)
         RETURNING sync_counter)
       UPDATE conversations SET sync_seq = (SELECT sync_counter FROM u) WHERE id = $1`,
      [conversationId],
    );
  }

  // ---- users and sessions ----------------------------------------------------------------------

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

  async deleteUserData(userId: string): Promise<void> {
    // Every owned table cascades from users.
    await this.pool.query("DELETE FROM users WHERE id = $1", [userId]);
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
    const { rows } = await client.query<ConversationRow>("SELECT * FROM conversations WHERE id = $1 FOR UPDATE", [id]);
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

  async deleteConversation(userId: string, id: string): Promise<boolean> {
    return this.tx(async (client) => {
      const res = await client.query(
        `UPDATE conversations SET deleted_at = now(), title = NULL, title_enc = NULL, title_key_id = NULL
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [id, userId],
      );
      if (res.rowCount !== 1) return false;
      await client.query("DELETE FROM messages WHERE conversation_id = $1", [id]);
      await this.touch(client, id);
      return true;
    });
  }

  async listConversationChanges(userId: string, afterSeq: number, limit: number): Promise<ConversationChangePage> {
    const { rows } = await this.pool.query<ConversationRow>(
      "SELECT * FROM conversations WHERE user_id = $1 AND sync_seq > $2 ORDER BY sync_seq LIMIT $3",
      [userId, afterSeq, limit + 1],
    );
    const page = rows.slice(0, limit);
    const ids = page.filter((r) => r.deleted_at === null).map((r) => r.id);
    const byConversation = new Map<string, MessageRecord[]>();
    if (ids.length > 0) {
      const messages = await this.pool.query<MessageRow>(
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
  async encryptionMaintenanceBatch(limit = 200): Promise<{ titles: number; messages: number; documents: number }> {
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
      return { titles: convs.rowCount ?? 0, messages: msgs.rowCount ?? 0, documents: docs.rowCount ?? 0 };
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
         + (SELECT count(*) FROM documents WHERE enc_key_id <> $1) AS r`,
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

  async listToolInvocations(userId: string, limit: number): Promise<ToolInvocationRow[]> {
    const { rows } = await this.pool.query<{
      user_id: string; conversation_id: string; message_id: string; call_id: string; provider: string; plugin_id: string;
      tool_name: string; status: string; duration_ms: number; arg_bytes: number; result_chars: number; created_at: Date;
    }>("SELECT * FROM tool_invocations WHERE user_id = $1 ORDER BY id DESC LIMIT $2", [userId, limit]);
    return rows.map((r) => ({
      userId: r.user_id, conversationId: r.conversation_id, messageId: r.message_id, callId: r.call_id,
      provider: r.provider as ProviderId, plugin: r.plugin_id, tool: r.tool_name, status: r.status as ToolInvocationRow["status"],
      durationMs: r.duration_ms, argBytes: r.arg_bytes, resultChars: r.result_chars, createdAt: iso(r.created_at),
    }));
  }

  // ---- usage -----------------------------------------------------------------------------------

  async recordUsage(u: UsageRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO usage_records (user_id, conversation_id, message_id, provider, model, demo, input_tokens, output_tokens, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [u.userId, u.conversationId, u.messageId, u.provider, u.model, u.demo, u.inputTokens, u.outputTokens, u.createdAt],
    );
  }

  async listUsage(userId: string): Promise<UsageRow[]> {
    const { rows } = await this.pool.query<{
      user_id: string; conversation_id: string; message_id: string; provider: string; model: string; demo: boolean;
      input_tokens: string | null; output_tokens: string | null; created_at: Date;
    }>("SELECT * FROM usage_records WHERE user_id = $1 ORDER BY id", [userId]);
    return rows.map((r) => ({
      userId: r.user_id, conversationId: r.conversation_id, messageId: r.message_id, provider: r.provider as ProviderId,
      model: r.model, demo: r.demo, inputTokens: num(r.input_tokens), outputTokens: num(r.output_tokens), createdAt: iso(r.created_at),
    }));
  }
}
