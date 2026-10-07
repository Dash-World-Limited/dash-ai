import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  providerHint,
  smartRoute,
  AssistantMode,
  PROMPT_CATEGORIES,
  PROMPT_LIMITS,
  STARTER_PROMPTS,
  filterPrompts,
  validatePrompt,
  type PromptItem,
  AuthResponse,
  ChatStreamRequest,
  ConversationDetailResponse,
  DataExportResponse,
  DocumentResponse,
  ErrorResponse,
  FILE_RULES,
  HistoryMessage,
  LIMITS,
  MAX_UPLOAD_BYTES,
  PluginsResponse,
  AutomationDetailResponse,
  NotificationListResponse,
  PushDeviceResponse,
  PushPayload,
  PushPreferences,
  PUSH_TEXT,
  ProvidersResponse,
  SMART_ROUTING,
  SyncConversationsResponse,
  SyncPushRequest,
  SyncPushResponse,
  ToolActivityResponse,
  UsageSummaryResponse,
  checkFile,
  decodeStream,
  encodeSseEvent,
  PluginId,
  ToolName,
  otherProvider,
  parseSseText,
  qualifiedToolName,
  resolveProviders,
  type ProviderId,
} from "../src/index.js";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));
const fixture = (name: string) => readFileSync(`${FIXTURES}${name}`, "utf8");
const json = (name: string): unknown => JSON.parse(fixture(name));

