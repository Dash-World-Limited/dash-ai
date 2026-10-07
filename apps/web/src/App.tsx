import { useCallback, useState } from "react";
import { AppProvider, useApp, useTheme, type AppModel } from "./state/app";
import { useRoute } from "./state/router";
import { useStore } from "./state/store";
import { Toast } from "./ui/kit";
import { AccountScreen } from "./screens/Account";
import { AutomatesRoutes } from "./screens/Automates";
import { ChatScreen } from "./screens/Chat";
import { DocumentDetail, DocumentsScreen } from "./screens/Documents";
import { Home } from "./screens/Home";
import { PromptsScreen } from "./screens/Prompts";
import { SettingsScreen } from "./screens/Settings";
import { Shell } from "./screens/Shell";
import { SignIn, Splash, Welcome } from "./screens/Start";
import { ToolsScreen } from "./screens/Tools";

function Routes() {
  const app = useApp();
  const settings = useStore(app.settings);
  const { parts } = useRoute();
  useTheme(app);
  if (!settings.onboarded) return <Welcome />;
  if (parts[0] === "sign-in" || !settings.started) return <SignIn />;
  const screen = (() => {
    switch (parts[0]) {
      case "chat":
        return <ChatScreen />;
      case "documents":
        return parts[1] ? <DocumentDetail /> : <DocumentsScreen />;
      case "prompts":
        return <PromptsScreen />;
      case "tools":
        return <ToolsScreen />;
      case "automates":
        return <AutomatesRoutes />;
      case "account":
        return <AccountScreen />;
      case "settings":
        return <SettingsScreen />;
      default:
        return <Home />;
    }
  })();
  return <Shell>{screen}</Shell>;
}

function Toasts() {
  const app = useApp();
  const text = useStore(app.toast);
  const done = useCallback(() => app.toast.set(null), [app]);
  return text ? <Toast text={text} onDone={done} /> : null;
}

export function App({ model, splash = true }: { model: AppModel; splash?: boolean }) {
  const [showSplash, setShowSplash] = useState(splash);
  const hide = useCallback(() => setShowSplash(false), []);
  return (
    <AppProvider model={model}>
      {showSplash && <Splash onDone={hide} />}
      <Routes />
      <Toasts />
    </AppProvider>
  );
}
