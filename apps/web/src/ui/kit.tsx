import { useEffect, useId, useRef, type ReactNode } from "react";
import type { Tone } from "../logic/presentation";
import { Icon, type IconName } from "./icons";

/** The DASH AI mark: the gold "D" (temporary until the official Dash World asset is supplied). */
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="31 30 46 48" role="img" aria-label="DASH AI">
      <defs>
        <linearGradient id="dash-gold" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#E3C989" />
          <stop offset="0.55" stopColor="#C9A75B" />
          <stop offset="1" stopColor="#8F6C22" />
        </linearGradient>
      </defs>
      <path fill="url(#dash-gold)" fillRule="evenodd" d="M37 33h15a21 21 0 0 1 0 42H37Zm7.5 7.5H52a13.5 13.5 0 0 1 0 27h-7.5Z" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="wordmark" aria-label="DASH AI">
      <b>DASH</b> <span>AI</span>
    </span>
  );
}

export function Badge({ text, tone }: { text: string; tone: Tone }) {
  return <span className={`badge tone-${tone}`}>{text}</span>;
}

export function DemoBadge() {
  return (
    <span className="demo-badge" title="Demo Mode: simulated, not a real provider">
      DEMO
    </span>
  );
}

export function Notice({
  tone = "neutral",
  title,
  children,
  action,
  onDismiss,
  testId,
}: {
  tone?: Tone;
  title?: string;
  children: ReactNode;
  action?: { label: string; onClick: () => void };
  onDismiss?: () => void;
  testId?: string;
}) {
  const icon: IconName = tone === "error" || tone === "warning" ? "warning" : "info";
  return (
    <div className={`notice tone-${tone}`} role={tone === "error" ? "alert" : "status"} data-testid={testId}>
      <Icon name={icon} size={18} />
      <div className="grow">
        {title && <strong>{title}</strong>}
        <p>{children}</p>
      </div>
      {action && (
        <button className="btn btn-text" onClick={action.onClick}>
          {action.label}
        </button>
      )}
      {onDismiss && (
        <button className="btn btn-text" onClick={onDismiss}>
          Dismiss
        </button>
      )}
    </div>
  );
}

export function Empty({ icon, title, children, action, testId }: { icon: IconName; title: string; children: ReactNode; action?: ReactNode; testId?: string }) {
  return (
    <div className="empty" data-testid={testId}>
      <div className="bubble">
        <Icon name={icon} size={26} />
      </div>
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </div>
  );
}

export function Loading({ label }: { label: string }) {
  return (
    <div className="empty" role="status">
      <span className="spinner" style={{ color: "var(--accent)" }} />
      <p>{label}</p>
    </div>
  );
}

/** A modal dialog; on narrow screens it becomes a bottom sheet. Escape and the backdrop close it. */
export function Dialog({
  title,
  onClose,
  children,
  sheet = false,
  testId,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  sheet?: boolean;
  testId?: string;
}) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("button:not([disabled]), input, textarea")?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [onClose]);
  return (
    <div className={`overlay${sheet ? " sheet" : ""}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={id} ref={ref} data-testid={testId}>
        <h2 id={id}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function Confirm({
  title,
  text,
  confirm,
  destructive,
  onConfirm,
  onClose,
}: {
  title: string;
  text: string;
  confirm: string;
  destructive?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog title={title} onClose={onClose} testId="confirm-dialog">
      <p>{text}</p>
      <div className="actions">
        <button className="btn btn-text" style={{ color: "var(--ink-2)" }} onClick={onClose}>
          Cancel
        </button>
        <button className={`btn ${destructive ? "btn-secondary btn-danger" : "btn-primary"}`} onClick={onConfirm} data-testid="confirm">
          {confirm}
        </button>
      </div>
    </Dialog>
  );
}

export function Switch({ checked, onChange, label, disabled, testId }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; testId?: string }) {
  return (
    <span className="switch">
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} aria-label={label} onChange={(e) => onChange(e.target.checked)} data-testid={testId} />
      <span />
    </span>
  );
}

export function Toast({ text, onDone }: { text: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 3200);
    return () => clearTimeout(t);
  }, [text, onDone]);
  return (
    <div className="toast" role="status" aria-live="polite">
      {text}
    </div>
  );
}
