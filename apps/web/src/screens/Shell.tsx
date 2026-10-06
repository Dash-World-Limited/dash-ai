import type { Conversation } from "@dash-ai/contracts";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { LIMITS } from "@dash-ai/contracts";
import { groupHistory, initials } from "../logic/presentation";
import { useApp, useNow } from "../state/app";
import { navigate, useRoute } from "../state/router";
import { useStore } from "../state/store";
import { Icon, type IconName } from "../ui/icons";
import { BrandMark, Confirm, DemoBadge, Dialog, Wordmark } from "../ui/kit";

/** Sidebar (history and destinations) beside the main column; on phones it slides in over the page. */
export function Shell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const { path } = useRoute();
  useEffect(() => setOpen(false), [path]);
  return (
    <div className={`shell${open ? " open" : ""}`}>
      <Sidebar onClose={() => setOpen(false)} />
      <div className="scrim" onClick={() => setOpen(false)} />
      <MenuContext.Provider value={() => setOpen(true)}>
        <div className="main">{children}</div>
      </MenuContext.Provider>
    </div>
  );
}

const MenuContext = createContext<() => void>(() => undefined);

export function MenuButton() {
  const openMenu = useContext(MenuContext);
  return (
    <button className="icon-btn menu-toggle" onClick={openMenu} aria-label="Open menu and chat history" data-testid="open-menu">
      <Icon name="menu" />
    </button>
  );
}

export function TopBar({ title, back, actions, children }: { title?: string; back?: boolean; actions?: ReactNode; children?: ReactNode }) {
  return (
    <header className="topbar">
      {back ? (
        <button className="icon-btn" onClick={() => history.length > 1 ? history.back() : navigate("/")} aria-label="Back">
          <Icon name="back" />
        </button>
      ) : (
        <MenuButton />
      )}
      {children ?? <h1 className="grow ellipsis">{title}</h1>}
      {actions}
    </header>
  );
}

function NavItem({ icon, label, to, testId }: { icon: IconName; label: string; to: string; testId: string }) {
  const { path } = useRoute();
  const current = to === "/" ? path === "/" : path.startsWith(to);
  return (
    <button className="nav-item" aria-current={current ? "page" : undefined} onClick={() => navigate(to)} data-testid={testId}>
      <Icon name={icon} />
      {label}
    </button>
  );
}

