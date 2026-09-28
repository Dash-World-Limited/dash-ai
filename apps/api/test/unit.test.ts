import type { HistoryMessage } from "@dash-ai/contracts";
import { describe, expect, it } from "vitest";
import { withIdleTimeout, IdleTimeoutError } from "../src/chat/timeouts.js";
import { DEFAULT_TITLE, generateTitle } from "../src/chat/titles.js";
import { StreamRegistry } from "../src/chat/streamRegistry.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { sanitizeFileName, signatureMatches } from "../src/documents/inspect.js";
import { redactSecrets, sanitizeUrl } from "../src/logging.js";
import {
  buildProviderMessages,
  filterHistoryForProvider,
  normalizeTurns,
  renderDocuments,
  trimHistory,
} from "../src/providers/context.js";
import { FakeAdapter, FAKE_TRIGGERS } from "../src/providers/fake.js";
import { buildSystemPrompt, MODE_INSTRUCTIONS } from "../src/providers/instructions.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { toProviderError, type ProviderChunk } from "../src/providers/types.js";
import { hashPassword, hashToken, newSessionToken, verifyPassword } from "../src/security/crypto.js";
import { RateLimiter } from "../src/security/rateLimiter.js";
import type { DocumentRecord } from "../src/store/store.js";
import { contractsFixture, PNG_BYTES } from "./helpers.js";

describe("config", () => {
  it("applies defaults and treats empty strings as unset", () => {
    const c = loadConfig({ OPENAI_API_KEY: "", OPENAI_MODEL: " ", PORT: "" });
    expect(c.port).toBe(8787);
    expect(c.providerMode).toBe("live");
    expect(c.openai.apiKey).toBeUndefined();
    expect(c.openai.model).toBeUndefined();
  });

  it("rejects invalid values without echoing them", () => {
    try {
      loadConfig({ PORT: "not-a-port-secret-value" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toContain("PORT");
      expect((err as Error).message).not.toContain("secret-value");
    }
  });

  it("only configures a live provider when key and model are both present", () => {
    const registry = ProviderRegistry.fromConfig(
      loadConfig({ OPENAI_API_KEY: "sk-test-placeholder-000000000000", ANTHROPIC_MODEL: "some-model" }),
    );
    expect([...registry.configured()]).toEqual([]);
    expect(registry.warnings.join(" ")).toMatch(/OPENAI_MODEL/);
    expect(registry.warnings.join(" ")).toMatch(/ANTHROPIC_API_KEY/);
    expect(registry.status().every((s) => s.mode === "unconfigured")).toBe(true);

    const live = ProviderRegistry.fromConfig(
      loadConfig({ ANTHROPIC_API_KEY: "sk-ant-test-placeholder", ANTHROPIC_MODEL: "configured-claude-model" }),
    );
    expect([...live.configured()]).toEqual(["anthropic"]);
    expect(live.status().find((s) => s.id === "anthropic")).toMatchObject({
      configured: true,
      mode: "live",
      model: "configured-claude-model",
    });
  });

  it("fake mode activates clearly-labelled fake adapters for both providers", () => {
    const registry = ProviderRegistry.fromConfig(loadConfig({ PROVIDER_MODE: "fake" }));
    expect(registry.status().map((s) => s.mode)).toEqual(["fake", "fake"]);
    expect(registry.get("openai")?.demo).toBe(true);
    expect(registry.warnings[0]).toMatch(/fake/);
  });
});

describe("security utilities", () => {
  it("hashes and verifies passwords", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash).toMatch(/^scrypt\$/);
    expect(hash).not.toContain("correct horse");
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });

  it("creates opaque tokens and stores only hashes", () => {
    const token = newSessionToken();
    expect(token).toMatch(/^dash_[A-Za-z0-9_-]{40,}$/);
    expect(hashToken(token)).toHaveLength(64);
    expect(hashToken(token)).not.toContain(token);
  });

  it("rate limiter refills over time", () => {
    let now = 0;
    const limiter = new RateLimiter(2, 60_000, () => now);
    expect(limiter.consume("k").allowed).toBe(true);
    expect(limiter.consume("k").allowed).toBe(true);
    const blocked = limiter.consume("k");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    expect(limiter.consume("other").allowed).toBe(true);
    now += 30_000;
    expect(limiter.consume("k").allowed).toBe(true);
  });

  it("redacts secrets from strings", () => {
    const text =
      "key sk-proj-abcdefghijklmnopqrstuvwxyz0123 and sk-ant-api03-abcdefghijklmnop and Bearer dash_abcdefghijklmnopqrstuvwxyz0123456789 password=hunter22";
    const out = redactSecrets(text);
    expect(out).not.toMatch(/abcdefghijklmnopqrstuvwxyz0123/);
    expect(out).not.toContain("sk-ant-api03");
    expect(out).not.toContain("hunter22");
    expect(out).toContain("[redacted]");
  });

  it("strips query strings from logged URLs", () => {
    expect(sanitizeUrl("/v1/conversations?search=private")).toBe("/v1/conversations?[redacted]");
    expect(sanitizeUrl("/health")).toBe("/health");
  });
});

