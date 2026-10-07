import { useEffect, useState } from "react";
import { LIMITS } from "@dash-ai/contracts";
import { ApiError } from "../api/client";
import { authFailure, emailError, passwordError, type AuthFailureKind } from "../logic/presentation";
import { BRAND, SPLASH } from "../brand/brand";
import { useApp } from "../state/app";
import { navigate } from "../state/router";
import { useStore } from "../state/store";
import { Icon, type IconName } from "../ui/icons";
import { BrandMark, Notice, Wordmark } from "../ui/kit";

/** The brand moment on first paint: short, and skipped entirely with reduced motion. */
/**
 * The brand splash ("Intelligence. Possibility. Arrival."): always dark and cinematic, whatever the
 * theme. The scene layers come from tools/brand/splash_scene.py (shared with Android); the mark,
 * wordmark, tagline and footer are drawn here. No buttons, no feature cards.
 */
export function Splash({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const t = setTimeout(onDone, reduced ? 400 : 1600);
    return () => clearTimeout(t);
  }, [onDone]);
  return (
    <div className="splash" data-testid="splash" role="img" aria-label="DASH AI. Beyond the Digital. A Dash World product.">
      <img className="splash-planet" src={SPLASH.planet} alt="" draggable={false} />
      <img className="splash-terrain" src={SPLASH.terrain} alt="" draggable={false} />
      <img className="splash-figure" src={SPLASH.figure} alt="" draggable={false} />
      <div className="splash-center">
        <img className="splash-mark" src={BRAND.markUrl} alt="" draggable={false} />
        <span className="splash-wordmark">DASH AI</span>
        <span className="splash-tagline">Beyond the Digital.</span>
      </div>
      <span className="splash-footer">A DASH WORLD PRODUCT</span>
    </div>
  );
}

const CUES: { icon: IconName; title: string; text: string }[] = [
  { icon: "bolt", title: "Get answers faster", text: "Ask in your own words and get clear, structured answers." },
  { icon: "layers", title: "Go deeper with context", text: "Add your documents and pick a focused mode for each chat." },
  { icon: "sparkle", title: "Turn ideas into action", text: "Draft, plan and analyse in focused modes built for real work." },
];

/** First visit only: one calm screen. */
export function Welcome() {
  const app = useApp();
  return (
    <main className="center-page" data-testid="onboarding">
      <div className="form-col">
        <div className="row" style={{ gap: 10 }}>
          <BrandMark size={26} />
          <Wordmark />
        </div>
        <h1 className="serif" style={{ fontSize: 40, lineHeight: 1.15, margin: "56px 0 12px" }}>
          What are we building today?
        </h1>
        <p className="muted" style={{ fontSize: 17, margin: 0 }}>
          DASH AI helps you think, create, analyse and act.
        </p>
        <div className="stack" style={{ gap: 24, margin: "40px 0" }}>
          {CUES.map((c) => (
            <div className="cue" key={c.title}>
              <div className="bubble">
                <Icon name={c.icon} />
              </div>
              <div>
                <h3>{c.title}</h3>
                <p>{c.text}</p>
              </div>
            </div>
          ))}
        </div>
        <button
          className="btn btn-primary btn-block"
          data-testid="get-started"
          onClick={() => {
            app.settings.set((s) => ({ ...s, onboarded: true }));
            navigate("/sign-in", true);
          }}
        >
          Get started
        </button>
        <p className="faint small" style={{ textAlign: "center", marginTop: 12 }}>
          A Dash World product
        </p>
      </div>
    </main>
  );
}

