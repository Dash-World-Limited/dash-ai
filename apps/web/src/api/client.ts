import type {
  Automation,
  AutomationDetailResponse,
  AutomationListResponse,
  AutomationRunResponse,
  CreateAutomationRequest,
  NotificationListResponse,
  UpdateAutomationRequest,
  AuthResponse,
  ConversationDetailResponse,
  ConversationListResponse,
  DocumentListResponse,
  DocumentResponse,
  ErrorCode,
  MeResponse,
  PluginInfo,
  PluginsResponse,
  AssistantStatusResponse,
  UsageSummaryResponse,
} from "@dash-ai/contracts";

/** A user-safe error from the API (or a network failure), shown as-is in the UI. */
export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode | "network" | "bad_response",
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }

  static network(): ApiError {
    return new ApiError("network", "Couldn't reach the DASH AI server. Check your connection and try again.", true);
  }

  static connectionLost(): ApiError {
    return new ApiError("network", "The connection was lost before the answer finished. What arrived is kept; try again when you're back online.", true);
  }
}

/** Where the session token lives. "remember" keeps it across browser restarts; otherwise only this tab session. */
export interface TokenStore {
  get(): string | null;
  set(token: string | null, remember?: boolean): void;
}

const KEY = "dash.session";

export const browserTokenStore: TokenStore = {
  get: () => sessionStorage.getItem(KEY) ?? localStorage.getItem(KEY),
  set: (token, remember = false) => {
    sessionStorage.removeItem(KEY);
    localStorage.removeItem(KEY);
    if (token) (remember ? localStorage : sessionStorage).setItem(KEY, token);
  },
};

async function toError(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as { error?: { code: ErrorCode; message: string; retryable: boolean } };
    if (body.error) return new ApiError(body.error.code, body.error.message, body.error.retryable, response.status);
  } catch {
    // Not JSON: fall through to a generic message.
  }
  if (response.status === 401) return new ApiError("unauthorized", "Sign in to continue.", false, 401);
  return new ApiError(
    "internal_error",
    response.status >= 500 ? "The DASH AI server had a problem. Try again shortly." : `The request failed (HTTP ${response.status}).`,
    response.status >= 500,
    response.status,
  );
}

/**
 * The only network client in the web app. It talks to the DASH AI API on this origin; AI service
 * keys never reach the browser. `onUnauthorized` lets the app sign out when the session expires.
 */
export class DashApi {
  constructor(
    private readonly tokens: TokenStore,
    private readonly base = "",
    private readonly onUnauthorized: () => void = () => undefined,
  ) {}

  private headers(json: boolean): HeadersInit {
    const h: Record<string, string> = {};
    const token = this.tokens.get();
    if (token) h.authorization = `Bearer ${token}`;
    if (json) h["content-type"] = "application/json";
    return h;
  }

