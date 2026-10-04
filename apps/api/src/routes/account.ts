import type { DataExportResponse, MeResponse, ProviderId, UsageSummaryResponse } from "@dash-ai/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { currentUser } from "../auth/requireAuth.js";
import type { RouteContext } from "./context.js";
import { toConversation, toDocument, toMessage, toPluginSetting, toToolActivity, toUsage, toUser } from "./mappers.js";

export function accountRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const auth = { preHandler: ctx.requireAuth };

  app.get("/v1/me", auth, async (request: FastifyRequest): Promise<MeResponse> => ({ user: toUser(currentUser(request)) }));

  /** Deletes the account and everything stored for it. Active streams are cancelled first. */
  app.delete("/v1/me", auth, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = currentUser(request);
    ctx.streams.cancelAllForUser(user.id);
    await ctx.store.deleteUserData(user.id);
    request.log.info({ event: "account_deleted" }, "account deleted");
    reply.code(204);
  });

  /** Data portability: everything the server stores for this user. */
  app.get("/v1/me/export", auth, async (request: FastifyRequest): Promise<DataExportResponse> => {
    const user = currentUser(request);
    const conversations = await ctx.store.listConversations(user.id);
    const details = await Promise.all(
      conversations.map(async (c) => ({
        conversation: toConversation(c),
        messages: (await ctx.store.listMessages(c.id)).map(toMessage),
      })),
    );
    return {
      exportedAt: ctx.now().toISOString(),
      user: toUser(user),
      conversations: details,
      documents: (await ctx.store.listDocuments(user.id)).map(toDocument),
      usage: (await ctx.store.listUsage(user.id)).map(toUsage),
      plugins: (await ctx.store.getPluginSettings(user.id)).map(toPluginSetting),
      toolActivity: (await ctx.store.listToolInvocations(user.id, 1000)).map(toToolActivity),
    };
  });

  app.get("/v1/usage", auth, async (request: FastifyRequest): Promise<UsageSummaryResponse> => {
    const rows = await ctx.store.listUsage(currentUser(request).id);
    const totals = new Map<ProviderId, { requests: number; inputTokens: number; outputTokens: number }>();
    for (const r of rows) {
      const t = totals.get(r.provider) ?? { requests: 0, inputTokens: 0, outputTokens: 0 };
      t.requests += 1;
      t.inputTokens += r.inputTokens ?? 0;
      t.outputTokens += r.outputTokens ?? 0;
      totals.set(r.provider, t);
    }
    return {
      totals: [...totals.entries()].map(([provider, t]) => ({ provider, ...t })),
      recent: rows.slice(-50).reverse().map(toUsage),
    };
  });
}