/** Email and password are the only sign-in methods the DASH AI server supports, so they are the only ones offered. */
export function SignIn() {
  const app = useApp();
  const online = useStore(app.online);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<{ name?: string; email?: string; password?: string }>({});
  const [failure, setFailure] = useState<{ kind: AuthFailureKind; message: string; canRetry: boolean } | null>(null);

  const submit = async () => {
    if (busy) return;
    const next = {
      name: creating && !name.trim() ? "Enter your name." : undefined,
      email: emailError(email) ?? undefined,
      password: passwordError(password, creating, LIMITS.minPasswordChars, LIMITS.maxPasswordChars) ?? undefined,
    };
    setErrors(next);
    if (next.name || next.email || next.password) return;
    if (!online) return setFailure(authFailure("network", "", true, false));
    setBusy(true);
    setFailure(null);
    try {
      const r = creating ? await app.api.register(email, password, name) : await app.api.login(email, password);
      app.signedIn(r.token, { id: r.user.id, email: r.user.email, displayName: r.user.displayName }, remember);
      navigate("/", true);
    } catch (e) {
      const err = e instanceof ApiError ? e : ApiError.network();
      const f = authFailure(err.code, err.message, err.retryable, online);
      setFailure(f);
      if (f.kind === "invalid") setPassword("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="center-page" data-testid="auth">
      <div className="form-col">
        <div className="row" style={{ gap: 10 }}>
          <BrandMark size={26} />
          <Wordmark />
        </div>
        <h1 className="serif" style={{ fontSize: 36, margin: "40px 0 8px" }}>
          {creating ? "Create your account" : "Welcome back"}
        </h1>
        <p className="muted" style={{ margin: "0 0 24px" }}>
          {creating ? "Your conversations sync across your devices." : "Sign in to continue where you left off."}
        </p>
        <div className="segmented" role="tablist" aria-label="Sign in or create an account">
          {[false, true].map((c) => (
            <button key={String(c)} role="tab" aria-selected={creating === c} onClick={() => (setCreating(c), setFailure(null))} disabled={busy} data-testid={c ? "tab-create" : "tab-sign-in"}>
              {c ? "Create account" : "Sign in"}
            </button>
          ))}
        </div>
        {!online && (
          <div style={{ marginTop: 16 }}>
            <Notice tone="warning" testId="auth-offline">You're offline. Signing in needs a connection; Demo Mode works offline.</Notice>
          </div>
        )}
        <form
          className="stack"
          style={{ marginTop: 24, gap: 16 }}
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          noValidate
        >
          {creating && (
            <div className="field">
              <label htmlFor="name">Your name</label>
              <input id="name" className="input" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!errors.name} disabled={busy} />
              {errors.name && <span className="err">{errors.name}</span>}
            </div>
          )}
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" className="input" type="email" autoComplete="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={!!errors.email} disabled={busy} />
            {errors.email && <span className="err">{errors.email}</span>}
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <div style={{ position: "relative" }}>
              <input
                id="password"
                className="input"
                type={show ? "text" : "password"}
                autoComplete={creating ? "new-password" : "current-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={!!errors.password}
                disabled={busy}
                style={{ paddingRight: 52 }}
              />
              <button type="button" className="icon-btn" style={{ position: "absolute", right: 2, top: 2 }} onClick={() => setShow(!show)} aria-label={show ? "Hide password" : "Show password"}>
                <Icon name={show ? "eyeOff" : "eye"} />
              </button>
            </div>
            {errors.password ? <span className="err">{errors.password}</span> : creating && <span className="hint">At least {LIMITS.minPasswordChars} characters.</span>}
          </div>
          <label className="row small muted" style={{ gap: 8 }}>
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Keep me signed in on this browser
          </label>
          {failure && (
            <Notice
              tone={failure.kind === "offline" || failure.kind === "rate_limited" ? "warning" : "error"}
              testId="auth-error"
              action={
                failure.kind === "exists"
                  ? { label: "Sign in", onClick: () => (setCreating(false), setFailure(null)) }
                  : failure.canRetry
                    ? { label: "Retry", onClick: () => void submit() }
                    : undefined
              }
            >
              {failure.message}
            </Notice>
          )}
          <button className="btn btn-primary btn-block" type="submit" disabled={busy} data-testid="auth-submit">
            {busy && <span className="spinner" />}
            {creating ? "Create account" : "Sign in"}
          </button>
        </form>
        <div style={{ marginTop: 40 }}>
          <strong style={{ fontSize: 15 }}>Just looking?</strong>
          <p className="muted small" style={{ margin: "4px 0 12px" }}>
            Demo Mode shows how DASH AI works with simulated answers. Nothing leaves this browser and no account is needed.
          </p>
          <button
            className="btn btn-secondary btn-block"
            disabled={busy}
            data-testid="continue-demo"
            onClick={() => {
              app.startDemo();
              navigate("/", true);
            }}
          >
            Continue in Demo Mode
          </button>
        </div>
      </div>
    </main>
  );
}