  async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.base}${path}`, {
        method,
        headers: this.headers(body !== undefined),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      throw ApiError.network();
    }
    if (!response.ok) {
      const error = await toError(response);
      if (response.status === 401 && this.tokens.get()) this.onUnauthorized();
      throw error;
    }
    if (response.status === 204) return undefined as T;
    try {
      return (await response.json()) as T;
    } catch {
      throw new ApiError("bad_response", "The server sent a response this app does not understand.", false);
    }
  }

  /** Opens the chat stream; the caller reads the SSE body. */
  async openStream(body: unknown, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    let response: Response;
    try {
      response = await fetch(`${this.base}/v1/chat/stream`, {
        method: "POST",
        headers: { ...this.headers(true), accept: "text/event-stream" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      throw ApiError.network();
    }
    if (!response.ok || !response.body) {
      const error = await toError(response);
      if (response.status === 401) this.onUnauthorized();
      throw error;
    }
    return response.body;
  }

  // ---- Auth and account ----
  register = (email: string, password: string, displayName: string) =>
    this.request<AuthResponse>("POST", "/v1/auth/register", { email: email.trim(), password, displayName: displayName.trim() });
  login = (email: string, password: string) => this.request<AuthResponse>("POST", "/v1/auth/login", { email: email.trim(), password });
  logout = () => this.request<void>("POST", "/v1/auth/logout");
  logoutAll = () => this.request<void>("POST", "/v1/auth/logout-all");
  me = () => this.request<MeResponse>("GET", "/v1/me");
  deleteAccount = () => this.request<void>("DELETE", "/v1/me");
  usage = () => this.request<UsageSummaryResponse>("GET", "/v1/usage");

  // ---- DASH AI availability (the AI infrastructure behind it is never exposed) ----
  assistant = () => this.request<AssistantStatusResponse>("GET", "/v1/assistant");

  // ---- Conversations ----
  conversations = () => this.request<ConversationListResponse>("GET", "/v1/conversations");
  conversation = (id: string) => this.request<ConversationDetailResponse>("GET", `/v1/conversations/${encodeURIComponent(id)}`);
  renameConversation = (id: string, title: string) => this.request<unknown>("PATCH", `/v1/conversations/${encodeURIComponent(id)}`, { title });
  deleteConversation = (id: string) => this.request<void>("DELETE", `/v1/conversations/${encodeURIComponent(id)}`);
  cancelStream = (streamId: string) => this.request<unknown>("POST", `/v1/chat/streams/${encodeURIComponent(streamId)}/cancel`);

  // ---- Documents ----
  documents = () => this.request<DocumentListResponse>("GET", "/v1/documents");
  deleteDocument = (id: string) => this.request<void>("DELETE", `/v1/documents/${encodeURIComponent(id)}`);

  /** Uploads with progress (XMLHttpRequest: fetch has no upload progress). */
  uploadDocument(file: File, onProgress: (fraction: number) => void): Promise<DocumentResponse> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${this.base}/v1/documents`);
      const token = this.tokens.get();
      if (token) xhr.setRequestHeader("authorization", `Bearer ${token}`);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      };
      xhr.onerror = () => reject(ApiError.network());
      xhr.onload = () => {
        const fake = new Response(xhr.responseText, { status: xhr.status });
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText) as DocumentResponse);
          } catch {
            reject(new ApiError("bad_response", "The server sent a response this app does not understand.", false));
          }
        } else {
          void toError(fake).then(reject);
        }
      };
      const form = new FormData();
      form.append("file", file, file.name);
      xhr.send(form);
    });
  }

  // ---- DASH Automates ----
  automations = () => this.request<AutomationListResponse>("GET", "/v1/automations");
  automation = (id: string) => this.request<AutomationDetailResponse>("GET", `/v1/automations/${encodeURIComponent(id)}`);
  createAutomation = (body: CreateAutomationRequest) => this.request<Automation>("POST", "/v1/automations", body);
  updateAutomation = (id: string, body: UpdateAutomationRequest) => this.request<Automation>("PATCH", `/v1/automations/${encodeURIComponent(id)}`, body);
  pauseAutomation = (id: string) => this.request<Automation>("POST", `/v1/automations/${encodeURIComponent(id)}/pause`);
  resumeAutomation = (id: string) => this.request<Automation>("POST", `/v1/automations/${encodeURIComponent(id)}/resume`);
  deleteAutomation = (id: string) => this.request<void>("DELETE", `/v1/automations/${encodeURIComponent(id)}`);
  runAutomation = (id: string) => this.request<AutomationRunResponse>("POST", `/v1/automations/${encodeURIComponent(id)}/run`);
  automationRun = (id: string, runId: string) =>
    this.request<AutomationRunResponse>("GET", `/v1/automations/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}`);
  editAutomationRun = (id: string, runId: string, content: string) =>
    this.request<AutomationRunResponse>("PATCH", `/v1/automations/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}`, { content });
  regenerateAutomationRun = (id: string, runId: string) =>
    this.request<AutomationRunResponse>("POST", `/v1/automations/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/regenerate`);
  notifications = () => this.request<NotificationListResponse>("GET", "/v1/notifications");
  markNotificationsRead = (ids?: string[]) => this.request<{ updated: number }>("POST", "/v1/notifications/read", ids ? { ids } : {});

  // ---- Tools ----
  plugins = () => this.request<PluginsResponse>("GET", "/v1/plugins");
  setPlugin = (id: string, enabled: boolean, grantedScopes?: string[]) =>
    this.request<PluginInfo>("PUT", `/v1/plugins/${encodeURIComponent(id)}`, grantedScopes ? { enabled, grantedScopes } : { enabled });
}
