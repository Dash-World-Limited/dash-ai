import pg from "pg";
import type { AssistantMode, DocumentKind, DocumentStatus, MessageRole, MessageStatus, ProviderId } from "@dash-ai/contracts";
import type { DataCipher } from "../security/dataCrypto.js";
import { assertMigrated, migrate } from "./migrate.js";
import {
  type ConversationChange,
  type ConversationChangePage,
  type ConversationRecord,
  type DocumentRecord,
  type DocumentSummary,
  type MessageRecord,
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
  id: string; user_id: string; title: string; title_is_custom: boolean; mode: string;
  created_at: Date; updated_at: Date; deleted_at: Date | null; sync_seq: string;
}
interface MessageRow {
  id: string; conversation_id: string; role: string; content: string; origin: string | null; model: string | null;
  demo: boolean; status: string; compare_group_id: string | null; attachment_ids: string[]; created_at: Date;
}
interface DocumentRow {
  id: string; user_id: string; name: string; kind: string; mime_type: string; size_bytes: string; status: string;
  status_detail: string; extracted_chars: number; page_count: number | null; created_at: Date;
}

const toUser = (r: UserRow): UserRecord => ({
  id: r.id, email: r.email, displayName: r.display_name, passwordHash: r.password_hash, createdAt: iso(r.created_at),
});
const toConversation = (r: ConversationRow): ConversationRecord => ({
  id: r.id, userId: r.user_id, title: r.title, titleIsCustom: r.title_is_custom, mode: r.mode as AssistantMode,
  createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
});
const toMessage = (r: MessageRow): MessageRecord => ({
  id: r.id, conversationId: r.conversation_id, role: r.role as MessageRole, content: r.content,
  origin: r.origin as ProviderId | null, model: r.model, demo: r.demo, status: r.status as MessageStatus,
  compareGroupId: r.compare_group_id, attachmentIds: r.attachment_ids, createdAt: iso(r.created_at),
});
const toSummary = (r: DocumentRow): DocumentSummary => ({
  id: r.id, userId: r.user_id, name: r.name, kind: r.kind as DocumentKind, mimeType: r.mime_type,
  sizeBytes: Number(r.size_bytes), status: r.status as DocumentStatus, statusDetail: r.status_detail,
  extractedChars: r.extracted_chars, pageCount: r.page_count, createdAt: iso(r.created_at),
});

const documentAad = (userId: string, id: string) => `dash-ai:document:${userId}:${id}`;

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
    return new PostgresStore(pool, options.cipher);
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

  // ---- conversations and messages --------------------------------------------------------------

  async getConversation(userId: string, id: string): Promise<ConversationRecord | undefined> {
    const { rows } = await this.pool.query<ConversationRow>(
      "SELECT * FROM conversations WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
      [id, userId],
    );
    return rows[0] && toConversation(rows[0]);
  }

  async conversationExists(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query("SELECT 1 FROM conversations WHERE id = $1", [id]);
    return (rowCount ?? 0) > 0;
  }

  async saveConversation(c: ConversationRecord): Promise<void> {
    await this.tx(async (client) => {
      const res = await client.query(
        `INSERT INTO conversations (id, user_id, title, title_is_custom, mode, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, title_is_custom = EXCLUDED.title_is_custom,
           mode = EXCLUDED.mode, updated_at = EXCLUDED.updated_at
         WHERE conversations.user_id = EXCLUDED.user_id AND conversations.deleted_at IS NULL`,
        [c.id, c.userId, c.title, c.titleIsCustom, c.mode, c.createdAt, c.updatedAt],
      );
      if (res.rowCount === 1) await this.touch(client, c.id);
    });
  }

  async listConversations(userId: string): Promise<ConversationRecord[]> {
    const { rows } = await this.pool.query<ConversationRow>(
      "SELECT * FROM conversations WHERE user_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC, id",
      [userId],
    );
    return rows.map(toConversation);
  }

  async deleteConversation(userId: string, id: string): Promise<boolean> {
    return this.tx(async (client) => {
      const res = await client.query(
        "UPDATE conversations SET deleted_at = now(), title = '' WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
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
        list.push(toMessage(m));
        byConversation.set(m.conversation_id, list);
      }
    }
    const changes: ConversationChange[] = page.map((r) => ({
      seq: Number(r.sync_seq),
      deleted: r.deleted_at !== null,
      conversation: toConversation(r),
      messages: byConversation.get(r.id) ?? [],
    }));
    return { changes, hasMore: rows.length > limit };
  }

  async listMessages(conversationId: string): Promise<MessageRecord[]> {
    const { rows } = await this.pool.query<MessageRow>(
      `SELECT m.* FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE m.conversation_id = $1 AND c.deleted_at IS NULL ORDER BY m.position`,
      [conversationId],
    );
    return rows.map(toMessage);
  }

  async saveMessage(m: MessageRecord): Promise<void> {
    await this.tx(async (client) => {
      const res = await client.query(
        `INSERT INTO messages (conversation_id, id, role, content, origin, model, demo, status, compare_group_id, attachment_ids, created_at)
         SELECT $1::text,$2::text,$3::text,$4::text,$5::text,$6::text,$7::boolean,$8::text,$9::text,$10::text[],$11::timestamptz
         WHERE EXISTS (SELECT 1 FROM conversations WHERE id = $1 AND deleted_at IS NULL)
         ON CONFLICT (conversation_id, id) DO UPDATE SET role = EXCLUDED.role, content = EXCLUDED.content,
           origin = EXCLUDED.origin, model = EXCLUDED.model, demo = EXCLUDED.demo, status = EXCLUDED.status,
           compare_group_id = EXCLUDED.compare_group_id, attachment_ids = EXCLUDED.attachment_ids,
           created_at = EXCLUDED.created_at`,
        [m.conversationId, m.id, m.role, m.content, m.origin, m.model, m.demo, m.status, m.compareGroupId, m.attachmentIds, m.createdAt],
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
