import { describe, expect, it } from "vitest";
import { OpenAIAdapter } from "../src/providers/openai.js";
import { AnthropicAdapter } from "../src/providers/anthropic.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { ProviderError, type ProviderAdapter, type ProviderChunk } from "../src/providers/types.js";
import { runAdapterChecks } from "../src/smoke/adapterChecks.js";
import { runAppChecks } from "../src/smoke/appChecks.js";
import { runSmokeCli, SMOKE_ENABLE_HINT } from "../src/smoke/cli.js";
import { makeRedactor } from "../src/smoke/report.js";
import { hasToolResult, scriptedProvider, type ModelPlan, type RecordedRequest } from "./providerServer.js";
import { testConfig } from "./helpers.js";

/** Text of the last user turn, in either provider's wire format. */
function lastUserText(kind: "openai" | "anthropic", req: RecordedRequest): string {
  if (kind === "openai") {
    const items = (req.body.input as Array<{ role?: string; content?: string }>).filter((i) => i.role === "user");
    return items.at(-1)?.content ?? "";
  }
  const msgs = (req.body.messages as Array<{ role: string; content: unknown }>).filter((m) => m.role === "user" && typeof m.content === "string");
  return (msgs.at(-1)?.content as string) ?? "";
}

/** A model that behaves like a competent real one for the smoke prompts. */
const wellBehaved = (kind: "openai" | "anthropic") => (req: RecordedRequest): ModelPlan => {
  const text = lastUserText(kind, req);
  if (text.includes("text_stats tool")) {
    return hasToolResult(kind, req)
      ? { kind: "text", text: "The text has 3 words." }
      : { kind: "tool", name: "dash-demo__text_stats", args: { text: "alpha beta gamma" } };
  }
  if (text.includes("Count from 1 to 15")) {
    return { kind: "text", text: "", chunks: Array.from({ length: 15 }, (_, i) => `${i + 1} `) };
  }
  if (text.includes("1 to 400")) {
    return { kind: "text", text: "", chunks: Array.from({ length: 400 }, (_, i) => `${i + 1}\n`) };
  }
  return { kind: "text", text: "pong" };
};

function liveLikeRegistry(only?: "openai" | "anthropic") {
  // Behave like current models: Claude thinks (and enforces replay of thinking blocks), OpenAI reasons.
  const openai = scriptedProvider("openai", wellBehaved("openai"), "served-openai-2026", { chunkDelayMs: 2, reasoning: true });
  const anthropic = scriptedProvider("anthropic", wellBehaved("anthropic"), "served-claude-2026", { chunkDelayMs: 2, thinking: true });
  const registry = new ProviderRegistry({
    ...(only !== "anthropic" ? { openai: new OpenAIAdapter("sk-test-not-a-real-key", "cfg-openai", { fetch: openai.fetch, maxRetries: 0 }) } : {}),
    ...(only !== "openai" ? { anthropic: new AnthropicAdapter("sk-ant-test-not-real", "cfg-claude", { fetch: anthropic.fetch, maxRetries: 0 }) } : {}),
  });
  return { registry, openai, anthropic };
}

const liveConfig = (over: Record<string, string> = {}) =>
  testConfig({ PROVIDER_MODE: "live", OPENAI_API_KEY: "sk-test-not-a-real-key", OPENAI_MODEL: "cfg-openai", ANTHROPIC_API_KEY: "sk-ant-test-not-real", ANTHROPIC_MODEL: "cfg-claude", ...over });

