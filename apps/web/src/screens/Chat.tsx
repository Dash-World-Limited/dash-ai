import type { AssistantMode } from "@dash-ai/contracts";
import { FILE_RULES, LIMITS } from "@dash-ai/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { AssistantMessage, UserMessage, type AnswerContext, type MessageActions } from "../chat/Messages";
import type { ChatMsg } from "../chat/types";
import { formatSize, MODE_ORDER, MODES, recipientLabel } from "../logic/presentation";
import { useApp } from "../state/app";
import { navigate, useRoute } from "../state/router";
import { useStore } from "../state/store";
import { Icon } from "../ui/icons";
import { Dialog, Loading, Notice } from "../ui/kit";
import { TopBar } from "./Shell";

const ACCEPT = FILE_RULES.flatMap((r) => r.extensions.map((e) => `.${e}`)).join(",");

type Item = { kind: "user"; m: ChatMsg } | { kind: "answer"; m: ChatMsg };

/** One DASH AI answer after each question. Answers kept from older chats appear in order, as DASH AI's. */
function toItems(messages: ChatMsg[]): Item[] {
  return messages.map((m) => (m.role === "user" ? { kind: "user", m } : { kind: "answer", m }));
}

export function ModeSheet({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const composer = useStore(app.composer);
  return (
    <Dialog title="Mode" onClose={onClose} sheet testId="mode-sheet">
      <p>Shapes how DASH AI answers. You can change it at any time.</p>
      <div role="radiogroup" aria-label="Mode">
        {MODE_ORDER.map((mode: AssistantMode) => (
          <button
            key={mode}
            className="choice"
            role="radio"
            aria-checked={composer.mode === mode}
            onClick={() => {
              app.composer.set((c) => ({ ...c, mode }));
              onClose();
            }}
            data-testid={`mode-${mode}`}
          >
            <span className="grow">
              <span className="choice-title">{MODES[mode].label}</span>
              <span className="choice-desc" style={{ display: "block" }}>{MODES[mode].tagline}</span>
              {MODES[mode].limitation && <span className="choice-note" style={{ display: "block" }}>{MODES[mode].limitation}</span>}
            </span>
            <span className={`dot${composer.mode === mode ? " on" : ""}`} />
          </button>
        ))}
      </div>
      <button className="choice" onClick={() => (onClose(), navigate("/tools"))}>
        <span className="grow">
          <span className="choice-title">Tools & Connections</span>
          <span className="choice-desc" style={{ display: "block" }}>Choose which tools DASH AI may use.</span>
        </span>
        <Icon name="chevronRight" />
      </button>
    </Dialog>
  );
}

function Composer({ onSend }: { onSend: () => void }) {
  const app = useApp();
  const c = useStore(app.composer);
  const s = useStore(app.settings);
  const online = useStore(app.online);
  const chat = useStore(app.engineStore);
  const fileInput = useRef<HTMLInputElement>(null);
  const text = useRef<HTMLTextAreaElement>(null);
  const [sheet, setSheet] = useState<"mode" | null>(null);
  const ready = c.attachments.filter((a) => a.attachment);
  const canSend = !chat.generating && (c.text.trim().length > 0 || ready.length > 0) && !c.attachments.some((a) => !a.attachment && !a.error) && (s.demoMode || online);

  useEffect(() => {
    const t = text.current;
    if (!t) return;
    t.style.height = "auto";
    t.style.height = `${Math.min(t.scrollHeight, 240)}px`;
  }, [c.text]);

  return (
    <div className="composer-wrap">
      <div className="composer">
        {c.attachments.length > 0 && (
          <div className="attachments">
            {c.attachments.map((a) => (
              <div key={a.localId} className={`attachment${a.error ? " bad" : ""}`} data-testid="attachment">
                {a.error ? <Icon name="warning" size={16} /> : a.attachment ? <Icon name="doc" size={16} /> : <span className="spinner" style={{ width: 14, height: 14, color: "var(--accent)" }} />}
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="ellipsis" style={{ display: "block" }}>{a.name}</span>
                  <span className="faint" style={{ fontSize: 12, color: a.error ? "var(--error)" : undefined }}>
                    {a.error ?? (a.attachment ? formatSize(a.sizeBytes) : `Uploading ${Math.round(a.progress * 100)}%`)}
                  </span>
                </span>
                <button className="icon-btn" style={{ width: 32, height: 32 }} aria-label={`Remove ${a.name}`} onClick={() => app.composer.set((x) => ({ ...x, attachments: x.attachments.filter((y) => y.localId !== a.localId) }))}>
                  <Icon name="close" size={16} />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={text}
          rows={1}
          value={c.text}
          maxLength={LIMITS.maxMessageChars}
          placeholder={MODES[c.mode].hint}
          aria-label="Message DASH AI"
          data-testid="composer-input"
          onChange={(e) => app.composer.set((x) => ({ ...x, text: e.target.value }))}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (canSend) onSend();
            }
          }}
        />
        <div className="composer-bar">
          <button className="icon-btn" onClick={() => fileInput.current?.click()} disabled={chat.generating} aria-label="Add a document" data-testid="attach">
            <Icon name="plus" />
          </button>
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPT}
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void app.attach(f);
              e.target.value = "";
            }}
            data-testid="file-input"
          />
          <div className="row grow" style={{ gap: 6, overflowX: "auto" }}>
            <button className="chip-btn" onClick={() => setSheet("mode")} disabled={chat.generating} aria-label={`Mode: ${MODES[c.mode].label}. Change mode`} data-testid="mode-chip">
              {MODES[c.mode].label} <Icon name="chevron" size={16} />
            </button>
          </div>
          {chat.generating ? (
            <button className="send stop" onClick={() => app.engine.stop()} aria-label="Stop generating" data-testid="stop">
              <Icon name="stop" size={18} />
            </button>
          ) : (
            <button className="send" onClick={onSend} disabled={!canSend} aria-label="Send message" data-testid="send">
              <Icon name="send" size={18} />
            </button>
          )}
        </div>
        <div className="recipient" data-testid="recipient">{recipientLabel(c.mode, s.demoMode)}</div>
      </div>
      {sheet === "mode" && <ModeSheet onClose={() => setSheet(null)} />}
    </div>
  );
}

