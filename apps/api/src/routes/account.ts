import { AUTOMATION_LIMITS, type DataExportResponse, type MeResponse, type UsageSummaryResponse } from "@dash-ai/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { currentUser } from "../auth/requireAuth.js";
import { toRun } from "../automations/service.js";
import { busyError } from "../errors.js";
import type { RouteContext } from "./context.js";
import { viewFor, toConversation, toDocument, toMessage, toPluginSetting, toMessageToolActivity, toToolActivity, toUsage, toUser } from "./mappers.js";

export function accountRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const auth = { preHandler: ctx.requireAuth };
  // Exports are heavy and rarely needed: they share the sync bucket's per-account limit.
  const exportLimit = ctx.rateLimit("sync", (r) => `export:${r.authUser?.id ?? r.ip}`);

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
  // An export holds the whole account in memory (measured: 1,000 conversations / 20,000 messages ≈
  // 35 MB of JSON and +57 MB of heap), so only a few run at once per instance; more are refused as busy.
  let exporting = 0;
  const EXPORTS_AT_ONCE = 2;
  const EXPORT_BATCH = 200;

  app.get("/v1/me/export", { preHandler: [ctx.requireAuth, exportLimit] }, async (request: FastifyRequest): Promise<DataExportResponse> => {
    if (exporting >= EXPORTS_AT_ONCE) {
      ctx.metrics.busyRejections.inc({ reason: "export" });
      throw busyError();
    }
    exporting += 1;
    try {
      return await exportAccount(currentUser(request));
    } finally {
      exporting -= 1;
    }
  });

  async function exportAccount(user: ReturnType<typeof currentUser>): Promise<DataExportResponse> {
    const view = viewFor(ctx.config);
    const conversations = await ctx.store.listConversations(user.id);
    // Messages and tool activity are read 200 conversations per query (was two queries per conversation).
    const details: DataExportResponse["conversations"] = [];
    for (let i = 0; i < conversations.length; i += EXPORT_BATCH) {
      const batch = conversations.slice(i, i + EXPORT_BATCH);
      const ids = batch.map((c) => c.id);
      const [messages, tools] = await Promise.all([ctx.store.listMessagesFor(user.id, ids), ctx.store.listToolInvocationsFor(user.id, ids)]);
      for (const c of batch) {
        details.push({
          conversation: toConversation(c),
          messages: (messages.get(c.id) ?? []).map((m) => toMessage(m, view)),
          toolActivity: (tools.get(c.id) ?? []).map(toMessageToolActivity),
        });
      }
    }
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
  }

  app.get("/v1/usage", auth, async (request: FastifyRequest): Promise<UsageSummaryResponse> => {
    // Totals are summed in the database: the response no longer reads every usage row of the account.
    const summary = await ctx.store.usageSummary(currentUser(request).id, 50);
    const view = viewFor(ctx.config);
    // Production: one DASH AI total. Diagnostics mode: one row per provider.
    const totals = view.hidden
      ? summary.totals.length === 0
        ? []
        : [summary.totals.reduce((t, r) => ({ requests: t.requests + r.requests, inputTokens: t.inputTokens + r.inputTokens, outputTokens: t.outputTokens + r.outputTokens }), { requests: 0, inputTokens: 0, outputTokens: 0 })]
      : summary.totals.map((t) => ({ provider: t.provider, requests: t.requests, inputTokens: t.inputTokens, outputTokens: t.outputTokens }));
    return { totals, recent: summary.recent.map((u) => toUsage(u, view)) };
  });
}
