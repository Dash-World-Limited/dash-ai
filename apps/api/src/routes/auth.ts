import { LoginRequest, RegisterRequest, type AuthResponse } from "@dash-ai/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AppError, parseOrThrow } from "../errors.js";
import { hashPassword, hashToken, newId, newSessionToken, verifyPassword } from "../security/crypto.js";
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
    const user = await ctx.store.findUserByEmail(body.email);
    const ok = user
      ? await verifyPassword(body.password, user.passwordHash)
      : (await verifyPassword(body.password, await DUMMY_HASH_PROMISE), false);
    if (!user || !ok) throw new AppError("unauthorized", "Email or password is incorrect.");
    return issueSession(user);
  });

  app.post("/v1/auth/logout", { preHandler: ctx.requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.authTokenHash) await ctx.store.deleteSession(request.authTokenHash);
    reply.code(204);
  });
}
