import { promptCategory, type AssistantMode, type Conversation, type PromptItem } from "@dash-ai/contracts";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { ApiError, DashApi, browserTokenStore, type TokenStore } from "../api/client";
import { clearDemoData, DemoBackend, LiveBackend } from "../chat/backends";
import { ChatEngine, type ChatState } from "../chat/engine";
import type { ChatBackend, PendingAttachment } from "../chat/types";
import { ASSUMED_AVAILABLE, type AssistantAvailability } from "../logic/presentation";
import { DocumentsModel, usableInChat, type DocItem } from "./documents";
import { PromptsModel } from "./prompts";
import { createSettingsStore, type Account, type Settings } from "./settings";
import { navigate } from "./router";
import { Store, useStore } from "./store";

/** Everything the screens share. Created once; tests build their own with fakes. */
export class AppModel {
  readonly settings: Store<Settings>;
  readonly api: DashApi;
  readonly engine: ChatEngine;
  readonly conversations = new Store<{ items: Conversation[]; loading: boolean; error: string | null }>({ items: [], loading: false, error: null });
  /** Whether DASH AI can answer right now. Which AI infrastructure serves it is never shown. */
  readonly assistant = new Store<AssistantAvailability>(ASSUMED_AVAILABLE);
  readonly online = new Store<boolean>(typeof navigator === "undefined" ? true : navigator.onLine);
  readonly toast = new Store<string | null>(null);
  /** The open conversation, as a store (mirrors the chat engine). */
  readonly engineStore: Store<ChatState>;
  readonly composer = new Store<{ text: string; mode: AssistantMode; attachments: PendingAttachment[] }>({
    text: "",
    mode: "general",
    attachments: [],
  });

  readonly documents: DocumentsModel;
  readonly prompts: PromptsModel;

  constructor(
    readonly storage: Storage,
    readonly tokens: TokenStore = browserTokenStore,
    base = "",
  ) {
    this.settings = createSettingsStore(storage);
    this.api = new DashApi(tokens, base, () => this.sessionExpired());
    this.documents = new DocumentsModel(this.api, storage, () => this.live);
    this.prompts = new PromptsModel(storage, () => this.settings.value.account?.id ?? "demo");
    this.engine = new ChatEngine(this.backend());
    this.engineStore = new Store(this.engine.value);
    let wasGenerating = false;
    this.engine.subscribe((state) => {
      this.engineStore.set(state);
      // An answer finished: the chat list has a new or renamed conversation.
      if (wasGenerating && !state.generating) void this.refreshConversations();
      wasGenerating = state.generating;
    });
    const s = this.settings.value;
    this.composer.set((c) => ({ ...c, mode: s.defaultMode }));
    // Signed in according to settings but the token is gone (closed tab without "keep me signed in").
    if (!s.demoMode && s.account && !tokens.get()) this.settings.set((p) => ({ ...p, account: null, demoMode: true, started: false }));
  }

  get live(): boolean {
    const s = this.settings.value;
    return !s.demoMode && s.account !== null;
  }

  backend(): ChatBackend {
    return this.live ? new LiveBackend(this.api) : new DemoBackend(this.storage, () => this.settings.value.demoFailure);
  }

  notify(text: string): void {
    this.toast.set(text);
  }

  async refreshConversations(): Promise<void> {
    this.conversations.set((c) => ({ ...c, loading: true, error: null }));
    try {
      const items = await this.backend().list();
      this.conversations.set({ items, loading: false, error: null });
    } catch (e) {
      this.conversations.set((c) => ({ ...c, loading: false, error: e instanceof ApiError ? e.message : "Couldn't load your chats." }));
    }
  }

  async refreshAssistant(): Promise<void> {
    if (!this.live) return this.assistant.set({ available: true, demo: true });
    try {
      const r = await this.api.assistant();
      this.assistant.set({ available: r.available, demo: r.demo });
    } catch (e) {
      // Keep sending possible; sending will explain any problem.
      this.assistant.set({ ...ASSUMED_AVAILABLE, error: e instanceof ApiError ? e.message : "Couldn't check the server." });
    }
  }

  /** The account (or Demo Mode) changed: start clean so nothing of the previous one stays on screen. */
  private switched(): void {
    this.engine.setBackend(this.backend());
    this.composer.set((c) => ({ ...c, text: "", attachments: [] }));
    this.conversations.set({ items: [], loading: false, error: null });
    this.documents.reset();
    this.prompts.reload();
    void this.refreshConversations();
    void this.refreshAssistant();
  }

  signedIn(token: string, user: Account, remember: boolean): void {
    this.tokens.set(token, remember);
    this.settings.set((s) => ({ ...s, account: user, demoMode: false, started: true }));
    this.switched();
  }

  startDemo(): void {
    this.tokens.set(null);
    this.settings.set((s) => ({ ...s, account: null, demoMode: true, started: true }));
    this.switched();
  }

  /** Signs out on this browser: the server session is revoked when reachable, local session data is removed. */
  async signOut(everywhere = false): Promise<void> {
    if (this.live) {
      if (everywhere) await this.api.logoutAll();
      else await this.api.logout().catch(() => undefined);
      // Like Android on a shared device: this account's own prompts and favourites leave with it.
      this.prompts.clear();
    }
    this.clearSession();
  }

