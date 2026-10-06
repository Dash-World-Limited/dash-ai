import type { PluginsResponse } from "@dash-ai/contracts";
import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../api/client";
import { toolConnection, toolLabel, type ToolConnection } from "../logic/presentation";
import { useApp } from "../state/app";
import { navigate } from "../state/router";
import { useStore } from "../state/store";
import { Icon } from "../ui/icons";
import { Badge, Empty, Loading, Notice, Switch } from "../ui/kit";
import { TopBar } from "./Shell";

/** The server's real plugin registry (GET /v1/plugins). Nothing here is invented in the browser. */
export function ToolsScreen() {
  const app = useApp();
  const settings = useStore(app.settings);
  const signedIn = !settings.demoMode && settings.account !== null;
  const [data, setData] = useState<PluginsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await app.api.plugins());
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't load tools.");
    }
  }, [app]);
  useEffect(() => {
    if (signedIn) void load();
  }, [signedIn, load]);

  const toggle = async (c: ToolConnection, enabled: boolean) => {
    if (busy) return;
    setBusy(c.plugin.id);
    setActionError(null);
    try {
      const updated = await app.api.setPlugin(c.plugin.id, enabled, enabled && c.state === "Requires permission" ? c.scopesToGrant : undefined);
      setData((d) => (d ? { ...d, plugins: d.plugins.map((p) => (p.id === updated.id ? updated : p)) } : d));
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : "Couldn't change this tool.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <TopBar title="Tools & Connections" />
      <div className="content">
        <main className="reading stack" style={{ paddingBottom: 48 }} data-testid="tools">
          <p className="muted" style={{ margin: 0, fontSize: 17 }}>Connect tools to give DASH AI access to the information and actions you choose.</p>
          {!signedIn ? (
            <Empty icon="puzzle" title="Sign in to use tools" testId="tools-signed-out" action={<button className="btn btn-primary" onClick={() => navigate("/sign-in")}>Sign in</button>}>
              Tools run on your DASH AI server for your account. Demo Mode doesn't use any tools.
            </Empty>
          ) : error ? (
            <Notice tone="error" action={{ label: "Try again", onClick: () => void load() }}>{error}</Notice>
          ) : !data ? (
            <Loading label="Loading tools…" />
          ) : (
            <>
              {!data.toolsEnabled && <Notice tone="warning">Tools are turned off on this server. Your choices are kept for when they're turned on.</Notice>}
              {actionError && <Notice tone="error">{actionError}</Notice>}
              {data.plugins.length === 0 && <Empty icon="puzzle" title="No tools available">This server doesn't offer any tools yet.</Empty>}
              {data.plugins.map((p) => {
                const c = toolConnection(p, data.toolsEnabled);
                return (
                  <section key={p.id} className="card card-pad stack" data-testid="tool-connection">
                    <div className="row">
                      <div className="grow">
                        <h2 style={{ margin: 0, fontSize: 17 }}>{p.name}</h2>
                        <div className="row" style={{ gap: 8, marginTop: 6 }}>
                          <Badge text={c.state} tone={c.tone} />
                          {p.kind === "builtin" && <span className="small faint">Built in</span>}
                        </div>
                      </div>
                      <Switch checked={p.enabled && c.state !== "Requires permission"} disabled={!c.canToggle || busy !== null} onChange={(v) => void toggle(c, v)} label={`${p.name}: ${c.state}`} testId={`tool-switch-${p.id}`} />
                    </div>
                    <p style={{ margin: 0 }} className="muted">{p.description}</p>
                    <p style={{ margin: 0 }} className="small faint">{c.detail}</p>
                    {c.state === "Requires permission" && (
                      <button className="btn btn-primary" style={{ justifySelf: "start" }} disabled={busy !== null} onClick={() => void toggle(c, true)}>Allow access</button>
                    )}
                    {p.tools.length > 0 && (
                      <div>
                        <div className="small faint" style={{ marginBottom: 6 }}>Tools</div>
                        {p.tools.map((t) => (
                          <div key={t.name} style={{ padding: "4px 0" }}>
                            <span>{toolLabel(t.name)}</span>
                            {!t.executable && <span className="small faint"> · not available yet</span>}
                            <div className="small muted">{t.description}</div>
                          </div>
                        ))}
                      </div>
                    )}
                    {p.scopes.length > 0 && (
                      <div>
                        <div className="small faint" style={{ marginBottom: 6 }}>Access</div>
                        {p.scopes.map((s) => (
                          <div key={s.id} className="row small muted" style={{ gap: 8, padding: "2px 0" }}>
                            <Icon name={s.risk === "read" ? "eye" : "warning"} size={16} />
                            {s.description} {s.risk === "read" ? "(read only)" : "(changes data)"}
                            {p.grantedScopes.includes(s.id) ? " · allowed" : ""}
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                );
              })}
              <p className="small faint">Only names and outcomes of tool use are shown in chats. Tool inputs and results stay on the server.</p>
            </>
          )}
        </main>
      </div>
    </>
  );
}
