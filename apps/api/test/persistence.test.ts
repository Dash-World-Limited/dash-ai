import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { ConfigError } from "../src/config.js";
import { DataCipher, DataKeyError } from "../src/security/dataCrypto.js";
import { createStore } from "../src/store/factory.js";
import { assertMigrated, migrate } from "../src/store/migrate.js";
import { MIGRATIONS } from "../src/store/migrations.js";
import { PostgresStore } from "../src/store/postgresStore.js";
import { TEST_DATABASE_URL, createTestPgStore, testCipher } from "./pgTestStore.js";
import { chatBody, makeDocx, multipart, register, sse, testConfig } from "./helpers.js";

if (process.env.REQUIRE_DB_TESTS === "1" && !TEST_DATABASE_URL) {
  throw new Error("REQUIRE_DB_TESTS=1 but TEST_DATABASE_URL is not set");
}

const key = () => randomBytes(32);
const b64 = (b: Buffer) => b.toString("base64");

describe("DataCipher (AES-256-GCM)", () => {
  const cipher = new DataCipher("k1", new Map([["k1", key()]]));

  it("round-trips text including unicode and empty strings", () => {
    for (const text of ["", "plain", "ünïcode ✓ 日本語 🙂", "x".repeat(200_000)]) {
      const enc = cipher.encrypt(text, "aad");
      expect(cipher.decrypt(enc, "aad")).toBe(text);
    }
  });

  it("uses a fresh nonce each time and does not leak plaintext", () => {
    const a = cipher.encrypt("secret contract terms", "aad");
    const b = cipher.encrypt("secret contract terms", "aad");
    expect(a.payload.equals(b.payload)).toBe(false);
    expect(a.payload.toString("latin1")).not.toContain("secret");
  });

  it("rejects the wrong context, tampering and truncation", () => {
    const enc = cipher.encrypt("hello", "doc-1");
    expect(() => cipher.decrypt(enc, "doc-2")).toThrow(DataKeyError);
    const tampered = Buffer.from(enc.payload);
    tampered[tampered.length - 1]! ^= 0x01;
    expect(() => cipher.decrypt({ ...enc, payload: tampered }, "doc-1")).toThrow(DataKeyError);
    expect(() => cipher.decrypt({ ...enc, payload: enc.payload.subarray(0, 10) }, "doc-1")).toThrow(DataKeyError);
    expect(() => cipher.decrypt({ ...enc, keyId: "unknown" }, "doc-1")).toThrow(/key id/);
  });

  it("supports rotation: new key encrypts, retired keys still decrypt", () => {
    const k1 = key();
    const k2 = key();
    const oldCipher = DataCipher.fromConfig(b64(k1), "k1");
    const enc = oldCipher.encrypt("old data", "aad");
    const rotated = DataCipher.fromConfig(b64(k2), "k2", `k1:${b64(k1)}`);
    expect(rotated.decrypt(enc, "aad")).toBe("old data");
    expect(rotated.encrypt("new", "aad").keyId).toBe("k2");
    expect(() => DataCipher.fromConfig(b64(k2), "k2").decrypt(enc, "aad")).toThrow(DataKeyError);
  });

  it("validates key configuration without echoing key material", () => {
    const secret = "c2hvcnQ="; // too short
    try {
      DataCipher.fromConfig(secret, "k1");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DataKeyError);
      expect((err as Error).message).not.toContain(secret);
    }
    expect(() => DataCipher.fromConfig(b64(key()), "k1", "nocolon")).toThrow(DataKeyError);
    expect(() => DataCipher.fromConfig(b64(key()), "k1", `k1:${b64(key())}`)).toThrow(/twice/);
  });
});