describe("titles", () => {
  const cases = JSON.parse(contractsFixture("titles.json")) as { input: string; expected: string }[];
  it.each(cases)("$input → $expected", ({ input, expected }) => {
    expect(generateTitle(input)).toBe(expected);
  });

  it("never exceeds 49 characters", () => {
    expect(generateTitle("word ".repeat(100)).length).toBeLessThanOrEqual(49);
    expect(generateTitle("   ")).toBe(DEFAULT_TITLE);
  });
});

describe("provider context", () => {
  const history: HistoryMessage[] = [
    { role: "user", content: "q1", origin: null },
    { role: "assistant", content: "openai answer", origin: "openai" },
    { role: "assistant", content: "claude answer", origin: "anthropic" },
    { role: "user", content: "q2", origin: null },
    { role: "assistant", content: "claude answer 2", origin: "anthropic" },
  ];

  it("never forwards another provider's answers", () => {
    expect(filterHistoryForProvider(history, "openai").map((m) => m.content)).toEqual(["q1", "openai answer", "q2"]);
    expect(filterHistoryForProvider(history, "anthropic").map((m) => m.content)).toEqual([
      "q1",
      "claude answer",
      "q2",
      "claude answer 2",
    ]);
  });

  it("merges consecutive turns so providers receive alternating roles", () => {
    const messages = buildProviderMessages("openai", history, "q3", []);
    expect(messages).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: "openai answer" },
      { role: "user", content: "q2\n\nq3" },
    ]);
  });

  it("drops leading assistant turns", () => {
    expect(
      normalizeTurns([
        { role: "assistant", content: "a" },
        { role: "user", content: "b" },
      ]),
    ).toEqual([{ role: "user", content: "b" }]);
  });

  it("trims the oldest history first", () => {
    const long: HistoryMessage[] = [
      { role: "user", content: "a".repeat(10), origin: null },
      { role: "user", content: "b".repeat(10), origin: null },
    ];
    expect(trimHistory(long, 15).map((m) => m.content[0])).toEqual(["b"]);
  });

  it("wraps documents in delimited, escaped blocks and truncates", () => {
    const doc = (name: string, text: string): DocumentRecord => ({
      id: "doc-00000001",
      userId: "u",
      name,
      kind: "txt",
      mimeType: "text/plain",
      sizeBytes: text.length,
      status: "ready",
      statusDetail: "",
      extractedText: text,
      pageCount: null,
      createdAt: new Date().toISOString(),
    });
    const rendered = renderDocuments([doc('a"<b>.txt', "hello"), doc("big.txt", "x".repeat(70_000))]);
    expect(rendered).toContain('<document name="a&quot;&lt;b&gt;.txt" type="txt">\nhello\n</document>');
    expect(rendered).toContain('name="big.txt" type="txt" truncated="true"');
  });

  it("each mode has distinct instructions and research never claims web access", () => {
    expect(new Set(Object.values(MODE_INSTRUCTIONS)).size).toBe(5);
    expect(MODE_INSTRUCTIONS.research).toMatch(/no live web access/);
    const prompt = buildSystemPrompt("writing", new FakeAdapter("anthropic", 0));
    expect(prompt).toContain("Claude");
    expect(prompt).toContain(MODE_INSTRUCTIONS.writing);
  });
});