describe("adapter smoke checks", () => {
  it.each(["openai", "anthropic"] as const)("%s: a well-behaved provider passes every check", async (kind) => {
    const { registry } = liveLikeRegistry();
    const results = await runAdapterChecks(registry.get(kind)!);
    expect(results.map((r) => [r.name, r.status])).toEqual([
      ["normal response", "pass"],
      ["streaming", "pass"],
      ["provider/model metadata", "pass"],
      ["cancellation", "pass"],
      ["tool round trip", "pass"],
    ]);
    const meta = results.find((r) => r.name === "provider/model metadata")!;
    expect(meta.detail).toContain(`served=served-${kind === "openai" ? "openai" : "claude"}-2026`);
    expect(results.find((r) => r.name === "normal response")!.detail).toMatch(/in=10 out=5|in=12 out=7/);
  });

  it("the tool check can be skipped", async () => {
    const { registry } = liveLikeRegistry();
    const results = await runAdapterChecks(registry.get("openai")!, { skipTools: true });
    expect(results.at(-1)).toMatchObject({ name: "tool round trip", status: "skip" });
  });

  it("detects a provider that does not stream incrementally", async () => {
    const lump = scriptedProvider("openai", (req) => (lastUserText("openai", req).includes("Count") ? { kind: "text", text: "", chunks: ["1 2 3 4 5 6 7 8 9 10 11 12 13 14 15"] } : wellBehaved("openai")(req)));
    const adapter = new OpenAIAdapter("sk-test-not-a-real-key", "m", { fetch: lump.fetch, maxRetries: 0 });
    const streaming = (await runAdapterChecks(adapter, { skipTools: true })).find((r) => r.name === "streaming")!;
    expect(streaming).toMatchObject({ status: "fail" });
    expect(streaming.detail).toMatch(/1 piece/);
  });

  function wrap(over: (inner: ProviderAdapter) => Partial<ProviderAdapter>): ProviderAdapter {
    const inner = liveLikeRegistry().registry.get("openai")!;
    return { id: inner.id, displayName: inner.displayName, model: inner.model, demo: false, stream: (r) => inner.stream(r), ...over(inner) };
  }

  it("detects a missing served-model, missing usage and an unfinished answer", async () => {
    const stripped = wrap((inner) => ({
      async *stream(request) {
        for await (const c of inner.stream(request)) {
          yield c.type === "finish" ? { ...c, servedModel: null, usage: { inputTokens: null, outputTokens: null } } : c;
        }
      },
    }));
    const results = await runAdapterChecks(stripped, { skipTools: true });
    expect(results.find((r) => r.name === "normal response")).toMatchObject({ status: "fail" });
    expect(results.find((r) => r.name === "provider/model metadata")).toMatchObject({ status: "fail" });
  });

  it("detects an adapter that ignores cancellation", async () => {
    const deaf = wrap(() => ({
      async *stream(): AsyncIterable<ProviderChunk> {
        for (let i = 0; i < 40; i++) yield { type: "text", text: `${i}\n` };
        yield { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 }, servedModel: "m" };
      },
    }));
    const cancel = (await runAdapterChecks(deaf, { skipTools: true })).find((r) => r.name === "cancellation")!;
    expect(cancel).toMatchObject({ status: "fail" });
    expect(cancel.detail).toMatch(/finished before cancellation/);
  });

  it("reports provider failures with safe text", async () => {
    const broken = wrap(() => ({
      async *stream(): AsyncIterable<ProviderChunk> {
        throw new ProviderError("provider_error", "OpenAI rejected the server's credentials.", false, 401);
      },
    }));
    const first = (await runAdapterChecks(broken, { skipTools: true }))[0]!;
    expect(first).toMatchObject({ status: "fail", detail: "provider_error (HTTP 401): OpenAI rejected the server's credentials." });
  });
});

describe("app-level smoke checks (Dash Smart, explicit choices, Compare, cancellation)", () => {
  it("with both providers: routing follows the table, compare answers twice, cancel keeps a partial answer", async () => {
    const { registry } = liveLikeRegistry();
    const results = await runAppChecks(liveConfig(), registry);
    expect(results.map((r) => [r.name, r.status])).toEqual([
      ["dash smart (general)", "pass"],
      ["dash smart (writing)", "pass"],
      ["explicit openai", "pass"],
      ["explicit claude", "pass"],
      ["compare", "pass"],
      ["cancel via API", "pass"],
    ]);
    expect(results[0]!.detail).toBe("routed to openai");
    expect(results[1]!.detail).toBe("routed to anthropic");
  });

  it("with one provider: smart falls back, and compare/other-provider checks are skipped, not faked", async () => {
    const { registry } = liveLikeRegistry("openai");
    const results = await runAppChecks(liveConfig(), registry);
    const byName = Object.fromEntries(results.map((r) => [r.name, r]));
    expect(byName["dash smart (writing)"]).toMatchObject({ status: "pass", detail: "routed to openai" });
    expect(byName["explicit claude"]!.status).toBe("skip");
    expect(byName.compare!.status).toBe("skip");
    expect(byName["cancel via API"]!.status).toBe("pass");
  });

  it("fails when a live answer is labelled as a demonstration or the model label is wrong", async () => {
    const demo = new OpenAIAdapter("sk-test-not-a-real-key", "cfg-openai", { fetch: scriptedProvider("openai", wellBehaved("openai")).fetch, maxRetries: 0 });
    const lying = { ...demo, id: "openai" as const, displayName: "OpenAI", model: "cfg-openai", demo: true, stream: (r: Parameters<typeof demo.stream>[0]) => demo.stream(r) } as ProviderAdapter;
    const results = await runAppChecks(liveConfig(), new ProviderRegistry({ openai: lying }));
    expect(results.find((r) => r.name === "dash smart (general)")).toMatchObject({ status: "fail" });
  });
});