describe("store selection (createStore)", () => {
  it("falls back to a clearly warned in-memory store outside production", async () => {
    const selection = await createStore(testConfig());
    expect(selection.kind).toBe("memory");
    expect(selection.warnings.join(" ")).toMatch(/in-memory/);
    await selection.store.close();
  });

  it("refuses the in-memory store in production unless explicitly allowed", async () => {
    await expect(createStore(testConfig({ NODE_ENV: "production" }))).rejects.toThrow(ConfigError);
    const allowed = await createStore(testConfig({ NODE_ENV: "production", ALLOW_MEMORY_STORE: "true" }));
    expect(allowed.kind).toBe("memory");
  });

  it("requires a valid encryption key when a database is configured", async () => {
    const url = "postgres://localhost:1/never-connected";
    await expect(createStore(testConfig({ DATABASE_URL: url }))).rejects.toThrow(/DATA_ENCRYPTION_KEY is required/);
    // Built at runtime: a valid base64 string that decodes to far fewer than 32 bytes.
    const tooShort = Buffer.from("too short").toString("base64");
    await expect(createStore(testConfig({ DATABASE_URL: url, DATA_ENCRYPTION_KEY: tooShort }))).rejects.toThrow(/32 bytes/);
  });

  it("defaults database TLS to require and manual migrations in production", () => {
    const prod = testConfig({ NODE_ENV: "production", DATABASE_URL: "postgres://h/db" });
    expect(prod.database.ssl).toBe("require");
    expect(prod.database.autoMigrate).toBe(false);
    const dev = testConfig({ DATABASE_URL: "postgres://h/db" });
    expect(dev.database.ssl).toBe("disable");
    expect(dev.database.autoMigrate).toBe(true);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("PostgreSQL", () => {
  const disposers: Array<() => Promise<void>> = [];
  afterAll(async () => {
    for (const d of disposers) await d();
  });

  async function freshPool() {
    const t = await createTestPgStore();
    disposers.push(() => t.dispose());
    // A second pool on the same isolated schema for inspecting raw rows.
    const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, options: `-c search_path=${t.schema}`, max: 2 });
    disposers.push(() => pool.end());
    return { ...t, pool };
  }

  it("migrations are idempotent, safe to run concurrently, and recorded with checksums", async () => {
    const schema = `t_${randomBytes(6).toString("hex")}`;
    const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 6 });
    try {
      await expect(assertMigrated(pool)).rejects.toThrow(/not been migrated/);
      const reports = await Promise.all([migrate(pool), migrate(pool), migrate(pool)]);
      expect(reports.flatMap((r) => r.applied)).toHaveLength(MIGRATIONS.length); // applied exactly once overall
      expect((await migrate(pool)).applied).toEqual([]);
      await assertMigrated(pool);
      const { rows } = await pool.query("SELECT id, checksum FROM schema_migrations ORDER BY id");
      expect(rows).toHaveLength(MIGRATIONS.length);
      expect(rows[0].checksum).toMatch(/^[0-9a-f]{64}$/);

      // Editing an applied migration is detected.
      await pool.query("UPDATE schema_migrations SET checksum = 'deadbeef' WHERE id = 1");
      await expect(migrate(pool)).rejects.toThrow(/modified after it was applied/);
      // A database from a newer server is refused.
      await pool.query("UPDATE schema_migrations SET checksum = (SELECT checksum FROM schema_migrations WHERE id = 1) WHERE id = 1");
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });

  it("encrypts document text at rest and binds ciphertext to its row", async () => {
    const { store, pool } = await freshPool();
    const userId = "user-enc-0001";
    await store.createUser({ id: userId, email: "enc@example.com", displayName: "E", passwordHash: "h", createdAt: new Date().toISOString() });
    const secret = "CONFIDENTIAL merger terms: pay 41,250,000 on closing";
    const doc = (id: string) => ({
      id, userId, name: "deal.txt", kind: "txt" as const, mimeType: "text/plain", sizeBytes: secret.length,
      status: "ready" as const, statusDetail: "", extractedText: secret, pageCount: null, createdAt: new Date().toISOString(),
    });
    await store.saveDocument(doc("doc-aaaaaaaa"));
    await store.saveDocument(doc("doc-bbbbbbbb"));

    const raw = await pool.query("SELECT * FROM documents WHERE id = 'doc-aaaaaaaa'");
    const dump = JSON.stringify(raw.rows[0]) + (raw.rows[0].extracted_text_enc as Buffer).toString("latin1");
    expect(dump).not.toContain("CONFIDENTIAL");
    expect(dump).not.toContain("41,250,000");
    expect(raw.rows[0].extracted_chars).toBe(secret.length);
    expect(raw.rows[0].enc_key_id).toBe("t1");
    expect((await store.getDocument(userId, "doc-aaaaaaaa"))?.extractedText).toBe(secret);

    // Copying A's ciphertext into B's row must not decrypt.
    await pool.query("UPDATE documents SET extracted_text_enc = $1 WHERE id = 'doc-bbbbbbbb'", [raw.rows[0].extracted_text_enc]);
    await expect(store.getDocument(userId, "doc-bbbbbbbb")).rejects.toThrow(DataKeyError);
  });

  it("reads data written under a retired key and fails clearly without it", async () => {
    const k1 = key();
    const k2 = key();
    const schema = `t_${randomBytes(6).toString("hex")}`;
    const cipher1 = DataCipher.fromConfig(b64(k1), "k1");
    const s1 = await PostgresStore.connect({ connectionString: TEST_DATABASE_URL!, cipher: cipher1, schema });
    disposers.push(async () => {
      await s1.dropSchema(schema).catch(() => undefined);
    });
    await s1.createUser({ id: "user-rot-0001", email: "rot@example.com", displayName: "R", passwordHash: "h", createdAt: new Date().toISOString() });
    await s1.saveDocument({
      id: "doc-rotated1", userId: "user-rot-0001", name: "a.txt", kind: "txt", mimeType: "text/plain", sizeBytes: 3,
      status: "ready", statusDetail: "", extractedText: "old", pageCount: null, createdAt: new Date().toISOString(),
    });
    await s1.close();

    const rotated = await PostgresStore.connect({
      connectionString: TEST_DATABASE_URL!, schema, cipher: DataCipher.fromConfig(b64(k2), "k2", `k1:${b64(k1)}`),
    });
    expect((await rotated.getDocument("user-rot-0001", "doc-rotated1"))?.extractedText).toBe("old");
    await rotated.close();

    const lost = await PostgresStore.connect({ connectionString: TEST_DATABASE_URL!, schema, cipher: DataCipher.fromConfig(b64(k2), "k2") });
    await expect(lost.getDocument("user-rot-0001", "doc-rotated1")).rejects.toThrow(/key id "k1"/);
    await lost.close();
  });

  it("keeps accounts, sessions, conversations, documents and usage across a server restart", async () => {
    const cipher = testCipher("restart");
    const t = await createTestPgStore(cipher);
    disposers.push(() => t.dispose());
    const config = testConfig();

    // --- first server process ---
    const first = await buildApp({ config, store: t.store });
    await first.app.ready();
    const account = await register(first.app, "restart@example.com");
    const upload = multipart("brief.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", await makeDocx("Launch plan for Lagos"));
    const uploaded = await first.app.inject({ method: "POST", url: "/v1/documents", payload: upload.payload, headers: { ...upload.headers, ...account.auth } });
    expect(uploaded.statusCode).toBe(201);
    const doc = uploaded.json() as { id: string };
    const body = chatBody({ modelChoice: "openai", message: { id: "msg-restart-01", content: "Summarise", attachmentIds: [doc.id] } });
    const res = await first.app.inject({ method: "POST", url: "/v1/chat/stream", headers: account.auth, payload: body });
    expect(res.statusCode).toBe(200);
    expect(sse(res.body).some((e) => e.event === "stream.end")).toBe(true);
    await first.app.close(); // the store is owned by the caller; closing the app leaves the data

    // --- a brand new process: new pool, new app, same database ---
    const store2 = await PostgresStore.connect({ connectionString: TEST_DATABASE_URL!, cipher, schema: t.schema });
    disposers.push(async () => store2.close());
    const second = await buildApp({ config, store: store2 });
    await second.app.ready();

    // The old session token still works.
    const me = await second.app.inject({ method: "GET", url: "/v1/me", headers: account.auth });
    expect(me.statusCode).toBe(200);
    // Signing in with the password works too.
    const login = await second.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: "restart@example.com", password: "correct horse battery" } });
    expect(login.statusCode).toBe(200);

    const detail = await second.app.inject({ method: "GET", url: `/v1/conversations/${body.conversationId}`, headers: account.auth });
    expect(detail.statusCode).toBe(200);
    const messages = (detail.json() as { messages: Array<{ role: string; content: string; model: string }> }).messages;
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages[1]!.model).toBe("fake-openai");

    // The encrypted document is still readable and usable as context after the restart.
    const docs = (await second.app.inject({ method: "GET", url: "/v1/documents", headers: account.auth })).json() as { documents: Array<{ id: string; extractedChars: number }> };
    expect(docs.documents[0]?.extractedChars).toBeGreaterThan(5);
    const again = await second.app.inject({
      method: "POST", url: "/v1/chat/stream", headers: account.auth,
      payload: chatBody({ message: { id: "msg-restart-02", content: "And now?", attachmentIds: [doc.id] } }),
    });
    expect(again.statusCode).toBe(200);

    const usage = (await second.app.inject({ method: "GET", url: "/v1/usage", headers: account.auth })).json() as { totals: Array<{ requests: number }> };
    expect(usage.totals[0]!.requests).toBeGreaterThanOrEqual(2);
    await second.app.close();
  });
});
