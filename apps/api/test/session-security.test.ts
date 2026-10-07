import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { FAKE_TRIGGERS } from "../src/providers/fake.js";
import { hashToken } from "../src/security/crypto.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import type { Store } from "../src/store/store.js";
import { chatBody, register, testConfig, testId, USING_POSTGRES } from "./helpers.js";
import { createTestPgStore } from "./pgTestStore.js";

/** Session lifetime, revocation and account deletion, with a controllable clock. */

const apps: FastifyInstance[] = [];
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
  while (disposers.length) await disposers.pop()!();
});

async function setup(env: Record<string, string> = {}) {
  let now = Date.UTC(2026, 5, 1);
  let store: Store = new MemoryStore();
  if (USING_POSTGRES) {
    const pg = await createTestPgStore();
    disposers.push(() => pg.dispose());
    store = pg.store;
  }
  const { app } = await buildApp({ config: testConfig({ SESSION_TTL_DAYS: "30", FAKE_STREAM_DELAY_MS: "5", ...env }), store, now: () => new Date(now) });
  await app.ready();
  apps.push(app);
  return { app, store, advance: (ms: number) => (now += ms), at: () => now };
}

const me = (app: FastifyInstance, auth: Record<string, string>) => app.inject({ method: "GET", url: "/v1/me", headers: auth });
const DAY = 86_400_000;

describe("session lifetime", () => {
  it("a session works until it expires, then is refused and removed (the boundary is exclusive)", async () => {
    const { app, store, advance } = await setup();
    const account = await register(app);
    expect(Date.parse(account.expiresAt) - Date.parse(new Date(Date.UTC(2026, 5, 1)).toISOString())).toBe(30 * DAY);
    advance(30 * DAY - 1);
    expect((await me(app, account.auth)).statusCode).toBe(200);
    advance(1); // exactly at expiresAt
    const expired = await me(app, account.auth);
    expect(expired.statusCode).toBe(401);
    expect(await store.findSession(hashToken(account.token))).toBeUndefined();
    // Signing in again issues a new, valid session.
    const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: account.user.email, password: "correct horse battery" } });
    expect(login.statusCode).toBe(200);
  });

  it("expired sessions are purged in bulk without touching live ones", async () => {
    const { app, store, advance, at } = await setup();
    const old = await register(app);
    advance(20 * DAY);
    const fresh = await register(app);
    advance(11 * DAY);
    expect(await store.purgeExpiredSessions(new Date(at()))).toBeGreaterThanOrEqual(1);
    expect(await store.findSession(hashToken(old.token))).toBeUndefined();
    expect(await store.findSession(hashToken(fresh.token))).toBeDefined();
  });

  it("a revoked token cannot be replayed, and malformed or foreign tokens reveal nothing", async () => {
    const { app } = await setup();
    const account = await register(app);
    await app.inject({ method: "POST", url: "/v1/auth/logout", headers: account.auth });
    for (const authorization of [account.auth.authorization, `bearer ${account.token}`, `Bearer ${account.token}x`, "Bearer ", `Basic ${account.token}`]) {
      const res = await me(app, { authorization });
      expect(res.statusCode).toBe(401);
      expect(res.body).not.toContain(account.token);
    }
  });
});

describe("account deletion while another device is active", () => {
  it("a response still streaming on another device cannot recreate any of the deleted account's data", async () => {
    const { app, store } = await setup();
    const account = await register(app, `deleted-${Date.now()}@example.com`);
    const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: account.user.email, password: "correct horse battery" } });
    const laptop = { authorization: `Bearer ${(login.json() as { token: string }).token}` };
    const body = chatBody({ message: { id: testId("msg"), content: `long answer ${FAKE_TRIGGERS.slow}`, attachmentIds: [] } });
    const streaming = app.inject({ method: "POST", url: "/v1/chat/stream", headers: laptop, payload: body });
    // Delete the account from the phone while the laptop's answer is still being written.
    await new Promise((r) => setTimeout(r, 30));
    expect((await app.inject({ method: "DELETE", url: "/v1/me", headers: account.auth })).statusCode).toBe(204);
    const res = await streaming;
    expect(res.statusCode).toBe(200);
    // Nothing of the account survives: no conversation, messages, usage or sessions.
    expect(await store.findUserById(account.user.id)).toBeUndefined();
    expect(await store.listConversations(account.user.id)).toEqual([]);
    expect(await store.listMessages(body.conversationId as string)).toEqual([]);
    expect(await store.getConversation(account.user.id, body.conversationId as string)).toBeUndefined();
    expect((await me(app, laptop)).statusCode).toBe(401);
    // Re-registering the same email starts from nothing.
    const again = await register(app, account.user.email);
    expect((await app.inject({ method: "GET", url: "/v1/conversations", headers: again.auth })).json()).toEqual({ conversations: [] });
    expect((await app.inject({ method: "GET", url: "/v1/usage", headers: again.auth })).json()).toMatchObject({ totals: [], recent: [] });
  });
});