  private clearSession(): void {
    this.tokens.set(null);
    this.settings.set((s) => ({ ...s, account: null, demoMode: true, started: false }));
    this.switched();
    navigate("/sign-in", true);
  }

  private sessionExpired(): void {
    if (!this.live) return;
    this.notify("Your session has ended. Sign in again.");
    this.clearSession();
  }

  async renameConversation(id: string, title: string): Promise<void> {
    try {
      await this.backend().rename(id, title);
      this.engine.renamed(id, title);
      await this.refreshConversations();
    } catch (e) {
      this.notify(e instanceof ApiError ? e.message : "Couldn't rename the chat.");
    }
  }

  async deleteConversation(id: string): Promise<void> {
    try {
      await this.backend().remove(id);
      if (this.engine.value.conversation?.id === id) {
        this.engine.newChat();
        navigate("/", true);
      }
      await this.refreshConversations();
      this.notify("Chat deleted");
    } catch (e) {
      this.notify(e instanceof ApiError ? e.message : "Couldn't delete the chat.");
    }
  }

  // ---- Composer attachments ----

  /** Uploads a file for the next message (Demo Mode: checked in the browser only). */
  async attach(file: File): Promise<void> {
    const localId = crypto.randomUUID();
    const update = (change: (a: PendingAttachment) => PendingAttachment) =>
      this.composer.set((c) => ({ ...c, attachments: c.attachments.map((a) => (a.localId === localId ? change(a) : a)) }));
    if (this.composer.value.attachments.length >= 5) return this.notify("You can attach up to 5 files to one message.");
    this.composer.set((c) => ({ ...c, attachments: [...c.attachments, { localId, name: file.name, sizeBytes: file.size, progress: 0, error: null, attachment: null }] }));
    try {
      const doc = await this.documents.upload(file, (p) => update((a) => ({ ...a, progress: p })));
      this.useDocumentIn(localId, doc);
    } catch (e) {
      update((a) => ({ ...a, error: e instanceof ApiError ? e.message : "The file could not be read." }));
    }
  }

  private useDocumentIn(localId: string, doc: DocItem): void {
    const usable = usableInChat(doc, this.settings.value.demoMode);
    this.composer.set((c) => ({
      ...c,
      attachments: c.attachments.map((a) =>
        a.localId === localId
          ? { ...a, progress: 1, error: usable ? null : doc.statusDetail, attachment: usable ? { id: doc.id, name: doc.name, kind: doc.kind, sizeBytes: doc.sizeBytes } : null }
          : a,
      ),
    }));
  }

  /** "Ask about this document": a new chat in Documents mode with the file attached and optional text ready. */
  askAbout(doc: DocItem, text = ""): void {
    this.engine.newChat();
    this.composer.set((c) => ({
      ...c,
      text,
      mode: "documents",
      attachments: [{ localId: crypto.randomUUID(), name: doc.name, sizeBytes: doc.sizeBytes, progress: 1, error: null, attachment: { id: doc.id, name: doc.name, kind: doc.kind, sizeBytes: doc.sizeBytes } }],
    }));
    navigate("/chat");
  }

  /** The browser lost its connection: an answer that was streaming ends now (kept, with Retry). */
  wentOffline(): void {
    this.online.set(false);
    this.engine.connectionLost();
  }

  /** Back online: bring what may have changed meanwhile (other devices, the server) up to date. */
  backOnline(): void {
    const was = this.online.value;
    this.online.set(true);
    if (was || !this.live) return;
    if (this.engine.value.error?.code === "network") this.engine.dismissError();
    void this.refreshConversations();
    void this.refreshAssistant();
  }

  /** "Use prompt": a new chat in the prompt's mode with its text ready to edit and send. */
  usePrompt(prompt: PromptItem): void {
    this.engine.newChat();
    this.composer.set((c) => ({ ...c, text: prompt.body, mode: promptCategory(prompt.category).mode, attachments: [] }));
    navigate("/chat");
  }

  clearDemo(): void {
    this.documents.clearDemo();
    clearDemoData(this.storage);
    if (!this.live) this.switched();
  }
}

const Ctx = createContext<AppModel | null>(null);

export function AppProvider({ model, children }: { model: AppModel; children: ReactNode }) {
  useEffect(() => {
    const on = () => model.backOnline();
    const off = () => model.wentOffline();
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    void model.refreshConversations();
    void model.refreshAssistant();
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, [model]);
  return <Ctx.Provider value={model}>{children}</Ctx.Provider>;
}

export function useApp(): AppModel {
  const m = useContext(Ctx);
  if (!m) throw new Error("useApp outside AppProvider");
  return m;
}

/** Applies Light / Dark / System to the document. */
export function useTheme(model: AppModel): void {
  const { theme } = useStore(model.settings);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
  }, [theme]);
}

export function useEngine(model: AppModel) {
  const [state, setState] = useState(model.engine.value);
  useEffect(() => {
    setState(model.engine.value);
    return model.engine.subscribe(setState);
  }, [model]);
  return state;
}

export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