describe("JSON fixtures match the schemas", () => {
  it.each([
    ["chat-stream-request.json", ChatStreamRequest],
    ["providers-response.json", ProvidersResponse],
    ["auth-response.json", AuthResponse],
    ["conversation-detail.json", ConversationDetailResponse],
    ["document-response.json", DocumentResponse],
    ["error-response.json", ErrorResponse],
    ["usage-summary.json", UsageSummaryResponse],
    ["plugins-response.json", PluginsResponse],
    ["tool-activity.json", ToolActivityResponse],
    ["automation-detail.json", AutomationDetailResponse],
    ["notification-list.json", NotificationListResponse],
    ["push-payload.json", PushPayload],
    ["push-device.json", PushDeviceResponse],
    ["push-preferences.json", PushPreferences],
    ["sync-conversations.json", SyncConversationsResponse],
    ["sync-push-request.json", SyncPushRequest],
    ["sync-push-response.json", SyncPushResponse],
  ] as const)("%s", (name, schema) => {
    const result = schema.safeParse(json(name));
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it("tool activity in history is optional for older servers and refers only to listed messages in the fixtures", () => {
    const { toolActivity: _omit, ...older } = json("conversation-detail.json") as Record<string, unknown>;
    expect(ConversationDetailResponse.parse(older).toolActivity).toEqual([]);
    const detail = ConversationDetailResponse.parse(json("conversation-detail.json"));
    for (const t of detail.toolActivity) expect(detail.messages.map((m) => m.id)).toContain(t.messageId);
    const sync = SyncConversationsResponse.parse(json("sync-conversations.json"));
    for (const c of sync.changes) {
      for (const t of c.toolActivity) expect(c.messages.map((m) => m.id)).toContain(t.messageId);
    }
    // Names and outcomes only: never arguments or results.
    expect(Object.keys(detail.toolActivity[0]!).sort()).toEqual(["callId", "createdAt", "durationMs", "messageId", "plugin", "status", "tool"]);
  });

  it("prompt-library.json mirrors the prompt library both apps ship", () => {
    const fixture = json("prompt-library.json") as { categories: unknown; limits: unknown; starters: unknown };
    expect(fixture.categories).toEqual(PROMPT_CATEGORIES);
    expect(fixture.limits).toEqual(PROMPT_LIMITS);
    expect(fixture.starters).toEqual(STARTER_PROMPTS);
    expect(new Set(STARTER_PROMPTS.map((p) => p.id)).size).toBe(STARTER_PROMPTS.length);
    for (const c of PROMPT_CATEGORIES) expect(AssistantMode.options).toContain(c.mode);
  });

  it("prompt filtering and validation follow the Android rules", () => {
    const mine: PromptItem = { id: "custom-1", title: "Zebra pitch", body: "Pitch [x]", category: "business", isCustom: true };
    const all = [...STARTER_PROMPTS, mine];
    const favs = new Set(["starter-pp-week"]);
    expect(filterPrompts(all, favs, { kind: "all" }, "")[0]!.id).toBe("starter-pp-week");
    expect(filterPrompts(all, favs, { kind: "favorites" }, "").map((p) => p.id)).toEqual(["starter-pp-week"]);
    expect(filterPrompts(all, favs, { kind: "mine" }, "").map((p) => p.id)).toEqual(["custom-1"]);
    expect(filterPrompts(all, new Set(), { kind: "category", category: "business" }, "").map((p) => p.title)).toEqual([
      "Board update outline", "Competitor snapshot", "One-page business plan", "Pricing strategy", "SWOT analysis", "Zebra pitch",
    ]);
    expect(filterPrompts(all, new Set(), { kind: "all" }, "  SWOT ").map((p) => p.id)).toEqual(["starter-biz-swot"]);
    expect(filterPrompts(all, new Set(), { kind: "all" }, "personal productivity")).toHaveLength(4); // matches the category label
    expect(validatePrompt(" ", "x")).toBe("Give the prompt a title.");
    expect(validatePrompt("t".repeat(81), "x")).toBe("Titles can be up to 80 characters.");
    expect(validatePrompt("Title", "  ")).toBe("Write the prompt text.");
    expect(validatePrompt("Title", "b".repeat(4001))).toBe("Prompts can be up to 4,000 characters.");
    expect(validatePrompt("Title", "Body")).toBeNull();
  });

  it("DASH AI routing: every configured provider, best first; a named provider is only a preference", () => {
    const both = new Set(["openai", "anthropic"] as const);
    expect(smartRoute("general", both)).toEqual(["openai", "anthropic"]);
    expect(smartRoute("writing", both)).toEqual(["anthropic", "openai"]);
    expect(smartRoute("general", both, "anthropic")).toEqual(["anthropic", "openai"]);
    expect(smartRoute("general", new Set(["openai"] as const), "anthropic")).toEqual(["openai"]);
    expect(smartRoute("general", new Set())).toEqual([]);
    expect(providerHint("Give me a Claude-style analysis")).toBe("anthropic");
    expect(providerHint("use ChatGPT for this")).toBe("openai");
    expect(providerHint("answer like gpt-4o would")).toBe("openai");
    expect(providerHint("Approach this like Gemini would")).toBeNull();
    expect(providerHint("compare Claude and ChatGPT")).toBeNull();
    expect(providerHint("plan my week")).toBeNull();
  });

  it("history and stream targets no longer require provider identity", () => {
    expect(HistoryMessage.safeParse({ role: "assistant", content: "earlier answer" }).success).toBe(true);
    expect(HistoryMessage.safeParse({ role: "user", content: "q", origin: "openai" }).success).toBe(false);
    expect(ChatStreamRequest.parse({ conversationId: "conv-00000001", mode: "general", message: { id: "msg-00000001", content: "hi" } }).modelChoice).toBe("smart");
  });

  it("smart-routing.json mirrors SMART_ROUTING", () => {
    expect(json("smart-routing.json")).toEqual(SMART_ROUTING);
  });

  it("file-rules.json mirrors FILE_RULES", () => {
    expect(json("file-rules.json")).toEqual({ maxUploadBytes: MAX_UPLOAD_BYTES, rules: FILE_RULES });
  });

  it("limits.json mirrors LIMITS", () => {
    expect(json("limits.json")).toEqual(LIMITS);
  });
});

describe("SSE transcripts", () => {
  it("decodes the production transcript (DASH AI only, no provider) and skips comments", () => {
    const events = decodeStream(fixture("chat-stream.sse"));
    expect(events.map((e) => e.event)).toEqual([
      "stream.start",
      "message.delta",
      "message.delta",
      "message.end",
      "conversation.title",
      "stream.end",
    ]);
    const start = events[0];
    expect(start?.event === "stream.start" && start.data.targets).toEqual([{ messageId: "a1111111-1111-4111-8111-111111111111", demo: true }]);
    const second = events[2];
    expect(second?.event === "message.delta" && second.data.text).toBe(' — ünïcödé ✓ "quoted"');
  });

  it("decodes a neutral failure with recovery details and no alternative provider", () => {
    const events = decodeStream(fixture("chat-stream-recovery.sse"));
    expect(events.map((e) => e.event)).toEqual(["stream.start", "message.delta", "message.error", "stream.end"]);
    const failure = events[2];
    expect(failure?.event === "message.error" && failure.data.recovery).toEqual({ attempts: 3, alternatives: [] });
    expect(failure?.event === "message.error" && failure.data.error.message).toBe("DASH AI took too long to respond. Please try again.");
  });

  it("consumer fixtures never name the AI infrastructure (operator and routing fixtures excepted)", () => {
    const internal = new Set(["providers-response.json", "smart-routing.json", "prompt-library.json"]);
    for (const name of readdirSync(FIXTURES)) {
      if (internal.has(name)) continue;
      expect(fixture(name), name).not.toMatch(/openai|anthropic|claude|chatgpt|gpt-\d|gemini|"provider"|"compare"/i);
    }
  });

  it("decodes the tool-calling transcript", () => {
    const events = decodeStream(fixture("chat-stream-tools.sse"));
    expect(events.map((e) => e.event)).toEqual([
      "stream.start", "message.delta", "tool.call", "tool.result", "message.delta", "message.delta", "message.end", "stream.end",
    ]);
    const result = events[3];
    expect(result?.event === "tool.result" && result.data).toMatchObject({ plugin: "dash-demo", tool: "text_stats", status: "ok" });
  });

  it("tool events never carry arguments or results", () => {
    for (const e of decodeStream(fixture("chat-stream-tools.sse"))) {
      if (e.event === "tool.call" || e.event === "tool.result") {
        expect(Object.keys(e.data).sort()).not.toContain("arguments");
        expect(Object.keys(e.data).sort()).not.toContain("content");
      }
    }
  });

  it("decodes the error transcript", () => {
    const events = decodeStream(fixture("chat-stream-error.sse"));
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("stream.error");
  });

  it("round-trips encodeSseEvent through parseSseText", () => {
    const encoded = encodeSseEvent({
      event: "message.delta",
      data: { messageId: "a1111111-1111-4111-8111-111111111111", text: "line one\nline two" },
    });
    expect(parseSseText(encoded)).toEqual([
      { event: "message.delta", data: '{"messageId":"a1111111-1111-4111-8111-111111111111","text":"line one\\nline two"}' },
    ]);
  });

  it("joins multi-line data fields and handles CRLF", () => {
    expect(parseSseText("event: x\r\ndata: a\r\ndata: b\r\n\r\n")).toEqual([{ event: "x", data: "a\nb" }]);
  });

  it("rejects unknown events", () => {
    expect(() => decodeStream("event: surprise\ndata: {}\n\n")).toThrow(/Unknown stream event/);
  });
});

describe("plugin and tool schemas", () => {
  it("rejects names that cannot form a valid provider function name", () => {
    expect(PluginId.safeParse("Bad Id").success).toBe(false);
    expect(PluginId.safeParse("mock-github").success).toBe(true);
    expect(ToolName.safeParse("list-issues").success).toBe(false);
    expect(ToolName.safeParse("list_issues").success).toBe(true);
    expect(qualifiedToolName("mock-github", "list_issues")).toBe("mock-github__list_issues");
    expect(qualifiedToolName("a".repeat(32), "b".repeat(30)).length).toBeLessThanOrEqual(64);
  });

  it("export fields added later default to empty so old exports still parse", () => {
    const base = {
      exportedAt: "2026-01-01T00:00:00.000Z",
      user: { id: "u-12345678", email: "a@example.com", displayName: "A", createdAt: "2026-01-01T00:00:00.000Z" },
      conversations: [], documents: [], usage: [],
    };
    expect(DataExportResponse.parse(base)).toMatchObject({ plugins: [], toolActivity: [] });
  });
});

describe("registration", () => {
  it("rejects display names with control characters (PostgreSQL cannot store NUL)", async () => {
    const { RegisterRequest } = await import("../src/index.js");
    const base = { email: "a@example.com", password: "correct horse battery" };
    expect(RegisterRequest.safeParse({ ...base, displayName: "Ada Lovelace" }).success).toBe(true);
    for (const bad of ["Ada\u0000Lovelace", "Ada\u001bLovelace", "Ada\nLovelace"]) {
      expect(RegisterRequest.safeParse({ ...base, displayName: bad }).success).toBe(false);
    }
  });
});

describe("sync push schema", () => {
  const upload = (messages: unknown[]) => ({
    operations: [{ opId: "op-12345678", type: "upload", conversation: { id: "conv-12345678", title: "t", titleIsCustom: false, mode: "general", createdAt: "2026-01-01T00:00:00.000Z" }, messages }],
  });
  it("never accepts assistant messages, provider labels or attachments in an upload", () => {
    const parsed = SyncPushRequest.parse(upload([{ id: "msg-12345678", content: "hi", createdAt: "2026-01-01T00:00:00.000Z", role: "assistant", origin: "openai", attachmentIds: ["x"] }]));
    const op = parsed.operations[0]!;
    expect(op.type === "upload" && Object.keys(op.messages[0]!).sort()).toEqual(["content", "createdAt", "id"]);
  });
  it("bounds operations, messages and content", () => {
    expect(SyncPushRequest.safeParse({ operations: [] }).success).toBe(false);
    const msg = (i: number) => ({ id: `msg-${String(i).padStart(8, "0")}`, content: "x", createdAt: "2026-01-01T00:00:00.000Z" });
    expect(SyncPushRequest.safeParse(upload(Array.from({ length: 101 }, (_, i) => msg(i)))).success).toBe(false);
    expect(SyncPushRequest.safeParse(upload([{ ...msg(1), content: "x".repeat(LIMITS.maxMessageChars + 1) }])).success).toBe(false);
    expect(SyncPushRequest.safeParse(upload([{ ...msg(1), content: "   " }])).success).toBe(false);
    expect(SyncPushRequest.safeParse({ operations: [{ opId: "bad id!", type: "delete", conversationId: "conv-12345678" }] }).success).toBe(false);
  });
});

describe("routing", () => {
  const both = new Set<ProviderId>(["openai", "anthropic"]);
  const openaiOnly = new Set<ProviderId>(["openai"]);
  const none = new Set<ProviderId>();

  it("Dash Smart follows the routing table when everything is configured", () => {
    expect(resolveProviders("smart", "writing", both)).toMatchObject({ ok: true, providers: ["anthropic"] });
    expect(resolveProviders("smart", "business", both)).toMatchObject({ ok: true, providers: ["openai"] });
  });

  it("Dash Smart falls back to the configured provider and says so", () => {
    const result = resolveProviders("smart", "writing", openaiOnly);
    expect(result).toMatchObject({ ok: true, providers: ["openai"] });
    expect(result.ok && result.reason).toMatch(/preferred provider is not configured/);
  });

  it("fails clearly when nothing is configured", () => {
    expect(resolveProviders("smart", "general", none)).toMatchObject({ ok: false, code: "no_provider_available" });
  });

  it("explicit choices never silently switch provider", () => {
    expect(resolveProviders("claude", "general", openaiOnly)).toMatchObject({
      ok: false,
      code: "provider_not_configured",
    });
    expect(resolveProviders("openai", "general", both)).toMatchObject({ ok: true, providers: ["openai"] });
  });

  it("compare needs both providers", () => {
    expect(resolveProviders("compare", "general", both)).toMatchObject({ ok: true, providers: ["openai", "anthropic"] });
    expect(resolveProviders("compare", "general", openaiOnly)).toMatchObject({ ok: false });
  });

  it("otherProvider swaps", () => {
    expect(otherProvider("openai")).toBe("anthropic");
    expect(otherProvider("anthropic")).toBe("openai");
  });
});

describe("file checks", () => {
  it("accepts supported types", () => {
    expect(checkFile("a.pdf", "application/pdf", 10)).toEqual({ ok: true, kind: "pdf" });
    expect(checkFile("Photo.JPG", "image/jpeg", 10)).toEqual({ ok: true, kind: "image" });
    expect(checkFile("notes.txt", "text/plain; charset=utf-8", 10)).toEqual({ ok: true, kind: "txt" });
    expect(checkFile("unknown-mime.docx", "application/octet-stream", 10)).toMatchObject({ ok: true, kind: "docx" });
  });

  it("rejects unsupported, mismatched, empty and oversized files", () => {
    expect(checkFile("run.exe", "application/octet-stream", 10)).toMatchObject({ ok: false, code: "unsupported_media_type" });
    expect(checkFile("fake.pdf", "image/png", 10)).toMatchObject({ ok: false, code: "unsupported_media_type" });
    expect(checkFile("empty.txt", "text/plain", 0)).toMatchObject({ ok: false, code: "bad_request" });
    expect(checkFile("big.pdf", "application/pdf", MAX_UPLOAD_BYTES + 1)).toMatchObject({
      ok: false,
      code: "payload_too_large",
    });
  });
});

describe("history rules", () => {
  it("assistant turns are DASH AI's own; older clients may still send an origin", () => {
    expect(HistoryMessage.safeParse({ role: "assistant", content: "x", origin: null }).success).toBe(true);
    expect(HistoryMessage.safeParse({ role: "assistant", content: "x", origin: "anthropic" }).success).toBe(true);
    expect(HistoryMessage.safeParse({ role: "user", content: "x", origin: "openai" }).success).toBe(false);
  });

  it("rejects blank messages and oversized history", () => {
    const base = json("chat-stream-request.json") as Record<string, unknown>;
    expect(
      ChatStreamRequest.safeParse({ ...base, message: { id: "9a8b7c6d-5e4f", content: "   ", attachmentIds: [] } }).success,
    ).toBe(false);
    const history = Array.from({ length: LIMITS.maxHistoryMessages + 1 }, () => ({ role: "user", content: "hi" }));
    expect(ChatStreamRequest.safeParse({ ...base, history }).success).toBe(false);
  });
});

describe("push notifications", () => {
  it("lock-screen text is fixed, provider-neutral and says DASH AI", () => {
    for (const text of Object.values(PUSH_TEXT)) {
      expect(text.title).toBe("DASH AI");
      expect(`${text.title} ${text.body}`).not.toMatch(/openai|chatgpt|anthropic|claude|gemini|gpt-|model/i);
    }
  });

  it("the payload fixture carries ids and fixed text only, never content or a token", () => {
    const payload = json("push-payload.json") as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["account", "automationId", "body", "createdAt", "notificationId", "runId", "title", "type", "v"]);
    expect(PushPayload.safeParse({ ...payload, type: "chat.message" }).success).toBe(false);
  });
});
