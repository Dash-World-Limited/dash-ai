import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/store/memoryStore.js";
import type { ConversationRecord, DocumentRecord, MessageRecord, Store, UserRecord } from "../src/store/store.js";
import { TEST_DATABASE_URL, createTestPgStore, type TestPgStore } from "./pgTestStore.js";

// CI sets REQUIRE_DB_TESTS=1 so a missing database fails loudly instead of silently skipping.
if (process.env.REQUIRE_DB_TESTS === "1" && !TEST_DATABASE_URL) {
  throw new Error("REQUIRE_DB_TESTS=1 but TEST_DATABASE_URL is not set");
}

let n = 0;
const uid = (p: string) => `${p}-${(++n).toString().padStart(6, "0")}-${Math.random().toString(16).slice(2, 8)}`;
const t = (offsetSeconds = 0) => new Date(Date.UTC(2026, 0, 1, 0, 0, offsetSeconds)).toISOString();

const user = (over: Partial<UserRecord> = {}): UserRecord => ({
  id: uid("user"), email: `${uid("e")}@example.com`, displayName: "Ada", passwordHash: "scrypt$hash", createdAt: t(), ...over,
});
const conversation = (userId: string, over: Partial<ConversationRecord> = {}): ConversationRecord => ({
  id: uid("conv"), userId, title: "New chat", titleIsCustom: false, mode: "general", createdAt: t(), updatedAt: t(), ...over,
});
const message = (conversationId: string, over: Partial<MessageRecord> = {}): MessageRecord => ({
  id: uid("msg"), conversationId, role: "user", content: "hi", origin: null, model: null, demo: false,
  status: "complete", compareGroupId: null, attachmentIds: [], createdAt: t(), ...over,
});
const document = (userId: string, over: Partial<DocumentRecord> = {}): DocumentRecord => ({
  id: uid("doc"), userId, name: "plan.txt", kind: "txt", mimeType: "text/plain", sizeBytes: 12, status: "ready",
  statusDetail: "", extractedText: "Quarterly plan — ünïcode ✓", pageCount: null, createdAt: t(), ...over,
});

