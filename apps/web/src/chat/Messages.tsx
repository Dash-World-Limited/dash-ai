import { memo, useState } from "react";
import { recoveryCard, sourceLabel, toolSummary, toolUseLabel, type RecoveryCard } from "../logic/presentation";
import { Icon } from "../ui/icons";
import { DemoBadge } from "../ui/kit";
import { Markdown } from "./Markdown";
import type { ChatMsg } from "./types";

export interface MessageActions {
  copy: (text: string) => void;
  share: ((text: string) => void) | null;
  regenerate: (id: string) => void;
  edit: (m: ChatMsg) => void;
  retry: (id: string) => void;
  later: (id: string) => void;
}

export const UserMessage = memo(function UserMessage({ m, generating, actions }: { m: ChatMsg; generating: boolean; actions: MessageActions }) {
  return (
    <div style={{ display: "grid", justifyItems: "end" }} data-testid="user-message">
      <div className="user-msg">
        {m.attachments.map((a) => (
          <div key={a.id} className="row small muted" style={{ gap: 6, marginBottom: 6 }}>
            <Icon name="doc" size={16} /> {a.name}
          </div>
        ))}
        {m.content}
      </div>
      <div className="msg-tools">
        <button className="icon-btn" onClick={() => actions.copy(m.content)} aria-label="Copy message">
          <Icon name="copy" size={18} />
        </button>
        <button className="icon-btn" onClick={() => actions.edit(m)} disabled={generating} aria-label="Edit and resend">
          <Icon name="edit" size={18} />
        </button>
      </div>
    </div>
  );
});

function ToolActivity({ m, pluginNames }: { m: ChatMsg; pluginNames: Record<string, string> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="tool-chip" data-testid="tool-activity">
      <button onClick={() => setOpen(!open)} aria-expanded={open}>
        <span style={{ color: "var(--accent-ink)", display: "inline-flex" }}>
          <Icon name="wrench" size={14} />
        </span>
        {toolSummary(m.tools)}
        <Icon name="chevron" size={16} />
      </button>
      {open && (
        <ul>
          {m.tools.map((t) => {
            const l = toolUseLabel(t, pluginNames);
            return (
              <li key={t.callId}>
                <strong style={{ fontWeight: 500 }}>{l.title}</strong>
                <div className="faint">{l.detail}</div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Working({ tools }: { tools: boolean }) {
  return (
    <div className="working" role="status" aria-label="DASH AI is working on an answer" data-testid="working">
      <i />
      <i />
      <i />
      <span>{tools ? "Using tools…" : "Working…"}</span>
    </div>
  );
}

function Recovery({ m, card, generating, actions }: { m: ChatMsg; card: RecoveryCard; generating: boolean; actions: MessageActions }) {
  return (
    <div className="card card-pad recovery" role="status" aria-live="polite" data-testid="recovery-card">
      <h3>{card.title}</h3>
      <p>{card.message}</p>
      {card.attemptsNote && <p className="small faint">{card.attemptsNote}</p>}
      <div className="row" style={{ flexWrap: "wrap", gap: 8, marginTop: 4 }}>
        {card.actions.includes("retry") && (
          <button className="btn btn-primary" onClick={() => actions.retry(m.id)} disabled={generating} data-testid="recovery-retry">
            <Icon name="refresh" size={18} /> Retry
          </button>
        )}
        <button className="btn btn-text" onClick={() => actions.later(m.id)} data-testid="recovery-later">
          Continue later
        </button>
      </div>
    </div>
  );
}

export interface AnswerContext {
  generating: boolean;
  online: boolean;
  dismissed: ReadonlySet<string>;
  pluginNames: Record<string, string>;
  compact?: boolean;
}

export const AssistantMessage = memo(function AssistantMessage({ m, ctx, actions }: { m: ChatMsg; ctx: AnswerContext; actions: MessageActions }) {
  const card = m.status === "failed" && !ctx.dismissed.has(m.id) ? recoveryCard({ errorMessage: m.errorMessage, retryable: m.retryable, recovery: m.recovery }, ctx.online) : null;
  const status =
    m.status === "stopped" ? "Stopped" : m.status === "failed" ? (m.errorMessage ?? "This answer was not completed.") : m.finishReason === "length" ? "The answer reached the length limit and may be cut off." : m.finishReason === "refusal" ? "DASH AI declined part of this request." : null;
  return (
    <article className="assistant-msg" data-testid="assistant-message" aria-busy={m.status === "streaming"}>
      <div className="source" data-testid="source-label">
        {sourceLabel(m)}
        {m.demo && <DemoBadge />}
      </div>
      {m.tools.length > 0 && <ToolActivity m={m} pluginNames={ctx.pluginNames} />}
      {m.status === "streaming" && !m.content ? <Working tools={m.tools.some((t) => t.status === null)} /> : m.content && <Markdown text={m.content} />}
      {card ? <Recovery m={m} card={card} generating={ctx.generating} actions={actions} /> : status && <p className="small faint" style={{ margin: 0 }} data-testid="message-status">{status}</p>}
      {m.status !== "streaming" && !card && (
        <div className="actions-row">
          {m.content && (
            <>
              <button className="icon-btn" onClick={() => actions.copy(m.content)} aria-label="Copy response">
                <Icon name="copy" size={18} />
              </button>
              {actions.share && (
                <button className="icon-btn" onClick={() => actions.share?.(m.content)} aria-label="Share response">
                  <Icon name="share" size={18} />
                </button>
              )}
            </>
          )}
          <button className="icon-btn" onClick={() => actions.regenerate(m.id)} disabled={ctx.generating} aria-label="Regenerate response">
            <Icon name="refresh" size={18} />
          </button>
        </div>
      )}
    </article>
  );
});
