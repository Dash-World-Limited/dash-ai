import type { UsageSummaryResponse } from "@dash-ai/contracts";
import { useEffect, useState, type ReactNode } from "react";
import { ApiError } from "../api/client";
import { initials } from "../logic/presentation";
import { useApp } from "../state/app";
import { navigate } from "../state/router";
import { useStore } from "../state/store";
import { Icon, type IconName } from "../ui/icons";
import { Confirm, DemoBadge, Notice } from "../ui/kit";
import { TopBar } from "./Shell";

export function Row({ icon, title, sub, onClick, danger, right, testId }: { icon?: IconName; title: string; sub?: string; onClick?: () => void; danger?: boolean; right?: ReactNode; testId?: string }) {
  const body = (
    <>
      {icon && (
        <span style={{ color: danger ? "var(--error)" : "var(--ink-2)", display: "inline-flex" }}>
          <Icon name={icon} />
        </span>
      )}
      <span className="grow" style={{ textAlign: "left" }}>
        <span style={{ display: "block", color: danger ? "var(--error)" : "var(--ink)" }}>{title}</span>
        {sub && <span className="small muted" style={{ display: "block" }}>{sub}</span>}
      </span>
      {right}
    </>
  );
  return onClick ? (
    <button className="list-row" style={{ minHeight: 60 }} onClick={onClick} data-testid={testId}>
      {body}
    </button>
  ) : (
    <div className="list-row" style={{ minHeight: 60, cursor: "default" }} data-testid={testId}>
      {body}
    </div>
  );
}

export function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section>
      {title && <h2 className="section-title">{title}</h2>}
      <div className="card" style={{ overflow: "hidden" }}>{children}</div>
    </section>
  );
}

export function DataProtection() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Row icon="shield" title="How your data is protected" sub="Encryption in transit and at rest, and what that means" onClick={() => setOpen(!open)} testId="data-protection" />
      {open && (
        <div className="stack small muted" style={{ padding: "0 16px 16px", gap: 8 }}>
          <p style={{ margin: 0 }}>In transit: the web app talks to the DASH AI server over HTTPS in production.</p>
          <p style={{ margin: 0 }}>
            On the server: chats, documents and tool activity are encrypted at rest (AES-256-GCM). The server decrypts them to answer you, so this is not end-to-end encryption. DASH AI may use third-party artificial-intelligence service providers to process requests.
          </p>
          <p style={{ margin: 0 }}>
            In this browser: your session is kept for this tab only, or until you sign out if you chose "Keep me signed in". Demo Mode chats and documents stay in this browser's storage.
          </p>
          <p style={{ margin: 0 }}>DASH AI's service keys never reach your browser.</p>
        </div>
      )}
    </>
  );
}

export function AccountScreen() {
  const app = useApp();
  const settings = useStore(app.settings);
  const account = settings.account;
  const signedIn = !settings.demoMode && account !== null;
  const [usage, setUsage] = useState<UsageSummaryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"out" | "everywhere" | "delete" | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (signedIn) void app.api.usage().then(setUsage, (e: unknown) => setError(e instanceof ApiError ? e.message : "Couldn't load usage."));
  }, [app, signedIn]);

  const run = async (kind: "out" | "everywhere" | "delete") => {
    setConfirm(null);
    setBusy(true);
    setError(null);
    try {
      if (kind === "delete") {
        await app.api.deleteAccount();
        app.accountDeleted();
      } else {
        await app.signOut(kind === "everywhere");
      }
    } catch (e) {
      setError(kind === "everywhere" ? `Couldn't sign out everywhere: ${e instanceof ApiError ? e.message : "try again"}` : e instanceof ApiError ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <TopBar title="Account" />
      <div className="content">
        <main className="reading stack" style={{ paddingBottom: 48 }} data-testid="account">
          <div className="row" style={{ gap: 16, marginTop: 8 }}>
            <span style={{ width: 56, height: 56, borderRadius: "50%", background: "var(--accent-container)", display: "grid", placeItems: "center", fontWeight: 600, fontSize: 20 }}>
              {initials(account?.displayName, account?.email) ?? <Icon name="user" />}
            </span>
            <div className="grow">
              <h2 style={{ margin: 0, fontSize: 22 }} data-testid="account-name">{signedIn ? account.displayName : "Demo Mode"}</h2>
              <p className="muted" style={{ margin: 0 }}>{signedIn ? account.email : "No account · nothing leaves this browser"}</p>
            </div>
            {settings.demoMode && <DemoBadge />}
          </div>
          {!signedIn && (
            <>
              <Notice title="You're using Demo Mode">
                Demo answers are simulated in this browser. Sign in or create an account to get real answers from DASH AI. Demo chats are kept separate from your account.
              </Notice>
              <button className="btn btn-primary btn-block" onClick={() => navigate("/sign-in")} data-testid="account-sign-in">Sign in or create an account</button>
            </>
          )}
          {signedIn && (
            <>
              <Group title="Sessions">
                <Row icon="user" title="This browser" sub="Signed in here. Your chats are stored in your account and synced to your other devices." />
                <div className="divider" />
                <Row icon="layers" title="Other devices" sub="DASH AI doesn't list your other sessions. Use “Sign out everywhere” to end all of them, including this one." />
              </Group>
              <Group title="Usage">
                <div style={{ padding: 16 }}>
                  {!usage || usage.totals.length === 0 ? (
                    <span className="muted">No usage recorded yet.</span>
                  ) : (
                    <div data-testid="usage-total">
                      DASH AI · {usage.totals.reduce((n, t) => n + t.requests, 0)} answers · {usage.totals.reduce((n, t) => n + t.inputTokens + t.outputTokens, 0).toLocaleString()} tokens
                    </div>
                  )}
                </div>
              </Group>
            </>
          )}
          <Group title="Privacy & Security">
            <DataProtection />
          </Group>
          {error && <Notice tone="error">{error}</Notice>}
          {signedIn && (
            <Group>
              <Row icon="logout" title="Sign out" sub="Ends this browser's session" onClick={() => setConfirm("out")} testId="sign-out" />
              <div className="divider" />
              <Row icon="logout" title="Sign out everywhere" sub="Ends every session of this account, on every device" onClick={() => setConfirm("everywhere")} testId="sign-out-everywhere" />
              <div className="divider" />
              <Row icon="trash" title="Delete account" sub="Permanently deletes your account and its data on the server" danger onClick={() => setConfirm("delete")} testId="delete-account" />
            </Group>
          )}
          {busy && <p className="small muted" role="status">Working…</p>}
        </main>
      </div>
      {confirm === "out" && <Confirm title="Sign out?" text="You'll need to sign in again on this browser. Your chats stay in your account." confirm="Sign out" onClose={() => setConfirm(null)} onConfirm={() => void run("out")} />}
      {confirm === "everywhere" && (
        <Confirm title="Sign out everywhere?" text="Every session of this account ends, on every device. You'll need to sign in again everywhere." confirm="Sign out everywhere" destructive onClose={() => setConfirm(null)} onConfirm={() => void run("everywhere")} />
      )}
      {confirm === "delete" && (
        <Confirm title="Delete your account?" text="This permanently deletes your DASH AI account and its data on the server. This can't be undone." confirm="Delete account" destructive onClose={() => setConfirm(null)} onConfirm={() => void run("delete")} />
      )}
    </>
  );
}