function Sidebar({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const settings = useStore(app.settings);
  const { items, loading, error } = useStore(app.conversations);
  const engine = useStore(app.engineStore);
  const now = useNow();
  const [query, setQuery] = useState("");
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<Conversation | null>(null);
  const [deleting, setDeleting] = useState<Conversation | null>(null);
  const filtered = query.trim() ? items.filter((c) => c.title.toLowerCase().includes(query.trim().toLowerCase())) : items;
  const groups = groupHistory(filtered, now);
  const account = settings.account;

  return (
    <nav className="sidebar" aria-label="Chats and destinations" data-testid="sidebar">
      <div className="sidebar-head">
        <button className="row" style={{ background: "none", border: "none", cursor: "pointer", gap: 8, padding: 0 }} onClick={() => navigate("/")} aria-label="DASH AI home">
          <BrandMark size={22} />
          <Wordmark />
          {settings.demoMode && <DemoBadge />}
        </button>
        <button className="icon-btn menu-toggle" onClick={onClose} aria-label="Close menu">
          <Icon name="close" />
        </button>
      </div>
      <div style={{ padding: "4px 8px 8px" }}>
        <button
          className="nav-item"
          style={{ fontWeight: 600 }}
          data-testid="new-chat"
          onClick={() => {
            app.engine.newChat();
            navigate("/chat");
          }}
        >
          <span style={{ color: "var(--accent-ink)", display: "inline-flex" }}>
            <Icon name="newChat" />
          </span>
          New chat
        </button>
        <div style={{ position: "relative", marginTop: 6 }}>
          <span style={{ position: "absolute", left: 12, top: 14, color: "var(--ink-3)" }}>
            <Icon name="search" size={18} />
          </span>
          <input className="input" placeholder="Search chats" aria-label="Search chats" value={query} onChange={(e) => setQuery(e.target.value)} style={{ paddingLeft: 38, minHeight: 44 }} data-testid="history-search" />
        </div>
      </div>
      <div className="sidebar-body" data-testid="history">
        {error && <p className="small" style={{ color: "var(--error)", padding: "8px 12px" }}>{error}</p>}
        {!loading && groups.length === 0 && (
          <p className="small muted" style={{ padding: "8px 12px" }} data-testid="history-empty">
            {query.trim() ? `No chats match “${query.trim()}”.` : "No chats yet. Start one and it will appear here."}
          </p>
        )}
        {groups.map((g) => (
          <section key={g.section} aria-label={g.section}>
            <h2 className="history-head">{g.section}</h2>
            {g.items.map((c) => (
              <div className="history-item" key={c.id}>
                <button
                  className="nav-item"
                  aria-current={engine.conversation?.id === c.id ? "page" : undefined}
                  onClick={() => {
                    void app.engine.open(c.id);
                    navigate(`/chat/${c.id}`);
                  }}
                  data-testid="history-item"
                >
                  <span className="grow ellipsis">{c.title}</span>
                </button>
                <button className="icon-btn more" aria-label={`Options for ${c.title}`} aria-expanded={menuFor === c.id} onClick={() => setMenuFor(menuFor === c.id ? null : c.id)}>
                  <Icon name="more" />
                </button>
                {menuFor === c.id && (
                  <div className="menu" role="menu" onMouseLeave={() => setMenuFor(null)}>
                    <button role="menuitem" onClick={() => (setRenaming(c), setMenuFor(null))}>
                      <Icon name="edit" size={18} /> Rename
                    </button>
                    <button role="menuitem" style={{ color: "var(--error)" }} onClick={() => (setDeleting(c), setMenuFor(null))}>
                      <Icon name="trash" size={18} /> Delete
                    </button>
                  </div>
                )}
              </div>
            ))}
          </section>
        ))}
      </div>
      <div className="sidebar-foot">
        <NavItem icon="home" label="Home" to="/" testId="nav-home" />
        <NavItem icon="folder" label="Documents" to="/documents" testId="nav-documents" />
        <NavItem icon="library" label="Prompt library" to="/prompts" testId="nav-prompts" />
        <NavItem icon="puzzle" label="Tools & Connections" to="/tools" testId="nav-tools" />
        <NavItem icon="settings" label="Settings" to="/settings" testId="nav-settings" />
        <button className="nav-item" onClick={() => navigate("/account")} aria-current={location.pathname === "/account" ? "page" : undefined} data-testid="nav-account">
          <span className="avatar" aria-hidden="true" style={{ width: 28, height: 28, borderRadius: "50%", display: "grid", placeItems: "center", background: "var(--accent-container)", fontSize: 12, fontWeight: 600 }}>
            {initials(account?.displayName, account?.email) ?? <Icon name="user" size={16} />}
          </span>
          <span className="grow ellipsis">{account ? account.displayName : "Demo Mode"}</span>
        </button>
      </div>
      {renaming && <RenameDialog conversation={renaming} onClose={() => setRenaming(null)} />}
      {deleting && (
        <Confirm
          title="Delete this chat?"
          text={`“${deleting.title}” will be removed${settings.demoMode ? " from this browser" : " from your account on every device"}.`}
          confirm="Delete"
          destructive
          onClose={() => setDeleting(null)}
          onConfirm={() => {
            const id = deleting.id;
            setDeleting(null);
            void app.deleteConversation(id);
          }}
        />
      )}
    </nav>
  );
}

function RenameDialog({ conversation, onClose }: { conversation: Conversation; onClose: () => void }) {
  const app = useApp();
  const [title, setTitle] = useState(conversation.title);
  return (
    <Dialog title="Rename chat" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim()) return;
          onClose();
          void app.renameConversation(conversation.id, title.trim());
        }}
      >
        <div className="field">
          <label htmlFor="rename">Title</label>
          <input id="rename" className="input" value={title} maxLength={LIMITS.maxTitleChars} onChange={(e) => setTitle(e.target.value)} data-testid="rename-input" />
        </div>
        <div className="actions">
          <button type="button" className="btn btn-text" style={{ color: "var(--ink-2)" }} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!title.trim()}>
            Save
          </button>
        </div>
      </form>
    </Dialog>
  );
}
