import { AUTOMATION_LIMITS, type DataExportResponse, type MeResponse, type UsageSummaryResponse } from "@dash-ai/contracts";
import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { currentUser } from "../auth/requireAuth.js";
import { toRun } from "../automations/service.js";
import { busyError } from "../errors.js";
import type { ExportCursor, ExportItem, ToolInvocationRow, UsageRow } from "../store/store.js";
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
   * Data portability: everything the server stores for this user, as one JSON document
   * (DataExportResponse), streamed. Every read is a bounded keyset page, written out before the next
   * is read (Readable.from pulls only as fast as the client reads), so what one export holds at once
   * does not depend on the account's size:
   * - conversations: EXPORT_CONVERSATIONS at a time, most recently updated first;
   * - their messages: EXPORT_ROWS at a time across the page, in the store's order (by conversation
   *   id, then position), each conversation written as soon as its messages are; a very long
   *   conversation is never held whole;
   * - their tool calls: one read of at most EXPORT_ROWS for the page; a page with more is read per
   *   conversation, EXPORT_ROWS at a time;
   * - usage history: EXPORT_ROWS at a time;
   * - documents (DOCUMENTS_MAX_PER_ACCOUNT), automations with their kept runs (AUTOMATIONS_MAX_PER_USER,
   *   maxRunsKept), plugin settings and the latest 1,000 tool calls are capped already and read whole.
   * Measured before (each section read whole): 200,000 usage rows +207 MB of heap, one conversation
   * of 10,000 messages +44 MB. Only a few exports run at once per instance; more are refused as busy.
   *
   * Within a page, conversations are written in message order, those without messages last. It is a
   * read, not a snapshot: a conversation changed while its export runs may be left out of that
   * export or appear without its newest messages (never twice). If the export fails part-way, or the
   * account is deleted before it ends, the response is cut short, so a client can never mistake it
   * for a complete export (the JSON does not parse).
   */
  let exporting = 0;
  const EXPORTS_AT_ONCE = 2;
  const EXPORT_CONVERSATIONS = 100;
  const EXPORT_ROWS = 200;
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
      if (err instanceof AccountGone) request.log.info({ event: "export_cut_short" }, "account deleted during export");
      else request.log.error({ err }, "export failed part-way");
      finish();
    });
    return reply.type("application/json; charset=utf-8").send(body);
  });

  /** Every row of one keyset read, page by page (EXPORT_ROWS at a time). */
  async function* rows<T>(read: (after: ExportCursor | null) => Promise<Array<ExportItem<T>>>): AsyncGenerator<ExportItem<T>> {
    let after: ExportCursor | null = null;
    for (;;) {
      const page = await read(after);
      yield* page;
      if (page.length < EXPORT_ROWS) return;
      after = page[page.length - 1]!.cursor;
    }
  }

  /** Rows as the inside of a JSON array, one page per piece. */
  async function* jsonList<T>(read: (after: ExportCursor | null) => Promise<Array<ExportItem<T>>>, show: (item: T) => unknown): AsyncGenerator<string> {
    let first = true;
    let piece: string[] = [];
    for await (const r of rows(read)) {
      piece.push(JSON.stringify(show(r.item)));
      if (piece.length === EXPORT_ROWS) {
        yield `${first ? "" : ","}${piece.join(",")}`;
        first = false;
        piece = [];
      }
    }
    if (piece.length) yield `${first ? "" : ","}${piece.join(",")}`;
  }

  /** The export's JSON text, piece by piece (same document as DataExportResponse). */
  async function* exportAccount(user: ReturnType<typeof currentUser>): AsyncGenerator<string> {
    const view = viewFor(ctx.config);
    const head: Pick<DataExportResponse, "exportedAt" | "user"> = { exportedAt: ctx.now().toISOString(), user: toUser(user) };
    yield `${JSON.stringify(head).slice(0, -1)},"conversations":[`;
    let firstConversation = true;
    let after: ExportCursor | null = null;
    for (;;) {
      const page = await ctx.store.exportConversations(user.id, after, EXPORT_CONVERSATIONS);
      if (page.length === 0) break;
      const byId = new Map(page.map((p) => [p.item.id, p.item]));
      const ids = [...byId.keys()];
      // Tool calls are few: usually the whole page's fit in one read; otherwise read per conversation.
      const pageTools = await ctx.store.exportToolInvocations(user.id, ids, null, EXPORT_ROWS + 1);
      const toolsBy = new Map<string, ToolInvocationRow[]>();
      if (pageTools.length <= EXPORT_ROWS) {
        for (const t of pageTools) {
          const list = toolsBy.get(t.cursor.conversationId!);
          if (list) list.push(t.item);
          else toolsBy.set(t.cursor.conversationId!, [t.item]);
        }
      }
      const open = (id: string) => {
        const piece = `${firstConversation ? "" : ","}{"conversation":${JSON.stringify(toConversation(byId.get(id)!))},"messages":[`;
        firstConversation = false;
        return piece;
      };
      const close = async function* (id: string): AsyncGenerator<string> {
        yield `],"toolActivity":[`;
        if (pageTools.length <= EXPORT_ROWS) yield (toolsBy.get(id) ?? []).map((t) => JSON.stringify(toMessageToolActivity(t))).join(",");
        else yield* jsonList((a) => ctx.store.exportToolInvocations(user.id, [id], a, EXPORT_ROWS), toMessageToolActivity);
        yield "]}";
      };
      const written = new Set<string>();
      let current: string | undefined;
      let piece: string[] = [];
      let firstMessage = true;
      const flush = () => {
        const out = `${firstMessage || piece.length === 0 ? "" : ","}${piece.join(",")}`;
        if (piece.length) firstMessage = false;
        piece = [];
        return out;
      };
      for await (const m of rows((a) => ctx.store.exportMessages(user.id, ids, a, EXPORT_ROWS))) {
        const id = m.cursor.conversationId!;
        if (id !== current) {
          if (current !== undefined) {
            yield flush();
            yield* close(current);
          }
          current = id;
          written.add(id);
          firstMessage = true;
          yield open(id);
        }
        piece.push(JSON.stringify(toMessage(m.item, view)));
        // A long conversation: write what is held and keep going.
        if (piece.length === EXPORT_ROWS) yield flush();
      }
      if (current !== undefined) {
        yield flush();
        yield* close(current);
      }
      for (const id of ids) {
        if (written.has(id)) continue;
        yield open(id);
        yield* close(id);
      }
      if (page.length < EXPORT_CONVERSATIONS) break;
      after = page[page.length - 1]!.cursor;
    }
    yield `],"documents":${JSON.stringify((await ctx.store.listDocuments(user.id)).map(toDocument))},"usage":[`;
    yield* jsonList((a) => ctx.store.exportUsage(user.id, a, EXPORT_ROWS), (u: UsageRow) => toUsage(u, view));
    const automations = await Promise.all(
      (await ctx.store.listAutomations(user.id)).map(async (a) => ({
        automation: await ctx.automations.view(a),
        runs: (await ctx.store.listRuns(user.id, a.id, AUTOMATION_LIMITS.maxRunsKept)).map(toRun),
      })),
    );
    const tail: Pick<DataExportResponse, "plugins" | "toolActivity" | "automations"> = {
      plugins: (await ctx.store.getPluginSettings(user.id)).map(toPluginSetting),
      toolActivity: (await ctx.store.listToolInvocations(user.id, 1000)).map((t) => toToolActivity(t, view)),
      automations,
    };
    // Deleted while being exported: cut the response short rather than close a document that
    // would parse but is missing what the deletion removed.
    if (!(await ctx.store.findUserById(user.id))) throw new AccountGone();
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

class AccountGone extends Error {
  constructor() {
    super("account deleted during export");
  }
}
