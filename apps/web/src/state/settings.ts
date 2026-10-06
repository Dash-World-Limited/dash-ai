import type { AssistantMode, ModelChoice } from "@dash-ai/contracts";
import type { DemoFailure } from "../chat/backends";
import { Store } from "./store";

export type ThemePreference = "system" | "light" | "dark";

export interface Account {
  id: string;
  email: string;
  displayName: string;
}

/** Preferences kept in this browser. The session token is stored separately (api/client.ts). */
export interface Settings {
  onboarded: boolean;
  theme: ThemePreference;
  /** Demo Mode is on until someone signs in. */
  demoMode: boolean;
  /** The signed-in account (null in Demo Mode or signed out). */
  account: Account | null;
  /** True once the person chose Demo Mode or signed in, so the start screen is skipped. */
  started: boolean;
  defaultChoice: ModelChoice;
  defaultMode: AssistantMode;
  demoFailure: DemoFailure;
}

export const DEFAULT_SETTINGS: Settings = {
  onboarded: false,
  theme: "system",
  demoMode: true,
  account: null,
  started: false,
  defaultChoice: "smart",
  defaultMode: "general",
  demoFailure: "none",
};

const KEY = "dash.settings";

export function loadSettings(storage: Storage): Settings {
  try {
    const parsed = JSON.parse(storage.getItem(KEY) ?? "{}") as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function createSettingsStore(storage: Storage): Store<Settings> {
  const store = new Store(loadSettings(storage));
  store.subscribe(() => {
    try {
      storage.setItem(KEY, JSON.stringify(store.value));
    } catch {
      // Blocked storage: settings last for this visit only.
    }
  });
  return store;
}
