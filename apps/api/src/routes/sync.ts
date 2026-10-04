import { SYNC_PAGE_LIMIT, type SyncConversationsResponse } from "@dash-ai/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { currentUser } from "../auth/requireAuth.js";
import { parseOrThrow } from "../errors.js";
import type { RouteContext } from "./context.js";
import { toSyncChange } from "./mappers.js";

const Query = z.object({
  cursor: z.string().regex(/^\d{1,15}$/, "cursor must be a non-negative integer").default("0"),
  limit: z.coerce.number().int().min(1).max(SYNC_PAGE_LIMIT.max).default(SYNC_PAGE_LIMIT.default),
});

export function syncRoutes(app: FastifyInstance, ctx: RouteContext): void {
  /**
   * Conversation changes after `cursor`, oldest first, for the signed-in user only. Each change
   * carries the whole conversation (or a tombstone), so clients can apply pages idempotently.
   */
  app.get("/v1/sync/conversations", { preHandler: ctx.requireAuth }, async (request: FastifyRequest): Promise<SyncConversationsResponse> => {
    const user = currentUser(request);
    const { cursor, limit } = parseOrThrow(Query, request.query, "sync query");
    const after = Number(cursor);
    const [page, latest] = [await ctx.store.listConversationChanges(user.id, after, limit), await ctx.store.latestSyncSeq(user.id)];
    const last = page.changes.at(-1);
    return {
      changes: page.changes.map(toSyncChange),
      cursor: String(last ? last.seq : after),
      latest: String(latest),
      hasMore: page.hasMore,
    };
  });
}
