import type { FastifyRequest } from "fastify";
import { AppError } from "../errors.js";
import { hashToken } from "../security/crypto.js";
import type { Store, UserRecord } from "../store/store.js";

declare module "fastify" {
  interface FastifyRequest {
    authUser: UserRecord | null;
    authTokenHash: string | null;
  }
}

/** Resolves the bearer session token to a user, or fails with 401. */
export function makeRequireAuth(store: Store, now: () => Date) {
  return async function requireAuth(request: FastifyRequest): Promise<void> {
    const header = request.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      throw new AppError("unauthorized", "Sign in to continue.");
    }
    const tokenHash = hashToken(header.slice("Bearer ".length).trim());
    const session = await store.findSession(tokenHash);
    if (!session || Date.parse(session.expiresAt) <= now().getTime()) {
      if (session) await store.deleteSession(tokenHash);
      throw new AppError("unauthorized", "Your session has expired. Sign in again.");
    }
    const user = await store.findUserById(session.userId);
    if (!user) throw new AppError("unauthorized", "Sign in to continue.");
    request.authUser = user;
    request.authTokenHash = tokenHash;
  };
}

export function currentUser(request: FastifyRequest): UserRecord {
  if (!request.authUser) throw new AppError("unauthorized", "Sign in to continue.");
  return request.authUser;
}