export function ChatScreen() {
  const app = useApp();
  const chat = useStore(app.engineStore);
  const settings = useStore(app.settings);
  const assistant = useStore(app.assistant);
  const online = useStore(app.online);
  const composer = useStore(app.composer);
  const { parts } = useRoute();
  const routeId = parts[1];
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<ChatMsg | null>(null);
  /** An earlier answer to regenerate once the person confirms that the messages after it go. */
  const [regenerating, setRegenerating] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [showJump, setShowJump] = useState(false);

  // Deep link or reload on /chat/:id opens that conversation.
  useEffect(() => {
    if (routeId && chat.conversation?.id !== routeId && !chat.loading && !chat.generating) void app.engine.open(routeId);
  }, [routeId]);
  // Keep the URL in step once a new chat gets its id.
  useEffect(() => {
    if (chat.conversation && !routeId) history.replaceState(null, "", `/chat/${chat.conversation.id}`);
  }, [chat.conversation, routeId]);
  // Follow the answer while it streams, unless the reader scrolled up.
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [chat.messages]);

  const items = useMemo(() => toItems(chat.messages), [chat.messages]);

  const send = () => {
    const c = app.composer.value;
    const attachments = c.attachments.flatMap((a) => (a.attachment ? [a.attachment] : []));
    const text = c.text.trim() || (attachments.length ? "Summarise the attached document." : "");
    pinned.current = true;
    if (app.engine.send(text, c.mode, attachments)) app.composer.set((x) => ({ ...x, text: "", attachments: [] }));
  };

  const actions: MessageActions = useMemo(
    () => ({
      copy: (text) => void navigator.clipboard?.writeText(text).then(() => app.notify("Copied")),
      share: typeof navigator !== "undefined" && "share" in navigator ? (text) => void navigator.share({ text }).catch(() => undefined) : null,
      regenerate: (id) => (app.engine.regenerateRemovesLater(id) ? setRegenerating(id) : app.engine.regenerate(id)),
      edit: (m) => setEditing(m),
      retry: (id) => {
        setDismissed((d) => new Set([...d].filter((x) => x !== id)));
        app.engine.regenerate(id);
      },
      later: (id) => setDismissed((d) => new Set(d).add(id)),
    }),
    [app],
  );
  const ctx: AnswerContext = { generating: chat.generating, online: online || settings.demoMode, dismissed, pluginNames: {} };
  const mode = MODES[composer.mode];

  return (
    <>
      <TopBar
        actions={
          <button className="icon-btn" onClick={() => (app.engine.newChat(), navigate("/chat"))} disabled={chat.generating} aria-label="New chat" data-testid="topbar-new-chat">
            <Icon name="newChat" />
          </button>
        }
      >
        <h1 className="grow ellipsis" data-testid="chat-title">{chat.conversation?.title ?? "New chat"}</h1>
      </TopBar>
      <div
        className="content"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          pinned.current = atBottom;
          setShowJump(!atBottom);
        }}
      >
        <div className="reading">
          {settings.demoMode && (
            <Notice testId="demo-banner" action={{ label: "Settings", onClick: () => navigate("/settings") }}>
              Demo Mode: DASH AI's answers are simulated in this browser. Nothing is sent anywhere.
            </Notice>
          )}
          {!settings.demoMode && !online && <Notice tone="warning" testId="offline-banner">You're offline. Your chats are still here; new answers need a connection.</Notice>}
          {!settings.demoMode && assistant.error && <Notice tone="warning">Couldn't check the server: {assistant.error}</Notice>}
          {!settings.demoMode && !assistant.available && !assistant.error && <Notice tone="warning" testId="unavailable-banner">DASH AI is temporarily unavailable. Please try again later.</Notice>}
          {chat.error && (
            <div style={{ marginTop: 12 }}>
              <Notice tone="error" testId="error-banner" action={chat.error.retryable ? { label: "Retry", onClick: () => app.engine.retryLast() } : undefined} onDismiss={() => app.engine.dismissError()}>
                {chat.error.message}
              </Notice>
            </div>
          )}
          {chat.loading ? (
            <Loading label="Opening chat…" />
          ) : items.length === 0 ? (
            <div style={{ padding: "48px 0 24px" }} data-testid="empty-chat">
              <h2 className="serif" style={{ fontSize: 30, margin: "0 0 8px" }}>What do you want to work on?</h2>
              <p className="muted" style={{ margin: 0 }}>{mode.label} · {mode.tagline}</p>
              {mode.limitation && <div style={{ marginTop: 12 }}><Notice>{mode.limitation}</Notice></div>}
              <div className="stack" style={{ marginTop: 24 }}>
                {mode.suggestions.map((s) => (
                  <button key={s} className="card card-pad card-button" onClick={() => app.composer.set((c) => ({ ...c, text: s }))} data-testid="suggestion">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="messages" data-testid="messages">
              {items.map((it) =>
                it.kind === "user" ? (
                  <UserMessage key={it.m.id} m={it.m} generating={chat.generating} actions={actions} />
                ) : (
                  <AssistantMessage key={it.m.id} m={it.m} ctx={ctx} actions={actions} />
                ),
              )}
            </div>
          )}
        </div>
      </div>
      <div className="reading" style={{ position: "relative" }}>
        {showJump && (
          <button
            className="icon-btn card"
            style={{ position: "absolute", top: -56, left: "50%", transform: "translateX(-50%)", boxShadow: "var(--shadow)" }}
            onClick={() => {
              const el = scroller.current;
              if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
            }}
            aria-label="Jump to the latest message"
          >
            <Icon name="chevron" />
          </button>
        )}
        <Composer onSend={send} />
      </div>
      {editing && <EditDialog m={editing} onClose={() => setEditing(null)} />}
      {regenerating && (
        <Dialog title="Regenerate this answer?" onClose={() => setRegenerating(null)}>
          <p>The messages after it in this chat will be removed and replaced by the new answer.</p>
          <div className="actions">
            <button className="btn btn-text" style={{ color: "var(--ink-2)" }} onClick={() => setRegenerating(null)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={() => {
                app.engine.regenerate(regenerating);
                setRegenerating(null);
              }}
            >
              Regenerate
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}

function EditDialog({ m, onClose }: { m: ChatMsg; onClose: () => void }) {
  const app = useApp();
  const [text, setText] = useState(m.content);
  return (
    <Dialog title="Edit and resend" onClose={onClose}>
      <p>Answers after this message will be replaced.</p>
      <textarea className="input" style={{ minHeight: 120, padding: 12 }} value={text} onChange={(e) => setText(e.target.value)} aria-label="Message" />
      <div className="actions">
        <button className="btn btn-text" style={{ color: "var(--ink-2)" }} onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn btn-primary"
          disabled={!text.trim()}
          onClick={() => {
            app.engine.editAndResend(m.id, text);
            onClose();
          }}
        >
          Resend
        </button>
      </div>
    </Dialog>
  );
}
