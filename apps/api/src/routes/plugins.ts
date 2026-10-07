import {
  PluginId,
  UpdatePluginRequest,
  type PluginInfo,
  type PluginsResponse,
  type ToolActivityResponse,
} from "@dash-ai/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { currentUser } from "../auth/requireAuth.js";
import { AppError, parseOrThrow } from "../errors.js";
import type { PluginSettingRecord } from "../store/store.js";
import type { RouteContext } from "./context.js";
import { toToolActivity, viewFor } from "./mappers.js";

export function pluginRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const auth = { preHandler: ctx.requireAuth };
  const { tools } = ctx;

  const describe = async (userId: string): Promise<PluginInfo[]> =>
    tools.registry.describe(await ctx.store.getPluginSettings(userId));

  app.get("/v1/plugins", auth, async (request: FastifyRequest): Promise<PluginsResponse> => ({
    toolsEnabled: tools.enabled,
    plugins: await describe(currentUser(request).id),
  }));

  /** Enables or disables one plugin for the signed-in user and sets which scopes they grant. */
  app.put("/v1/plugins/:id", auth, async (request: FastifyRequest): Promise<PluginInfo> => {
    const user = currentUser(request);
    const { id } = parseOrThrow(z.object({ id: PluginId }), request.params, "plugin id");
    const body = parseOrThrow(UpdatePluginRequest, request.body);
    const plugin = tools.registry.getPlugin(id);
    if (!plugin) throw new AppError("not_found", "Plugin not found.");

    const declared = new Map(plugin.scopes.map((s) => [s.id, s]));
    const requested = body.grantedScopes ?? plugin.scopes.filter((s) => s.risk === "read").map((s) => s.id);
    const unknown = requested.filter((s) => !declared.has(s));
    if (unknown.length > 0) throw new AppError("bad_request", "One or more scopes are not offered by this plugin.");

    const setting: PluginSettingRecord = {
      pluginId: id,
      enabled: body.enabled,
      grantedScopes: [...new Set(requested)].sort(),
      updatedAt: ctx.now().toISOString(),
    };
    await ctx.store.savePluginSetting(user.id, setting);
    // Metadata only: which plugin, not the user's data.
    request.log.info({ event: "plugin_updated", plugin: id, enabled: body.enabled, scopes: setting.grantedScopes.length }, "plugin updated");
    return (await describe(user.id)).find((p) => p.id === id)!;
  });

  app.get("/v1/tools/activity", auth, async (request: FastifyRequest): Promise<ToolActivityResponse> => ({
    activity: (await ctx.store.listToolInvocations(currentUser(request).id, 100)).map((t) => toToolActivity(t, viewFor(ctx.config))),
  }));
}