describe("smoke CLI guards", () => {
  const run = async (argv: string[], env: Record<string, string>, deps = {}) => {
    let text = "";
    const code = await runSmokeCli(argv, env as NodeJS.ProcessEnv, { write: (t) => (text += t) }, deps);
    return { code, text };
  };
  const forbidden = () => {
    throw new Error("must not construct providers");
  };

  it("does nothing, and touches no provider, unless DASH_LIVE_SMOKE=1", async () => {
    const { code, text } = await run([], { PROVIDER_MODE: "live", OPENAI_API_KEY: "sk-canary-0123456789abcdef", OPENAI_MODEL: "m" }, { registryFactory: forbidden });
    expect(code).toBe(0);
    expect(text).toContain("Skipped");
    expect(text).toContain(SMOKE_ENABLE_HINT.split("\n")[0]);
    expect(text).not.toContain("sk-canary");
  });

  it("refuses fake mode, missing providers, bad flags and invalid configuration", async () => {
    expect((await run([], { DASH_LIVE_SMOKE: "1", PROVIDER_MODE: "fake" }, { registryFactory: forbidden })).code).toBe(2);
    const none = await run([], { DASH_LIVE_SMOKE: "1", PROVIDER_MODE: "live" });
    expect(none.code).toBe(2);
    expect(none.text).toContain("No provider is configured");
    expect((await run(["--provider", "bogus"], { DASH_LIVE_SMOKE: "1", PROVIDER_MODE: "live" })).code).toBe(2);
    expect((await run([], { DASH_LIVE_SMOKE: "1", PORT: "not-a-port" })).code).toBe(2);
    // Only one provider configured but the other requested.
    const wrongOne = await run(["--provider", "anthropic"], { DASH_LIVE_SMOKE: "1", PROVIDER_MODE: "live", OPENAI_API_KEY: "sk-test-not-a-real-key", OPENAI_MODEL: "m" });
    expect(wrongOne.code).toBe(2);
  });

  const env = { DASH_LIVE_SMOKE: "1", PROVIDER_MODE: "live", OPENAI_API_KEY: "sk-canary-openai-0123456789", OPENAI_MODEL: "cfg-openai", ANTHROPIC_API_KEY: "sk-canary-claude-0123456789", ANTHROPIC_MODEL: "cfg-claude", LOG_LEVEL: "silent" };

  it("runs every check, prints a summary and exits 0 when all pass", async () => {
    const { code, text } = await run([], env, { registryFactory: () => liveLikeRegistry().registry });
    expect(code).toBe(0);
    expect(text).toMatch(/Running live smoke checks against OpenAI \(cfg-openai\) and Claude \(cfg-claude\)/);
    expect(text).toMatch(/PASS\s+openai\s+tool round trip/);
    expect(text).toMatch(/PASS\s+app\s+compare/);
    expect(text).toMatch(/\d+ passed, 0 failed, 0 skipped\./);
    expect(text).not.toContain("sk-canary");
  });

  it("--provider limits the run to one provider", async () => {
    const { code, text } = await run(["--provider", "anthropic", "--skip-tools"], env, { registryFactory: () => liveLikeRegistry().registry });
    expect(code).toBe(0);
    expect(text).not.toMatch(/\bopenai\b\s+(normal|streaming)/);
    expect(text).toMatch(/PASS\s+anthropic\s+streaming/);
    expect(text).toMatch(/SKIP\s+anthropic\s+tool round trip/);
    expect(text).toMatch(/SKIP\s+app\s+compare/);
  });

  it("exits 1 on a failed check, and never prints a secret even if a provider error contains one", async () => {
    const leaky: ProviderAdapter = {
      id: "openai", displayName: "OpenAI", model: "cfg-openai", demo: false,
      async *stream(): AsyncIterable<ProviderChunk> {
        throw new ProviderError("provider_error", `bad key ${env.OPENAI_API_KEY} and ${env.ANTHROPIC_API_KEY}`, false, 401);
      },
    };
    const { code, text } = await run(["--provider", "openai", "--skip-tools"], env, { registryFactory: () => new ProviderRegistry({ openai: leaky }) });
    expect(code).toBe(1);
    expect(text).toMatch(/FAIL\s+openai\s+normal response/);
    expect(text).toContain("[redacted]");
    expect(text).not.toContain("sk-canary");
  });
});

describe("redaction", () => {
  it("replaces every occurrence of each secret and ignores short or missing ones", () => {
    const redact = makeRedactor(["sk-secret-AAAAAAAA", undefined, "abc"]);
    expect(redact("a sk-secret-AAAAAAAA b sk-secret-AAAAAAAA abc")).toBe("a [redacted] b [redacted] abc");
  });
});

