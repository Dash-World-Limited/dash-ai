import { FILE_RULES } from "@dash-ai/contracts";
import { useRef, useState } from "react";
import { greeting, initials, QUICK_ACTIONS, type QuickAction } from "../logic/presentation";
import { useApp } from "../state/app";
import { navigate } from "../state/router";
import { useStore } from "../state/store";
import { Icon, type IconName } from "../ui/icons";
import { DemoBadge, Notice, Wordmark } from "../ui/kit";
import { MenuButton } from "./Shell";

const QUICK_ICON: Record<QuickAction["id"], IconName> = { write: "pen", file: "doc", brainstorm: "bulb", code: "code", research: "globe", tools: "puzzle" };

export function Home() {
  const app = useApp();
  const settings = useStore(app.settings);
  const online = useStore(app.online);
  const { items } = useStore(app.conversations);
  const [text, setText] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const account = settings.account;
  const canAsk = settings.demoMode || online;

  const ask = () => {
    if (!text.trim() || !canAsk) return;
    app.engine.newChat();
    app.composer.set((x) => ({ ...x, text: "", attachments: [], mode: "general" }));
    if (app.engine.send(text.trim(), "general")) navigate("/chat");
    setText("");
  };

  const quick = (a: QuickAction) => {
    if (a.id === "tools") return navigate("/tools");
    if (a.id === "file") return fileInput.current?.click();
    app.engine.newChat();
    app.composer.set((x) => ({ ...x, text: a.prompt, mode: a.mode, attachments: [] }));
    navigate("/chat");
  };

  return (
    <>
      <header className="topbar">
        <MenuButton />
        <div className="grow row" style={{ justifyContent: "center", gap: 8 }}>
          <Wordmark />
          {settings.demoMode && <DemoBadge />}
        </div>
        <button className="icon-btn" onClick={() => navigate("/account")} aria-label="Account" data-testid="open-account" style={{ background: "var(--accent-container)", width: 36, height: 36, fontWeight: 600, fontSize: 13, color: "var(--ink)" }}>
          {initials(account?.displayName, account?.email) ?? <Icon name="user" size={18} />}
        </button>
      </header>
      <div className="content">
        <main className="reading" data-testid="home">
          <h1 className="serif home-greeting" data-testid="greeting">
            {greeting(new Date().getHours(), account?.displayName)}
          </h1>
          <p className="muted" style={{ fontSize: 18, margin: "0 0 28px" }}>What are we building today?</p>
          <form
            className="composer row"
            style={{ padding: "8px 8px 8px 20px" }}
            onSubmit={(e) => {
              e.preventDefault();
              ask();
            }}
          >
            <input className="grow" style={{ border: "none", outline: "none", background: "transparent", minHeight: 44, fontSize: 16 }} placeholder="Ask DASH AI anything..." aria-label="Ask DASH AI anything" value={text} onChange={(e) => setText(e.target.value)} data-testid="home-input" />
            <button className="send" type="submit" disabled={!text.trim() || !canAsk} aria-label="Send" data-testid="home-send">
              <Icon name="send" size={18} />
            </button>
          </form>
          {!canAsk && (
            <div style={{ marginTop: 12 }}>
              <Notice tone="warning">You're offline. Your chats are still here; new answers need a connection.</Notice>
            </div>
          )}
          <div className="quick">
            {QUICK_ACTIONS.map((a) => (
              <button key={a.id} onClick={() => quick(a)} data-testid={`quick-${a.id}`}>
                <Icon name={QUICK_ICON[a.id]} size={18} />
                {a.label}
              </button>
            ))}
          </div>
          <input
            ref={fileInput}
            type="file"
            hidden
            accept={FILE_RULES.flatMap((r) => r.extensions.map((e) => `.${e}`)).join(",")}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              app.engine.newChat();
              app.composer.set((x) => ({ ...x, text: "", mode: "documents", attachments: [] }));
              void app.attach(f);
              navigate("/chat");
            }}
          />
          <h2 className="section-title">Recent chats</h2>
          {items.length === 0 ? (
            <div className="card card-pad" data-testid="home-empty">
              <strong>No chats yet</strong>
              <p className="muted" style={{ margin: "4px 0 0" }}>
                {settings.demoMode ? "Ask anything above. In Demo Mode answers are simulated and stay in this browser." : "Ask anything above. Your chats sync with your account and appear here."}
              </p>
            </div>
          ) : (
            <div className="card" style={{ overflow: "hidden" }}>
              {items.slice(0, 5).map((c) => (
                <button
                  key={c.id}
                  className="list-row"
                  onClick={() => {
                    void app.engine.open(c.id);
                    navigate(`/chat/${c.id}`);
                  }}
                  data-testid="recent-chat"
                >
                  <Icon name="history" size={18} />
                  <span className="grow ellipsis">{c.title}</span>
                  <span className="small faint">{new Date(c.updatedAt).toLocaleDateString()}</span>
                </button>
              ))}
            </div>
          )}
          <div style={{ height: 48 }} />
        </main>
      </div>
    </>
  );
}
