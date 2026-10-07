import {
  SYNC_PAGE_LIMIT,
  SyncPushRequest,
  type SyncConversationsResponse,
  type SyncOperation,
  type SyncOperationResult,
  type SyncPushResponse,
} from "@dash-ai/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { currentUser } from "../auth/requireAuth.js";
import { DEFAULT_TITLE } from "../chat/titles.js";
import { AppError, parseOrThrow } from "../errors.js";
import type { MessageRecord } from "../store/store.js";
import type { RouteContext } from "./context.js";
import { toSyncChange, viewFor } from "./mappers.js";

const Query = z.object({
  cursor: z.string().regex(/^\d{1,15}$/, "cursor must be a non-negative integer").default("0"),
  limit: z.coerce.number().int().min(1).max(SYNC_PAGE_LIMIT.max).default(SYNC_PAGE_LIMIT.default),
});

/** Device clocks drift: timestamps from the future are clamped to the server's "now" plus this much. */
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
// 100 messages of up to 32,000 characters (multi-byte) fit with headroom.
const PUSH_BODY_LIMIT = 16 * 1024 * 1024;

export function syncRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const syncLimit = ctx.rateLimit("sync", (r) => `sync:${r.authUser?.id ?? r.ip}`);

  /**
   * Conversation changes after `cursor`, oldest first, for the signed-in user only. Each change
   * carries the whole conversation (or a tombstone), so clients can apply pages idempotently.
   */
  app.get("/v1/sync/conversations", { preHandler: [ctx.requireAuth, syncLimit] }, async (request: FastifyRequest): Promise<SyncConversationsResponse> => {
    const user = currentUser(request);
    const { cursor, limit } = parseOrThrow(Query, request.query, "sync query");
    const after = Number(cursor);
    const [page, latest] = [await ctx.store.listConversationChanges(user.id, after, limit), await ctx.store.latestSyncSeq(user.id)];
    const last = page.changes.at(-1);
    return {
      changes: page.changes.map((c) => toSyncChange(c, viewFor(ctx.config))),
      cursor: String(last ? last.seq : after),
      latest: String(latest),
      hasMore: page.hasMore,
    };
  });

  /**
   * Device → server changes: upload a locally created conversation (user messages only), rename with
   * a base title revision, delete. Operations run in order, each atomically, and every one is
   * idempotent, so a retried or duplicated request can never duplicate or resurrect anything.
   * Everything is scoped to the signed-in user; another account's ids are rejected without detail.
   */
  app.post(
    "/v1/sync/push",
    { preHandler: [ctx.requireAuth, syncLimit], bodyLimit: PUSH_BODY_LIMIT },
    async (request: FastifyRequest): Promise<SyncPushResponse> => {
      const user = currentUser(request);
      const body = parseOrThrow(SyncPushRequest, request.body, "sync push");
      if (new Set(body.operations.map((o) => o.opId)).size !== body.operations.length) {
        throw new AppError("bad_request", "Invalid sync push. Operation ids must be unique within a request.");
      }
      const results: SyncOperationResult[] = [];
      for (const op of body.operations) results.push(await apply(user.id, op));
      // Metadata only: operation types and outcomes, never titles or message text.
      request.log.info(
        { event: "sync_push", operations: results.length, outcomes: results.map((r, i) => `${body.operations[i]!.type}:${r.status}`).join(",") },
        "sync push",
      );
      return { results };
    },
  );

  async function apply(userId: string, op: SyncOperation): Promise<SyncOperationResult> {
    const now = ctx.now();
    const clamp = (iso: string) => new Date(Math.min(Date.parse(iso), now.getTime() + MAX_CLOCK_SKEW_MS)).toISOString();
    switch (op.type) {
      case "upload": {
        const c = op.conversation;
        const seen = new Set<string>();
        const messages: MessageRecord[] = op.messages
          .filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
          .map((m) => ({
            id: m.id,
            conversationId: c.id,
            // Devices can only contribute their user's own words: provenance labels stay server-made.
            role: "user" as const,
            content: m.content,
            origin: null,
            model: null,
            demo: false,
            status: "complete" as const,
            compareGroupId: null,
            attachmentIds: [],
            createdAt: clamp(m.createdAt),
          }))
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
        const createdAt = clamp(c.createdAt);
        const newest = messages.at(-1)?.createdAt ?? createdAt;
        const title = c.title.trim() === "" ? DEFAULT_TITLE : c.title.trim();
        const result = await ctx.store.pushConversation(userId, {
          conversation: {
            id: c.id,
            userId,
            title,
            titleIsCustom: c.titleIsCustom && title !== DEFAULT_TITLE,
            mode: c.mode,
            createdAt,
            updatedAt: newest > createdAt ? newest : createdAt,
          },
          messages,
        });
        const status = result.status === "created" || result.status === "merged" ? "applied" : result.status;
        return { opId: op.opId, status, appended: result.appended, skipped: result.skipped };
      }
      case "rename": {
        const result = await ctx.store.renameConversationIfCurrent(userId, op.conversationId, op.title, op.baseTitleRev, now.toISOString());
        return { opId: op.opId, status: result.status };
      }
      case "delete": {
        const state = await ctx.store.conversationState(userId, op.conversationId);
        if (state === "absent") return { opId: op.opId, status: "not_found" };
        if (state === "live") await ctx.store.deleteConversation(userId, op.conversationId);
        return { opId: op.opId, status: "applied" };
      }
    }
  }
}
