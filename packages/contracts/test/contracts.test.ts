import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
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
  ProvidersResponse,
  SMART_ROUTING,
  SyncConversationsResponse,
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

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8");
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
    ["sync-conversations.json", SyncConversationsResponse],
  ] as const)("%s", (name, schema) => {
    const result = schema.safeParse(json(name));
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
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
  it("decodes the compare transcript and skips comments", () => {
    const events = decodeStream(fixture("chat-stream-compare.sse"));
    expect(events.map((e) => e.event)).toEqual([
      "stream.start",
      "message.delta",
      "message.delta",
      "message.delta",
      "message.end",
      "message.error",
      "conversation.title",
      "stream.end",
    ]);
    const start = events[0];
    expect(start?.event === "stream.start" && start.data.targets.map((t) => t.provider)).toEqual([
      "openai",
      "anthropic",
    ]);
    const third = events[3];
    expect(third?.event === "message.delta" && third.data.text).toBe(' — ünïcödé ✓ "quoted"');
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
  it("requires assistant turns to name their provider", () => {
    expect(HistoryMessage.safeParse({ role: "assistant", content: "x", origin: null }).success).toBe(false);
    expect(HistoryMessage.safeParse({ role: "assistant", content: "x", origin: "anthropic" }).success).toBe(true);
    expect(HistoryMessage.safeParse({ role: "user", content: "x", origin: "openai" }).success).toBe(false);
  });

  it("rejects blank messages and oversized history", () => {
    const base = json("chat-stream-request.json") as Record<string, unknown>;
    expect(
      ChatStreamRequest.safeParse({ ...base, message: { id: "9a8b7c6d-5e4f", content: "   ", attachmentIds: [] } }).success,
    ).toBe(false);
    const history = Array.from({ length: LIMITS.maxHistoryMessages + 1 }, () => ({
      role: "user",
      content: "hi",
      origin: null,
    }));
    expect(ChatStreamRequest.safeParse({ ...base, history }).success).toBe(false);
  });
});
