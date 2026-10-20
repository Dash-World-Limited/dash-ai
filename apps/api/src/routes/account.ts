import { AUTOMATION_LIMITS, type DataExportResponse, type MeResponse, type UsageSummaryResponse } from "@dash-ai/contracts";
import { Readable } from "node:stream";
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

  /**
   * Data portability: everything the server stores for this user, as one JSON document. It is
   * streamed: conversations are read 200 at a time and written out as they are read, so an export's
   * memory no longer grows with the account (measured before: 5,000 conversations / 100,000 messages
   * ≈ 174 MB of JSON held at once, +226 MB of heap). Only a few run at once per instance; more are
   * refused as busy. A failure part-way cuts the response short, so the client can never mistake a
   * partial export for a complete one (the JSON does not parse).
   */
  let exporting = 0;
  const EXPORTS_AT_ONCE = 2;
  const EXPORT_BATCH = 200;
  app.get("/v1/me/export", { preHandler: [ctx.requireAuth, exportLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (exporting >= EXPORTS_AT_ONCE) {
      ctx.metrics.busyRejections.inc({ reason: "export" });
      throw busyError();
    }
    exporting += 1;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      exporting -= 1;
    };
    reply.raw.once("close", finish);
    const user = currentUser(request);
    const body = Readable.from(exportAccount(user), { objectMode: false });
    body.once("error", (err) => {
      request.log.error({ err }, "export failed part-way");
      finish();
    });
    return reply.type("application/json; charset=utf-8").send(body);
  });

  /** The export's JSON text, piece by piece (same document as DataExportResponse). */
  async function* exportAccount(user: ReturnType<typeof currentUser>): AsyncGenerator<string> {
    const view = viewFor(ctx.config);
    const head: Pick<DataExportResponse, "exportedAt" | "user"> = { exportedAt: ctx.now().toISOString(), user: toUser(user) };
    yield `${JSON.stringify(head).slice(0, -1)},"conversations":[`;
    const conversations = await ctx.store.listConversations(user.id);
    for (let i = 0; i < conversations.length; i += EXPORT_BATCH) {
      const batch = conversations.slice(i, i + EXPORT_BATCH);
      const ids = batch.map((c) => c.id);
      const [messages, tools] = await Promise.all([ctx.store.listMessagesFor(user.id, ids), ctx.store.listToolInvocationsFor(user.id, ids)]);
      const parts = batch.map((c) =>
        JSON.stringify({
          conversation: toConversation(c),
          messages: (messages.get(c.id) ?? []).map((m) => toMessage(m, view)),
          toolActivity: (tools.get(c.id) ?? []).map(toMessageToolActivity),
        } satisfies DataExportResponse["conversations"][number]),
      );
      yield `${i === 0 ? "" : ","}${parts.join(",")}`;
    }
    const tail: Omit<DataExportResponse, "exportedAt" | "user" | "conversations"> = {
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
    yield `],${JSON.stringify(tail).slice(1)}`;
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
