import { AUTOMATION_LIMITS, type DataExportResponse, type MeResponse, type ProviderId, type UsageSummaryResponse } from "@dash-ai/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { currentUser } from "../auth/requireAuth.js";
import { toRun } from "../automations/service.js";
import type { RouteContext } from "./context.js";
import { viewFor, toConversation, toDocument, toMessage, toPluginSetting, toMessageToolActivity, toToolActivity, toUsage, toUser } from "./mappers.js";

export function accountRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const auth = { preHandler: ctx.requireAuth };

  app.get("/v1/me", auth, async (request: FastifyRequest): Promise<MeResponse> => ({ user: toUser(currentUser(request)) }));

  /**
   * Deletes the account and everything stored for it. Its active streams, on every instance, are
   * cancelled first, and no new one is admitted.
   */
  app.delete("/v1/me", auth, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = currentUser(request);
    await ctx.streams.cancelAllForUser(user.id);
    await ctx.store.deleteUserData(user.id);
    request.log.info({ event: "account_deleted" }, "account deleted");
    reply.code(204);
  });

  /** Data portability: everything the server stores for this user. */
  app.get("/v1/me/export", auth, async (request: FastifyRequest): Promise<DataExportResponse> => {
    const user = currentUser(request);
    const view = viewFor(ctx.config);
    const conversations = await ctx.store.listConversations(user.id);
    const details = await Promise.all(
      conversations.map(async (c) => ({
        conversation: toConversation(c),
        messages: (await ctx.store.listMessages(c.id)).map((m) => toMessage(m, view)),
        toolActivity: (await ctx.store.listConversationToolInvocations(user.id, c.id)).map(toMessageToolActivity),
      })),
    );
    return {
      exportedAt: ctx.now().toISOString(),
      user: toUser(user),
      conversations: details,
      documents: (await ctx.store.listDocuments(user.id)).map(toDocument),
      usage: (await ctx.store.listUsage(user.id)).map((u) => toUsage(u, view)),
      plugins: (await ctx.store.getPluginSettings(user.id)).map(toPluginSetting),
      toolActivity: (await ctx.store.listToolInvocations(user.id, 1000)).map((t) => toToolActivity(t, view)),
      automations: await Promise.all(
        (await ctx.store.listAutomations(user.id)).map(async (a) => ({
          automation: await ctx.automations.view(a),
          runs: (await ctx.store.listRuns(user.id, a.id, AUTOMATION_LIMITS.maxRunsKept)).map(toRun),
        })),
      ),
    };
  });

  app.get("/v1/usage", auth, async (request: FastifyRequest): Promise<UsageSummaryResponse> => {
    const rows = await ctx.store.listUsage(currentUser(request).id);
    const view = viewFor(ctx.config);
    // Production: one DASH AI total. Diagnostics mode: one row per provider.
    const totals = new Map<ProviderId | "dash", { requests: number; inputTokens: number; outputTokens: number }>();
    for (const r of rows) {
      const key = view.hidden ? "dash" : r.provider;
      const t = totals.get(key) ?? { requests: 0, inputTokens: 0, outputTokens: 0 };
      t.requests += 1;
      t.inputTokens += r.inputTokens ?? 0;
      t.outputTokens += r.outputTokens ?? 0;
      totals.set(key, t);
    }
    return {
      totals: [...totals.entries()].map(([key, t]) => (key === "dash" ? { ...t } : { provider: key, ...t })),
      recent: rows.slice(-50).reverse().map((u) => toUsage(u, view)),
    };
  });
}
