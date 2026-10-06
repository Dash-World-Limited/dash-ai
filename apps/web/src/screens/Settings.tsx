import type { AssistantMode, ModelChoice } from "@dash-ai/contracts";
import { useState } from "react";
import { CHOICE_LABEL, MODE_ORDER, MODES } from "../logic/presentation";
import { useApp } from "../state/app";
import type { DemoFailure } from "../chat/backends";
import type { ThemePreference } from "../state/settings";
import { navigate } from "../state/router";
import { useStore } from "../state/store";
import { Icon } from "../ui/icons";
import { Confirm, Switch, Wordmark } from "../ui/kit";
import { DataProtection, Group, Row } from "./Account";
import { TopBar } from "./Shell";

function Radio<T extends string>({ label, value, current, onPick, testId }: { label: string; value: T; current: T; onPick: (v: T) => void; testId: string }) {
  return (
    <button className="list-row" role="radio" aria-checked={value === current} onClick={() => onPick(value)} data-testid={testId}>
      <span className="grow">{label}</span>
      <span className={`dot${value === current ? " on" : ""}`} />
    </button>
  );
}

export function SettingsScreen() {
  const app = useApp();
  const s = useStore(app.settings);
  const signedIn = !s.demoMode && s.account !== null;
  const [confirmClear, setConfirmClear] = useState(false);
  const set = (change: Partial<typeof s>) => app.settings.set((p) => ({ ...p, ...change }));

  return (
    <>
      <TopBar title="Settings" />
      <div className="content">
        <main className="reading stack" style={{ paddingBottom: 48 }} data-testid="settings">
          <Group title="Appearance">
            <div role="radiogroup" aria-label="Theme">
              {(["system", "light", "dark"] as ThemePreference[]).map((t) => (
                <Radio key={t} label={t === "system" ? "System default" : t === "light" ? "Light" : "Dark"} value={t} current={s.theme} onPick={(v) => set({ theme: v })} testId={`theme-${t}`} />
              ))}
            </div>
          </Group>
          <Group title="Provider for new chats">
            <div role="radiogroup" aria-label="Provider for new chats">
              {(["smart", "openai", "claude"] as ModelChoice[]).map((c) => (
                <Radio key={c} label={CHOICE_LABEL[c]} value={c} current={s.defaultChoice} onPick={(v) => (set({ defaultChoice: v }), app.composer.set((x) => ({ ...x, choice: v })))} testId={`default-${c}`} />
              ))}
            </div>
          </Group>
          <Group title="Mode for new chats">
            <div role="radiogroup" aria-label="Mode for new chats">
              {MODE_ORDER.map((m) => (
                <Radio<AssistantMode> key={m} label={MODES[m].label} value={m} current={s.defaultMode} onPick={(v) => set({ defaultMode: v })} testId={`default-mode-${m}`} />
              ))}
            </div>
          </Group>
          <Group title="Privacy & Security">
            <DataProtection />
            {signedIn && (
              <>
                <div className="divider" />
                <Row icon="logout" title="Sign out and sessions" sub="Sign out on this browser or everywhere" onClick={() => navigate("/account")} right={<Icon name="chevronRight" />} />
              </>
            )}
          </Group>
          <Group title="Connected tools">
            <Row icon="puzzle" title="Tools & Connections" sub="Choose which tools DASH AI may use" onClick={() => navigate("/tools")} right={<Icon name="chevronRight" />} />
          </Group>
          <Group title="Data">
            <Row
              icon="cloud"
              title="Sync"
              sub={signedIn ? "Your chats are stored in your account, so they appear on every device you sign in to." : "Demo Mode chats stay in this browser and are never synced."}
            />
            <div className="divider" />
            <Row icon="trash" title="Delete Demo Mode data" sub="Removes Demo Mode chats and documents from this browser" danger onClick={() => setConfirmClear(true)} testId="clear-demo" />
          </Group>
          <Group title="Demo Mode">
            <Row
              icon="sparkle"
              title="Demo Mode"
              sub={s.demoMode ? "On. Answers are simulated in this browser; no AI provider is used." : "Off. Answers come from the providers on your DASH AI server."}
              right={
                <Switch
                  checked={s.demoMode}
                  label="Demo Mode"
                  testId="demo-switch"
                  onChange={(on) => {
                    if (!on) return navigate("/sign-in");
                    app.startDemo();
                  }}
                />
              }
            />
            {s.demoMode && (
              <div role="radiogroup" aria-label="Simulate errors">
                <div className="small faint" style={{ padding: "12px 16px 0" }}>Simulate errors (to see how failures look)</div>
                {(["none", "connection", "provider"] as DemoFailure[]).map((f) => (
                  <Radio key={f} label={f === "none" ? "No errors" : f === "connection" ? "Connection error" : "Provider error"} value={f} current={s.demoFailure} onPick={(v) => set({ demoFailure: v })} testId={`demo-failure-${f}`} />
                ))}
              </div>
            )}
          </Group>
          <Group title="About">
            <div style={{ padding: 16 }} className="stack">
              <Wordmark />
              <span className="muted">Beyond the Digital.</span>
              <span className="small faint">A Dash World product · Web {import.meta.env.VITE_APP_VERSION ?? "0.1.0"}</span>
            </div>
          </Group>
        </main>
      </div>
      {confirmClear && (
        <Confirm
          title="Delete Demo Mode data?"
          text="Demo Mode chats and documents in this browser are removed. Your account (if you have one) is not affected."
          confirm="Delete"
          destructive
          onClose={() => setConfirmClear(false)}
          onConfirm={() => {
            setConfirmClear(false);
            app.clearDemo();
            app.notify("Demo Mode data deleted from this browser");
          }}
        />
      )}
    </>
  );
}
