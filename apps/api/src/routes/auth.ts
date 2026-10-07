import { LoginRequest, RegisterRequest, type AuthResponse } from "@dash-ai/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { currentUser } from "../auth/requireAuth.js";
import { AppError, parseOrThrow } from "../errors.js";
import { hashPassword, hashToken, needsRehash, newId, newSessionToken, verifyPassword } from "../security/crypto.js";
import type { UserRecord } from "../store/store.js";
import type { RouteContext } from "./context.js";
import { toUser } from "./mappers.js";

// Used to keep login timing similar whether or not the email exists.
const DUMMY_HASH_PROMISE = hashPassword("dash-ai-timing-equaliser");

export function authRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const byIp = ctx.rateLimit("auth", (r) => `auth:${r.ip}`);

  async function issueSession(user: UserRecord): Promise<AuthResponse> {
    const token = newSessionToken();
    const now = ctx.now();
    const expiresAt = new Date(now.getTime() + ctx.config.sessionTtlDays * 86_400_000).toISOString();
    await ctx.store.createSession({ tokenHash: hashToken(token), userId: user.id, createdAt: now.toISOString(), expiresAt });
    return { token, expiresAt, user: toUser(user) };
  }

  app.post("/v1/auth/register", { preHandler: byIp }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = parseOrThrow(RegisterRequest, request.body);
    const user: UserRecord = {
      id: newId(),
      email: body.email.toLowerCase(),
      displayName: body.displayName.trim(),
      passwordHash: await hashPassword(body.password),
      createdAt: ctx.now().toISOString(),
    };
    if (!(await ctx.store.createUser(user))) {
      throw new AppError("conflict", "An account with this email already exists. Sign in instead.");
    }
    reply.code(201);
    return issueSession(user);
  });

  app.post("/v1/auth/login", { preHandler: byIp }, async (request: FastifyRequest) => {
    const body = parseOrThrow(LoginRequest, request.body);
    // Per account as well as per IP: guessing one account's password from many IPs is limited too.
    // Counted whether or not the account exists, so the limit itself reveals nothing.
    const perAccount = await ctx.rateLimits.consume("login", `login:${body.email.trim().toLowerCase()}`);
    if (!perAccount.allowed) {
      throw new AppError("rate_limited", "Too many sign-in attempts for this account. Please wait and try again.", {
        retryAfterSeconds: Math.max(1, Math.ceil(perAccount.retryAfterMs / 1000)),
      });
    }
    const user = await ctx.store.findUserByEmail(body.email);
    const ok = user
      ? await verifyPassword(body.password, user.passwordHash)
      : (await verifyPassword(body.password, await DUMMY_HASH_PROMISE), false);
    if (!user || !ok) throw new AppError("unauthorized", "Email or password is incorrect.");
    if (needsRehash(user.passwordHash)) {
      // Upgrade hashes made with an older cost while the plaintext is at hand. Never blocks sign-in.
      try {
        await ctx.store.replacePasswordHash(user.id, user.passwordHash, await hashPassword(body.password));
      } catch (err) {
        request.log.warn({ err }, "could not upgrade password hash");
      }
    }
    return issueSession(user);
  });

  app.post("/v1/auth/logout", { preHandler: ctx.requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.authTokenHash) await ctx.store.deleteSession(request.authTokenHash);
    reply.code(204);
  });

  /** Signs out every device, this one included (for a lost phone or a leaked token). */
  app.post("/v1/auth/logout-all", { preHandler: ctx.requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = currentUser(request);
    const removed = await ctx.store.deleteSessionsForUser(user.id);
    request.log.info({ event: "sessions_revoked", count: removed }, "signed out everywhere");
    reply.code(204);
  });
}