describe("fake adapter", () => {
  const collect = async (iterable: AsyncIterable<ProviderChunk>) => {
    const out: ProviderChunk[] = [];
    for await (const c of iterable) out.push(c);
    return out;
  };

  it("labels its output as a demonstration", async () => {
    const chunks = await collect(
      new FakeAdapter("openai", 0).stream({
        system: "s",
        messages: [{ role: "user", content: "hi" }],
        maxOutputTokens: 100,
        signal: new AbortController().signal,
      }),
    );
    const text = chunks.map((c) => (c.type === "text" ? c.text : "")).join("");
    expect(text).toMatch(/^\*\*Demonstration answer — fake OpenAI adapter\.\*\*/);
    expect(text).toContain("no AI provider received your prompt");
    expect(chunks.at(-1)).toMatchObject({ type: "finish", finishReason: "stop" });
  });

  it("supports failure and cancellation triggers", async () => {
    const adapter = new FakeAdapter("anthropic", 0);
    await expect(
      collect(
        adapter.stream({
          system: "s",
          messages: [{ role: "user", content: FAKE_TRIGGERS.error }],
          maxOutputTokens: 10,
          signal: new AbortController().signal,
        }),
      ),
    ).rejects.toMatchObject({ code: "provider_error", retryable: true });

    const controller = new AbortController();
    const pending = collect(
      adapter.stream({
        system: "s",
        messages: [{ role: "user", content: FAKE_TRIGGERS.hang }],
        maxOutputTokens: 10,
        signal: controller.signal,
      }),
    );
    controller.abort("cancelled");
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  });
});

describe("provider error mapping", () => {
  it("maps HTTP statuses without copying provider messages", () => {
    const withStatus = (status: number) => Object.assign(new Error("secret provider detail"), { status });
    expect(toProviderError("OpenAI", withStatus(401))).toMatchObject({ code: "provider_error", retryable: false });
    expect(toProviderError("OpenAI", withStatus(429))).toMatchObject({ code: "rate_limited", retryable: true });
    expect(toProviderError("OpenAI", withStatus(503))).toMatchObject({ code: "provider_error", retryable: true });
    expect(toProviderError("OpenAI", withStatus(400)).message).not.toContain("secret provider detail");
  });

  it("classifies aborts by reason", () => {
    const timeout = new AbortController();
    timeout.abort("timeout");
    expect(toProviderError("Claude", new Error("x"), timeout.signal).code).toBe("provider_timeout");
    const cancel = new AbortController();
    cancel.abort("cancelled");
    expect(toProviderError("Claude", new Error("x"), cancel.signal).code).toBe("cancelled");
  });
});

describe("idle timeout", () => {
  it("passes items through", async () => {
    async function* source() {
      yield 1;
      yield 2;
    }
    const out: number[] = [];
    for await (const n of withIdleTimeout(source(), 1_000, () => undefined)) out.push(n);
    expect(out).toEqual([1, 2]);
  });

  it("fires onIdle and throws if the source ignores the abort", async () => {
    let idled = false;
    const never: AsyncIterable<number> = {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<number>>(() => undefined) }),
    };
    const run = async () => {
      for await (const _ of withIdleTimeout(never, 30, () => (idled = true), 30)) {
        // unreachable
      }
    };
    await expect(run()).rejects.toBeInstanceOf(IdleTimeoutError);
    expect(idled).toBe(true);
  });
});

describe("stream registry", () => {
  it("only lets the owner cancel", () => {
    const registry = new StreamRegistry();
    const controller = new AbortController();
    registry.register("s1", "alice", controller);
    expect(registry.countForUser("alice")).toBe(1);
    expect(registry.cancel("bob", "s1")).toBe(false);
    expect(controller.signal.aborted).toBe(false);
    expect(registry.cancel("alice", "s1")).toBe(true);
    expect(controller.signal.reason).toBe("cancelled");
    registry.unregister("s1");
    expect(registry.size).toBe(0);
  });
});

describe("upload inspection", () => {
  it("checks file signatures", () => {
    expect(signatureMatches("image", PNG_BYTES)).toBe(true);
    expect(signatureMatches("pdf", PNG_BYTES)).toBe(false);
    expect(signatureMatches("pdf", Buffer.from("%PDF-1.7"))).toBe(true);
    expect(signatureMatches("txt", Buffer.from([0x68, 0x00, 0x69]))).toBe(false);
    expect(signatureMatches("image", Buffer.from("RIFF0000WEBPVP8 "))).toBe(true);
  });

  it("sanitises file names", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("C:\\Users\\me\\report.pdf")).toBe("report.pdf");
    expect(sanitizeFileName("a\u0000b\u001f.txt")).toBe("ab.txt");
    expect(sanitizeFileName("")).toBe("document");
  });
});