/** Behaviour every Store implementation must share. */
function storeContract(name: string, make: () => Promise<Store>, teardown?: () => Promise<void>) {
  describe(`Store contract: ${name}`, () => {
    let store: Store;
    beforeAll(async () => {
      store = await make();
    });
    afterAll(async () => {
      if (teardown) await teardown();
      else await store.close();
    });

    it("creates users with case-insensitive unique emails", async () => {
      const u = user({ email: `Mixed.${uid("c")}@Example.com` });
      expect(await store.createUser(u)).toBe(true);
      expect(await store.createUser(user({ email: u.email.toUpperCase() }))).toBe(false);
      expect((await store.findUserByEmail(u.email.toLowerCase()))?.id).toBe(u.id);
      expect((await store.findUserById(u.id))?.email).toBe(u.email.toLowerCase());
      expect(await store.findUserById("nobody-nobody")).toBeUndefined();
    });

    it("stores sessions and purges expired ones", async () => {
      const u = user();
      await store.createUser(u);
      const live = { tokenHash: uid("h"), userId: u.id, createdAt: t(), expiresAt: t(1000) };
      const dead = { tokenHash: uid("h"), userId: u.id, createdAt: t(), expiresAt: t(5) };
      await store.createSession(live);
      await store.createSession(dead);
      expect(await store.findSession(live.tokenHash)).toEqual(live);
      expect(await store.purgeExpiredSessions(new Date(t(10)))).toBeGreaterThanOrEqual(1);
      expect(await store.findSession(dead.tokenHash)).toBeUndefined();
      expect(await store.findSession(live.tokenHash)).toBeDefined();
      await store.deleteSession(live.tokenHash);
      expect(await store.findSession(live.tokenHash)).toBeUndefined();
    });

    it("signs a user out everywhere without touching other users' sessions", async () => {
      const a = user();
      const b = user();
      await store.createUser(a);
      await store.createUser(b);
      const session = (userId: string) => ({ tokenHash: uid("h"), userId, createdAt: t(), expiresAt: t(1000) });
      const [a1, a2, b1] = [session(a.id), session(a.id), session(b.id)];
      for (const s of [a1, a2, b1]) await store.createSession(s);
      expect(await store.deleteSessionsForUser(a.id)).toBe(2);
      expect(await store.findSession(a1.tokenHash)).toBeUndefined();
      expect(await store.findSession(a2.tokenHash)).toBeUndefined();
      expect(await store.findSession(b1.tokenHash)).toEqual(b1);
      expect(await store.deleteSessionsForUser(a.id)).toBe(0);
    });

    it("never writes rows for an account that no longer exists", async () => {
      const u = user();
      await store.createUser(u);
      await store.deleteUserData(u.id);
      const c = conversation(u.id);
      const attempts: Array<() => Promise<unknown>> = [
        () => store.saveConversation(c),
        () => store.createSession({ tokenHash: uid("h"), userId: u.id, createdAt: t(), expiresAt: t(1000) }),
        () => store.saveDocument(document(u.id)),
        () => store.recordUsage({ userId: u.id, conversationId: c.id, messageId: uid("m"), provider: "openai", model: "m", demo: false, inputTokens: 1, outputTokens: 1, createdAt: t() }),
      ];
      // PostgreSQL refuses with a foreign-key error; the memory store ignores the write. Either way: no rows.
      for (const attempt of attempts) await attempt().catch(() => undefined);
      expect(await store.getConversation(u.id, c.id)).toBeUndefined();
      expect(await store.listConversations(u.id)).toEqual([]);
      expect(await store.listDocuments(u.id)).toEqual([]);
      expect(await store.listUsage(u.id)).toEqual([]);
    });

    it("replaces a password hash only if it has not changed since it was read", async () => {
      const u = user({ passwordHash: "scrypt$old" });
      await store.createUser(u);
      expect(await store.replacePasswordHash(u.id, "scrypt$stale", "scrypt$x")).toBe(false);
      expect((await store.findUserById(u.id))?.passwordHash).toBe("scrypt$old");
      expect(await store.replacePasswordHash(u.id, "scrypt$old", "scrypt$new")).toBe(true);
      expect((await store.findUserById(u.id))?.passwordHash).toBe("scrypt$new");
      expect(await store.replacePasswordHash("nobody-nobody", "scrypt$new", "scrypt$y")).toBe(false);
    });

    it("round-trips conversations and messages in insertion order", async () => {
      const u = user();
      await store.createUser(u);
      const c = conversation(u.id);
      await store.saveConversation(c);
      const m1 = message(c.id, { content: "first" });
      const m2 = message(c.id, {
        role: "assistant", content: "second", origin: "anthropic", model: "m", status: "stopped", compareGroupId: m1.id,
        attachmentIds: ["a1", "a2"], createdAt: t(2),
      });
      await store.saveMessage(m1);
      await store.saveMessage(m2);
      expect(await store.getConversation(u.id, c.id)).toEqual(c);
      expect(await store.listMessages(c.id)).toEqual([m1, m2]);

      await store.saveMessage({ ...m1, content: "first (edited)" });
      expect((await store.listMessages(c.id)).map((m) => m.content)).toEqual(["first (edited)", "second"]);
    });

    it("scopes conversations to their owner and never reuses an id", async () => {
      const a = user();
      const b = user();
      await store.createUser(a);
      await store.createUser(b);
      const c = conversation(a.id);
      await store.saveConversation(c);
      expect(await store.getConversation(b.id, c.id)).toBeUndefined();
      expect(await store.conversationExists(c.id)).toBe(true);
      expect(await store.deleteConversation(b.id, c.id)).toBe(false);
      // Another user cannot take over an existing id.
      await store.saveConversation({ ...c, userId: b.id, title: "hijack" });
      expect((await store.getConversation(a.id, c.id))?.title).toBe("New chat");
      expect(await store.listConversations(b.id)).toEqual([]);
    });

    it("keeps message ids independent per conversation", async () => {
      const a = user();
      const b = user();
      await store.createUser(a);
      await store.createUser(b);
      const ca = conversation(a.id);
      const cb = conversation(b.id);
      await store.saveConversation(ca);
      await store.saveConversation(cb);
      const sharedId = uid("msg");
      await store.saveMessage(message(ca.id, { id: sharedId, content: "from a" }));
      await store.saveMessage(message(cb.id, { id: sharedId, content: "from b" }));
      expect((await store.listMessages(ca.id))[0]?.content).toBe("from a");
      expect((await store.listMessages(cb.id))[0]?.content).toBe("from b");
    });

    it("lists conversations most recently updated first", async () => {
      const u = user();
      await store.createUser(u);
      const old = conversation(u.id, { updatedAt: t(1) });
      const fresh = conversation(u.id, { updatedAt: t(9) });
      await store.saveConversation(old);
      await store.saveConversation(fresh);
      expect((await store.listConversations(u.id)).map((c) => c.id)).toEqual([fresh.id, old.id]);
    });

    it("truncates a message and everything after it", async () => {
      const u = user();
      await store.createUser(u);
      const c = conversation(u.id);
      await store.saveConversation(c);
      const ms = [message(c.id), message(c.id, { role: "assistant", origin: "openai" }), message(c.id), message(c.id)];
      for (const m of ms) await store.saveMessage(m);
      await store.truncateMessagesFrom(c.id, ms[2]!.id);
      expect((await store.listMessages(c.id)).map((m) => m.id)).toEqual([ms[0]!.id, ms[1]!.id]);
      await store.truncateMessagesFrom(c.id, "does-not-exist");
      expect(await store.listMessages(c.id)).toHaveLength(2);
    });

    it("soft-deletes conversations: tombstone, no messages, id stays taken, writes are no-ops", async () => {
      const u = user();
      await store.createUser(u);
      const c = conversation(u.id, { title: "Secret plans" });
      await store.saveConversation(c);
      await store.saveMessage(message(c.id, { content: "private text" }));
      expect(await store.deleteConversation(u.id, c.id)).toBe(true);
      expect(await store.deleteConversation(u.id, c.id)).toBe(false);
      expect(await store.getConversation(u.id, c.id)).toBeUndefined();
      expect(await store.listConversations(u.id)).toEqual([]);
      expect(await store.listMessages(c.id)).toEqual([]);
      expect(await store.conversationExists(c.id)).toBe(true);

      // A stream that finishes after the user deleted the chat must not resurrect it.
      await store.saveConversation({ ...c, title: "resurrected" });
      await store.saveMessage(message(c.id, { content: "late answer" }));
      expect(await store.getConversation(u.id, c.id)).toBeUndefined();
      expect(await store.listMessages(c.id)).toEqual([]);

      const { changes } = await store.listConversationChanges(u.id, 0, 50);
      const tomb = changes.find((x) => x.conversation.id === c.id)!;
      expect(tomb.deleted).toBe(true);
      expect(tomb.messages).toEqual([]);
      expect(tomb.conversation.title).toBe(""); // the title is scrubbed, not retained in the tombstone
    });

    it("assigns increasing per-user sync sequence numbers that survive paging", async () => {
      const u = user();
      const other = user();
      await store.createUser(u);
      await store.createUser(other);
      const c1 = conversation(u.id);
      const c2 = conversation(u.id);
      const c3 = conversation(u.id);
      for (const c of [c1, c2, c3]) await store.saveConversation(c);
      await store.saveConversation(conversation(other.id));
      await store.saveMessage(message(c1.id, { content: "touches c1 last" }));

      const all = await store.listConversationChanges(u.id, 0, 50);
      expect(all.hasMore).toBe(false);
      expect(all.changes.map((x) => x.conversation.id)).toEqual([c2.id, c3.id, c1.id]);
      const seqs = all.changes.map((x) => x.seq);
      expect([...seqs].sort((x, y) => x - y)).toEqual(seqs);
      expect(new Set(seqs).size).toBe(3);
      expect(all.changes[2]!.messages.map((m) => m.content)).toEqual(["touches c1 last"]);

      const first = await store.listConversationChanges(u.id, 0, 2);
      expect(first.hasMore).toBe(true);
      expect(first.changes).toHaveLength(2);
      const rest = await store.listConversationChanges(u.id, first.changes[1]!.seq, 2);
      expect(rest.hasMore).toBe(false);
      expect(rest.changes.map((x) => x.conversation.id)).toEqual([c1.id]);

      // Nothing new after the newest cursor, and another user's changes never leak.
      expect((await store.listConversationChanges(u.id, seqs[2]!, 50)).changes).toEqual([]);
      expect(all.changes.every((x) => x.conversation.userId === u.id)).toBe(true);
    });

    it("bumps the sync sequence for renames, truncation and deletion", async () => {
      const u = user();
      await store.createUser(u);
      const c = conversation(u.id);
      await store.saveConversation(c);
      const m = message(c.id);
      await store.saveMessage(m);
      const seqOf = async () => (await store.listConversationChanges(u.id, 0, 10)).changes[0]!.seq;
      const s1 = await seqOf();
      await store.saveConversation({ ...c, title: "Renamed", titleIsCustom: true });
      const s2 = await seqOf();
      await store.truncateMessagesFrom(c.id, m.id);
      const s3 = await seqOf();
      await store.deleteConversation(u.id, c.id);
      const s4 = await seqOf();
      expect(s1).toBeLessThan(s2);
      expect(s2).toBeLessThan(s3);
      expect(s3).toBeLessThan(s4);
    });

    it("stores documents, lists metadata without text, and scopes by owner", async () => {
      const a = user();
      const b = user();
      await store.createUser(a);
      await store.createUser(b);
      const d = document(a.id, { pageCount: 3, status: "ready" });
      await store.saveDocument(d);
      expect(await store.getDocument(a.id, d.id)).toEqual(d);
      expect(await store.getDocument(b.id, d.id)).toBeUndefined();
      const listed = (await store.listDocuments(a.id))[0]!;
      expect(listed.extractedChars).toBe(d.extractedText.length);
      expect("extractedText" in listed).toBe(false);
      expect(await store.deleteDocument(b.id, d.id)).toBe(false);
      expect(await store.deleteDocument(a.id, d.id)).toBe(true);
      expect(await store.listDocuments(a.id)).toEqual([]);
    });

    it("records usage per user, including null token counts", async () => {
      const u = user();
      await store.createUser(u);
      const row = {
        userId: u.id, conversationId: "c-1234567", messageId: "m-1234567", provider: "openai" as const, model: "x",
        demo: false, inputTokens: 5_000_000_000, outputTokens: null, createdAt: t(),
      };
      await store.recordUsage(row);
      await store.recordUsage({ ...row, provider: "anthropic", inputTokens: 1, outputTokens: 2 });
      await store.recordUsage({ ...row, provider: "bedrock", model: "eu.amazon.nova-lite-v1:0", inputTokens: 1_000, outputTokens: 500, estimatedCostUsd: 0.00018 });
      const rows = await store.listUsage(u.id);
      expect(rows.map((r) => r.provider)).toEqual(["openai", "anthropic", "bedrock"]);
      // A row written without a cost estimate reads back as unknown, never as zero.
      expect(rows[0]).toEqual({ ...row, estimatedCostUsd: null });
      expect(rows[2]).toMatchObject({ provider: "bedrock", model: "eu.amazon.nova-lite-v1:0", estimatedCostUsd: 0.00018 });
    });

    it("tracks a title revision that changes only when the title changes", async () => {
      const u = user();
      await store.createUser(u);
      const c = conversation(u.id);
      await store.saveConversation(c);
      const revOf = async () => (await store.listConversationChanges(u.id, 0, 10)).changes[0]!.titleRev;
      expect(await revOf()).toBe(0);
      await store.saveConversation({ ...c, updatedAt: t(5), mode: "writing" });
      expect(await revOf()).toBe(0);
      await store.saveConversation({ ...c, title: "Renamed" });
      expect(await revOf()).toBe(1);
    });

    it("reports conversation state without revealing other users' ids", async () => {
      const a = user();
      const b = user();
      await store.createUser(a);
      await store.createUser(b);
      const c = conversation(a.id);
      await store.saveConversation(c);
      expect(await store.conversationState(a.id, c.id)).toBe("live");
      expect(await store.conversationState(b.id, c.id)).toBe("absent");
      expect(await store.conversationState(a.id, "conv-unknown-1")).toBe("absent");
      await store.deleteConversation(a.id, c.id);
      expect(await store.conversationState(a.id, c.id)).toBe("deleted");
    });

    it("pushConversation creates, appends only a newer tail, and refuses tombstones and foreign ids", async () => {
      const a = user();
      const b = user();
      await store.createUser(a);
      await store.createUser(b);
      const c = conversation(a.id);
      const m1 = message(c.id, { createdAt: t(10) });
      const m2 = message(c.id, { createdAt: t(20) });
      expect(await store.pushConversation(a.id, { conversation: c, messages: [m1, m2] })).toEqual({ status: "created", appended: 2, skipped: 0 });
      expect(await store.pushConversation(a.id, { conversation: c, messages: [m1, m2] })).toEqual({ status: "merged", appended: 0, skipped: 2 });
      const older = message(c.id, { createdAt: t(15) });
      const newer = message(c.id, { createdAt: t(30) });
      expect(await store.pushConversation(a.id, { conversation: c, messages: [older, newer] })).toEqual({ status: "merged", appended: 1, skipped: 1 });
      expect((await store.listMessages(c.id)).map((m) => m.id)).toEqual([m1.id, m2.id, newer.id]);
      expect(await store.pushConversation(b.id, { conversation: { ...c, userId: b.id }, messages: [message(c.id, { createdAt: t(40) })] })).toEqual({ status: "rejected", appended: 0, skipped: 1 });
      await store.deleteConversation(a.id, c.id);
      expect(await store.pushConversation(a.id, { conversation: c, messages: [m1] })).toEqual({ status: "deleted", appended: 0, skipped: 1 });
      expect(await store.listMessages(c.id)).toEqual([]);
    });

    it("renameConversationIfCurrent is compare-and-set and idempotent", async () => {
      const u = user();
      await store.createUser(u);
      const c = conversation(u.id);
      await store.saveConversation(c);
      expect(await store.renameConversationIfCurrent(u.id, c.id, "A", null, t(1))).toEqual({ status: "applied" }); // generated title
      expect(await store.renameConversationIfCurrent(u.id, c.id, "B", 0, t(2))).toEqual({ status: "conflict" }); // stale base
      expect(await store.renameConversationIfCurrent(u.id, c.id, "A", 0, t(3))).toEqual({ status: "applied" }); // already true
      expect(await store.renameConversationIfCurrent(u.id, c.id, "B", 1, t(4))).toEqual({ status: "applied" });
      expect((await store.getConversation(u.id, c.id))?.title).toBe("B");
      expect(await store.renameConversationIfCurrent("someone-else", c.id, "C", 2, t(5))).toEqual({ status: "not_found" });
    });

    it("stores per-user plugin settings and upserts them", async () => {
      const a = user();
      const b = user();
      await store.createUser(a);
      await store.createUser(b);
      expect(await store.getPluginSettings(a.id)).toEqual([]);
      const s1 = { pluginId: "dash-demo", enabled: true, grantedScopes: ["demo:read"], updatedAt: t(1) };
      await store.savePluginSetting(a.id, s1);
      await store.savePluginSetting(a.id, { pluginId: "mock-github", enabled: false, grantedScopes: [], updatedAt: t(2) });
      await store.savePluginSetting(a.id, { ...s1, enabled: false, grantedScopes: [], updatedAt: t(3) });
      expect(await store.getPluginSettings(a.id)).toEqual([
        { pluginId: "dash-demo", enabled: false, grantedScopes: [], updatedAt: t(3) },
        { pluginId: "mock-github", enabled: false, grantedScopes: [], updatedAt: t(2) },
      ]);
      expect(await store.getPluginSettings(b.id)).toEqual([]);
    });

    it("records tool audit rows (metadata only), newest first, per user", async () => {
      const a = user();
      const b = user();
      await store.createUser(a);
      await store.createUser(b);
      const row = (callId: string, status: "ok" | "denied") => ({
        userId: a.id, conversationId: "conv-0000001", messageId: "msg-00000001", callId, provider: "openai" as const,
        plugin: "dash-demo", tool: "text_stats", status, durationMs: 4, argBytes: 12, resultChars: 30, createdAt: t(),
      });
      await store.recordToolInvocation(row("c1", "ok"));
      await store.recordToolInvocation(row("c2", "denied"));
      await store.recordToolInvocation({ ...row("c3", "ok"), userId: b.id });
      expect((await store.listToolInvocations(a.id, 10)).map((r) => r.callId)).toEqual(["c2", "c1"]);
      expect((await store.listToolInvocations(a.id, 1)).map((r) => r.callId)).toEqual(["c2"]);
      expect(await store.listToolInvocations(a.id, 10)).toContainEqual(row("c1", "ok"));
      expect((await store.listToolInvocations(b.id, 10)).map((r) => r.callId)).toEqual(["c3"]);
    });

    it("deletes everything a user owns and nothing else", async () => {
      const a = user();
      const b = user();
      await store.createUser(a);
      await store.createUser(b);
      const ca = conversation(a.id);
      const cb = conversation(b.id);
      await store.saveConversation(ca);
      await store.saveConversation(cb);
      await store.saveMessage(message(ca.id));
      await store.saveMessage(message(cb.id));
      await store.saveDocument(document(a.id));
      await store.saveDocument(document(b.id));
      await store.recordUsage({ userId: a.id, conversationId: ca.id, messageId: "m-1234567", provider: "openai", model: "x", demo: false, inputTokens: 1, outputTokens: 1, createdAt: t() });
      const session = { tokenHash: uid("h"), userId: a.id, createdAt: t(), expiresAt: t(999) };
      await store.createSession(session);
      await store.savePluginSetting(a.id, { pluginId: "dash-demo", enabled: true, grantedScopes: ["demo:read"], updatedAt: t() });
      await store.recordToolInvocation({
        userId: a.id, conversationId: ca.id, messageId: "msg-00000001", callId: "c", provider: "openai", plugin: "dash-demo",
        tool: "text_stats", status: "ok", durationMs: 1, argBytes: 1, resultChars: 1, createdAt: t(),
      });

      await store.deleteUserData(a.id);
      expect(await store.getPluginSettings(a.id)).toEqual([]);
      expect(await store.listToolInvocations(a.id, 10)).toEqual([]);
      expect(await store.findUserById(a.id)).toBeUndefined();
      expect(await store.findUserByEmail(a.email)).toBeUndefined();
      expect(await store.findSession(session.tokenHash)).toBeUndefined();
      expect(await store.conversationExists(ca.id)).toBe(false);
      expect(await store.listDocuments(a.id)).toEqual([]);
      expect(await store.listUsage(a.id)).toEqual([]);
      expect(await store.listConversationChanges(a.id, 0, 10)).toEqual({ changes: [], hasMore: false });
      expect(await store.getConversation(b.id, cb.id)).toBeDefined();
      expect(await store.listMessages(cb.id)).toHaveLength(1);
      expect(await store.listDocuments(b.id)).toHaveLength(1);
    });
  });
}

storeContract("memory", async () => new MemoryStore());

if (TEST_DATABASE_URL) {
  let pg: TestPgStore;
  storeContract(
    "postgres",
    async () => {
      pg = await createTestPgStore();
      return pg.store;
    },
    async () => pg.dispose(),
  );
} else {
  describe("Store contract: postgres", () => {
    it.skip("skipped: set TEST_DATABASE_URL to run against PostgreSQL", () => undefined);
  });
}
