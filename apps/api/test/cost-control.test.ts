import { Automation, AutomationDetailResponse, AutomationRunResponse, type ProviderId, type StreamEvent } from "@dash-ai/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { containsProviderName, NEUTRAL_UNAVAILABLE } from "../src/chat/publicSurface.js";
import { estimateTokensForLedger, QUOTA_PAUSE_MS, requestChars } from "../src/intelligence/ledger.js";
import { roundGrowthTokens, roundInputBudgets, worstCaseUsd } from "../src/intelligence/worstCase.js";
import { BedrockAdapter } from "../src/providers/bedrock.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { toProviderError, type ProviderAdapter, type ProviderChunk, type ProviderRequest } from "../src/providers/types.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import type { InferenceAttemptRow, Store } from "../src/store/store.js";
import { chatBody, makeApp, multipart, register, sse, testConfig, testId, USING_POSTGRES } from "./helpers.js";
import { createTestPgStore } from "./pgTestStore.js";

// Provider and cost control end to end: the inference ledger, privacy routing, the free pool, quotas,
// pauses and the spend circuit breakers, through the real chat and Automates paths. Every provider
// here is in-process; nothing leaves the test.

/** What one provider request does. */
type Step = "answer" | "answer-no-usage" | "answer-provider-cost" | "503" | "429" | "429-long" | "quota" | "partial-then-503" | "tool";

class Engine implements ProviderAdapter {
  readonly demo = false;
  readonly requests: ProviderRequest[] = [];
  /** Steps for the next requests, in order; afterwards `otherwise`. */
  steps: Step[] = [];
  otherwise: Step = "answer";
  /** The model id the provider reports for its answers (default: the configured one). */
  served?: string;
  /** What a "tool" step writes before asking for a tool (its output is sent back next round). */
  toolRoundText = "Checking the time.";
  constructor(
    readonly id: ProviderId,
    readonly model: string,
    readonly displayName: string,
  ) {}

  get calls(): number {
    return this.requests.length;
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderChunk> {
    this.requests.push(request);
    const step = this.steps.shift() ?? this.otherwise;
    switch (step) {
      case "503":
        throw toProviderError(this.displayName, { status: 503 });
      case "429":
        throw toProviderError(this.displayName, { status: 429 });
      case "429-long":
        throw toProviderError(this.displayName, { status: 429, headers: { "retry-after": "120" } });
      case "quota":
        throw toProviderError(this.displayName, { status: 429, code: "insufficient_quota" });
      case "partial-then-503":
        yield { type: "text", text: "Here is the start " };
        throw toProviderError(this.displayName, { status: 503 });
      case "tool":
        yield { type: "text", text: this.toolRoundText };
        yield { type: "tool_calls", calls: [{ id: `call_${this.calls}`, name: "dash-demo__current_time", argumentsJson: "{}" }] };
        yield { type: "finish", finishReason: "stop", usage: { inputTokens: 1_000, outputTokens: 500 }, servedModel: this.model };
        return;
      default:
        yield { type: "text", text: ANSWER };
        yield {
          type: "finish",
          finishReason: "stop",
          usage: step === "answer-no-usage" ? { inputTokens: null, outputTokens: null } : { inputTokens: 1_000, outputTokens: 500 },
          servedModel: this.served ?? this.model,
          ...(step === "answer-provider-cost" ? { providerCostUsd: 0.5 } : {}),
        };
    }
  }
}

const ANSWER = "Here is a plan for your week.";
const PROMPT = "PROMPT-CANARY-7f3a plan my week";
// Output-only prices keep the arithmetic exact: an answer's cost, and a request's worst case under
// MAX_OUTPUT_TOKENS=500, do not depend on how long the system prompt is.
const PRICES = {
  "openai:paid-a-model": { inputPerMillion: 0, outputPerMillion: 50 },
  "anthropic:paid-b-model": { inputPerMillion: 0, outputPerMillion: 50 },
};
/** One paid answer as the engines report it (500 output tokens × $50/M), and also a request's worst case (MAX_OUTPUT_TOKENS=500). */
const PAID_ANSWER_USD = 0.025;
const FREEPOOL = {
  id: "freepool",
  displayName: "FREEPOOL-NAME",
  baseUrl: "https://free.example.test/v1",
  apiKeyEnv: "FREEPOOL_API_KEY",
  model: "free-model",
  contextTokens: 32_000,
  pricing: "free",
  privacy: "non_sensitive_only",
  inputPerMillion: 0,
  outputPerMillion: 0,
  quality: 0.8,
};
const OPERATOR = "operator-token-for-tests-0123456789abcdef";
const START = Date.parse("2026-10-12T09:00:00Z");
const HOUR = 3_600_000;

const apps: FastifyInstance[] = [];
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
  while (disposers.length) await disposers.pop()!();
});

async function sharedStore(): Promise<Store> {
  if (!USING_POSTGRES) return new MemoryStore();
  const pg = await createTestPgStore();
  disposers.push(() => pg.dispose());
  return pg.store;
}

interface Options {
  /** Register the free compatible provider (and switch the free pool on). */
  free?: boolean;
  /** Register the two paid providers (default true). */
  paid?: boolean;
  env?: Record<string, string>;
  store?: Store;
  clock?: { t: number };
}

async function setup(o: Options = {}) {
  const a = new Engine("openai", "paid-a-model", "PAIDA-NAME");
  const b = new Engine("anthropic", "paid-b-model", "PAIDB-NAME");
  const f = new Engine("freepool", "free-model", "FREEPOOL-NAME");
  const adapters: Partial<Record<ProviderId, ProviderAdapter>> = {
    ...(o.paid !== false ? { openai: a, anthropic: b } : {}),
    ...(o.free ? { freepool: f } : {}),
  };
  const clock = o.clock ?? { t: START };
  const config = testConfig({
    PROVIDER_DETAILS: "hidden",
    PROVIDER_RETRY_BASE_MS: "0",
    PROVIDER_MAX_RETRIES: "0",
    MAX_OUTPUT_TOKENS: "500",
    OPERATOR_TOKEN: OPERATOR,
    MODEL_PRICES: JSON.stringify(PRICES),
    COMPATIBLE_PROVIDERS: JSON.stringify([FREEPOOL]),
    ...(o.free ? { FREE_POOL_ENABLED: "true" } : {}),
    ...o.env,
  });
  const providers = new ProviderRegistry(adapters, [], [{ id: "freepool", displayName: "FREEPOOL-NAME" }]);
  const made = await makeApp({ config, providers, store: o.store, now: () => new Date(clock.t) });
  apps.push(made.app);
  const user = await register(made.app);
  // The paid providers in the order DASH AI tries them for a general chat.
  const route = made.context.router.route({ task: "chat", mode: "general" });
  const [primary, backup] = route.ok ? route.providers.filter((p) => p !== "freepool").map((p) => (p === "openai" ? a : b)) : [a, b];
  return { ...made, a, b, f, primary: primary!, backup: backup!, clock, user };
}

const byEvent = <N extends StreamEvent["event"]>(events: StreamEvent[], name: N) =>
  events.filter((e): e is Extract<StreamEvent, { event: N }> => e.event === name);

async function chat(app: FastifyInstance, auth: Record<string, string>, over: { content?: string; attachmentIds?: string[] } = {}) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/chat/stream",
    headers: auth,
    payload: chatBody({ modelChoice: "smart", mode: "general", message: { id: testId("msg"), content: over.content ?? PROMPT, attachmentIds: over.attachmentIds ?? [] } }),
  });
  const events = res.statusCode === 200 ? sse(res.body) : [];
  const messageId = byEvent(events, "stream.start")[0]?.data.targets[0]?.messageId ?? "";
  const text = byEvent(events, "message.delta").map((e) => e.data.text).join("");
  const failed = byEvent(events, "message.error").length > 0;
  return { res, events, messageId, text, failed };
}

/** A message's ledger rows in the order they happened. */
async function rows(store: Store, inferenceId: string): Promise<InferenceAttemptRow[]> {
  return (await store.listInferenceAttempts(inferenceId)).sort((x, y) => x.fallbackIndex - y.fallbackIndex || x.round - y.round || x.retry - y.retry);
}

const paidSpend = async (store: Store, since = new Date(START - 24 * HOUR).toISOString()) =>
  (await store.sumInferenceSpend({ since, pricing: ["paid"] })).costUsd;

/** A finished paid attempt recorded directly (spend from earlier, before this test's requests). */
function pastAttempt(over: Partial<InferenceAttemptRow>): InferenceAttemptRow {
  return {
    id: testId("att"),
    inferenceId: testId("inf"),
    userId: null,
    plan: "standard",
    task: "chat",
    mode: "general",
    provider: "openai",
    model: "paid-a-model",
    configuredModel: "paid-a-model",
    pricing: "paid",
    createdAt: new Date(START - HOUR).toISOString(),
    latencyMs: 100,
    outcome: "success",
    errorCode: null,
    httpStatus: null,
    retry: 0,
    round: 0,
    fallbackIndex: 0,
    inputTokens: 1_000,
    outputTokens: 500,
    cachedInputTokens: null,
    estimatedInputTokens: 900,
    estimatedOutputTokens: 400,
    tokenSource: "provider",
    estimatedCostUsd: PAID_ANSWER_USD,
    providerCostUsd: null,
    currency: "USD",
    route: { routeKey: "chat:general" },
    ...over,
  };
}

const LEAK = /freepool|FREEPOOL|PAID[AB]-NAME|paid-[ab]-model|free-model|costUsd|CostUsd|"pricing"|"privacy"|quota|non_sensitive|approved_sensitive/;

describe("the inference ledger", () => {
  it("records every attempt (retries and fallbacks), prefers provider-reported tokens and labels estimates", async () => {
    const s = await setup({ env: { PROVIDER_MAX_RETRIES: "1" } });
    s.primary.steps = ["503", "503"];
    s.backup.otherwise = "answer-no-usage";
    const r = await chat(s.app, s.user.auth);
    expect(r.text).toBe(ANSWER);
    const ledger = await rows(s.context.store, r.messageId);
    expect(ledger.map((x) => [x.provider, x.fallbackIndex, x.retry, x.outcome, x.errorCode, x.httpStatus])).toEqual([
      [s.primary.id, 0, 0, "failure", "provider_error", 503],
      [s.primary.id, 0, 1, "failure", "provider_error", 503],
      [s.backup.id, 1, 0, "success", null, null],
    ]);
    // A refused request (an HTTP error before any output) generated nothing billable.
    for (const x of ledger.slice(0, 2)) expect(x).toMatchObject({ estimatedInputTokens: 0, estimatedOutputTokens: 0, estimatedCostUsd: 0, tokenSource: "estimated" });
    // No usage reported: the answer is estimated (conservatively, about three characters per token) and says so.
    const answered = ledger[2]!;
    expect(answered).toMatchObject({
      inferenceId: r.messageId,
      userId: s.user.user.id,
      plan: "standard",
      task: "chat",
      mode: "general",
      pricing: "paid",
      tokenSource: "estimated",
      inputTokens: null,
      outputTokens: null,
      estimatedOutputTokens: Math.ceil(ANSWER.length / 3),
      currency: "USD",
    });
    expect(answered.estimatedInputTokens).toBeGreaterThan(PROMPT.length / 3);
    expect(answered.estimatedCostUsd).toBeCloseTo((answered.estimatedOutputTokens * 50) / 1e6, 10);
    expect(answered.route).toMatchObject({ routeKey: "chat:general", order: [s.primary.id, s.backup.id], sensitivity: "sensitive" });

    // Provider-reported usage is the accounting truth when present.
    s.backup.otherwise = "answer";
    const second = await chat(s.app, s.user.auth);
    const reported = (await rows(s.context.store, second.messageId)).find((x) => x.outcome === "success");
    expect(reported).toMatchObject({ tokenSource: "provider", inputTokens: 1_000, outputTokens: 500, estimatedCostUsd: PAID_ANSWER_USD, providerCostUsd: null });
  });

  it("a ledger write failure never breaks an answer, and is counted so operators can alert on it", async () => {
    class FailingLedgerStore extends MemoryStore {
      override async recordInferenceAttempt(): Promise<void> {
        throw new Error("ledger unavailable");
      }
    }
    const s = await setup({ store: new FailingLedgerStore() });
    expect((await chat(s.app, s.user.auth)).text).toBe(ANSWER);
    expect(s.context.metrics.render()).toMatch(/dash_ai_ledger_write_failures_total 1/);
  });

  it("stores no message content, prompts or answers", async () => {
    const s = await setup();
    const r = await chat(s.app, s.user.auth);
    const stored = JSON.stringify(await rows(s.context.store, r.messageId));
    expect(stored).not.toContain("PROMPT-CANARY");
    expect(stored).not.toContain(ANSWER);
  });

  it("a failure after output is final (no duplicate answer) and is estimated as possibly billed", async () => {
    const s = await setup({ env: { PROVIDER_MAX_RETRIES: "2" } });
    s.primary.steps = ["partial-then-503"];
    const r = await chat(s.app, s.user.auth);
    expect(r.failed).toBe(true);
    expect([s.primary.calls, s.backup.calls]).toEqual([1, 0]);
    const [only, ...rest] = await rows(s.context.store, r.messageId);
    expect(rest).toEqual([]);
    expect(only).toMatchObject({ outcome: "failure", tokenSource: "estimated", estimatedOutputTokens: Math.ceil("Here is the start ".length / 3) });
    expect(only!.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("demonstration answers (fake mode) cost nothing and no spend limit stops them", async () => {
    const { app, context } = await makeApp({ env: { MAX_DAILY_AI_SPEND: "0", MAX_MONTHLY_AI_SPEND: "0", PAID_PROVIDERS_ENABLED: "false", PROVIDER_DETAILS: "hidden" } });
    apps.push(app);
    const user = await register(app);
    const r = await chat(app, user.auth);
    expect(r.res.statusCode).toBe(200);
    expect(r.failed).toBe(false);
    const ledger = await rows(context.store, r.messageId);
    expect(ledger.length).toBeGreaterThan(0);
    for (const x of ledger) expect(x).toMatchObject({ pricing: "demo", estimatedCostUsd: 0, outcome: "success" });
    expect(context.ai.quota.status(ledger[0]!.provider).windows).toEqual([]);
  });

  it("account deletion keeps the accounting but removes the link to the person", async () => {
    const s = await setup();
    const r = await chat(s.app, s.user.auth);
    expect((await rows(s.context.store, r.messageId))[0]!.userId).toBe(s.user.user.id);
    expect((await s.app.inject({ method: "DELETE", url: "/v1/me", headers: s.user.auth })).statusCode).toBe(204);
    expect((await rows(s.context.store, r.messageId)).map((x) => x.userId)).toEqual([null]);
    expect(await paidSpend(s.context.store)).toBeCloseTo(PAID_ANSWER_USD, 10);
  });
});

describe("privacy routing and the free pool", () => {
  it("sensitive content (the default) never reaches a provider approved only for non-sensitive content", async () => {
    const s = await setup({ free: true });
    const r = await chat(s.app, s.user.auth);
    expect(r.text).toBe(ANSWER);
    expect(s.f.calls).toBe(0);
    const [served] = await rows(s.context.store, r.messageId);
    expect(served).toMatchObject({ pricing: "paid", route: { sensitivity: "sensitive" } });
    expect(served!.route.rejected).toContainEqual({ provider: "freepool", reason: "privacy" });
  });

  it("with only an ineligible provider, a sensitive request is refused in DASH AI's words, never sent", async () => {
    const s = await setup({ free: true, paid: false });
    const r = await chat(s.app, s.user.auth);
    expect(r.res.statusCode).toBe(503);
    expect(r.res.json().error.message).toBe(NEUTRAL_UNAVAILABLE);
    expect(s.f.calls).toBe(0);
  });

  it("a suitable free provider is preferred for standard content; attached documents keep a request sensitive", async () => {
    const s = await setup({ free: true, env: { AI_DEFAULT_SENSITIVITY: "standard" } });
    const r = await chat(s.app, s.user.auth);
    expect(r.text).toBe(ANSWER);
    const [served] = await rows(s.context.store, r.messageId);
    expect(served).toMatchObject({ provider: "freepool", pricing: "free", estimatedCostUsd: 0, route: { sensitivity: "standard", order: ["freepool", s.primary.id, s.backup.id] } });
    expect([s.f.calls, s.a.calls + s.b.calls]).toEqual([1, 0]);

    const form = multipart("notes.txt", "text/plain", Buffer.from("Private notes: salary review."));
    const doc = await s.app.inject({ method: "POST", url: "/v1/documents", headers: { ...s.user.auth, ...form.headers }, payload: form.payload });
    expect(doc.statusCode).toBe(201);
    const withDoc = await chat(s.app, s.user.auth, { attachmentIds: [doc.json().id] });
    expect(withDoc.text).toBe(ANSWER);
    expect(s.f.calls).toBe(1);
    expect((await rows(s.context.store, withDoc.messageId))[0]).toMatchObject({ pricing: "paid", route: { sensitivity: "sensitive" } });
  });

  it("when the free provider fails, a paid provider serves; only the paid answer counts as spend", async () => {
    const s = await setup({ free: true, env: { AI_DEFAULT_SENSITIVITY: "standard" } });
    s.f.steps = ["503"];
    const r = await chat(s.app, s.user.auth);
    expect(r.text).toBe(ANSWER);
    expect((await rows(s.context.store, r.messageId)).map((x) => [x.provider, x.pricing, x.fallbackIndex, x.outcome])).toEqual([
      ["freepool", "free", 0, "failure"],
      [s.primary.id, "paid", 1, "success"],
    ]);
    expect(await paidSpend(s.context.store)).toBeCloseTo(PAID_ANSWER_USD, 10);
  });

  it("FREE_POOL_ENABLED=false (the default) keeps free providers out; PAID_PROVIDERS_ENABLED=false keeps paid ones out", async () => {
    const off = await setup({ free: true, env: { FREE_POOL_ENABLED: "false", AI_DEFAULT_SENSITIVITY: "standard" } });
    await chat(off.app, off.user.auth);
    expect(off.f.calls).toBe(0);

    const freeOnly = await setup({ free: true, env: { PAID_PROVIDERS_ENABLED: "false", AI_DEFAULT_SENSITIVITY: "standard" } });
    expect((await chat(freeOnly.app, freeOnly.user.auth)).text).toBe(ANSWER);
    expect([freeOnly.f.calls, freeOnly.a.calls + freeOnly.b.calls]).toEqual([1, 0]);
    // A sensitive request has nowhere to go: refused, not sent to the free provider.
    const form = multipart("notes.txt", "text/plain", Buffer.from("Private notes."));
    const doc = await freeOnly.app.inject({ method: "POST", url: "/v1/documents", headers: { ...freeOnly.user.auth, ...form.headers }, payload: form.payload });
    const refused = await chat(freeOnly.app, freeOnly.user.auth, { attachmentIds: [doc.json().id] });
    expect(refused.res.statusCode).toBe(503);
    expect([freeOnly.f.calls, freeOnly.a.calls + freeOnly.b.calls]).toEqual([1, 0]);
  });

  it("AI_ENABLED=false refuses every request without calling anything", async () => {
    const s = await setup({ free: true, env: { AI_ENABLED: "false" } });
    const r = await chat(s.app, s.user.auth);
    expect(r.res.statusCode).toBe(503);
    expect(r.res.json().error.message).toBe(NEUTRAL_UNAVAILABLE);
    expect(s.a.calls + s.b.calls + s.f.calls).toBe(0);
  });
});

describe("quotas and pauses", () => {
  it("a provider reporting its quota used up is paused, the next one serves, and it returns after the pause", async () => {
    const s = await setup({ free: true, env: { AI_DEFAULT_SENSITIVITY: "standard" } });
    s.f.steps = ["quota"];
    const first = await chat(s.app, s.user.auth);
    expect(first.text).toBe(ANSWER);
    const ledger = await rows(s.context.store, first.messageId);
    expect(ledger.map((x) => [x.provider, x.outcome, x.errorCode])).toEqual([
      ["freepool", "failure", "quota_exhausted"],
      [s.primary.id, "success", null],
    ]);
    expect(s.context.ai.quota.status("freepool")).toMatchObject({ state: "paused", pauseReason: "quota_exhausted" });

    const second = await chat(s.app, s.user.auth);
    expect(s.f.calls).toBe(1);
    expect((await rows(s.context.store, second.messageId))[0]!.route.rejected).toContainEqual({ provider: "freepool", reason: "paused" });

    s.clock.t += QUOTA_PAUSE_MS + 1_000;
    const third = await chat(s.app, s.user.auth);
    expect((await rows(s.context.store, third.messageId))[0]).toMatchObject({ provider: "freepool", outcome: "success" });
  });

  it("a rate limit with a long Retry-After pauses the provider instead of retrying it; a short one is retried", async () => {
    const s = await setup({ env: { PROVIDER_MAX_RETRIES: "2" } });
    s.primary.steps = ["429-long"];
    const r = await chat(s.app, s.user.auth);
    expect(r.text).toBe(ANSWER);
    expect([s.primary.calls, s.backup.calls]).toEqual([1, 1]);
    expect(s.context.ai.quota.status(s.primary.id)).toMatchObject({ state: "paused", pauseReason: "rate_limited" });
    const during = await chat(s.app, s.user.auth);
    expect([s.primary.calls, s.backup.calls]).toEqual([1, 2]);
    expect((await rows(s.context.store, during.messageId))[0]!.route.rejected).toContainEqual({ provider: s.primary.id, reason: "paused" });
    // The pause ends when the provider said it would.
    s.clock.t += 121_000;
    expect(s.context.ai.quota.status(s.primary.id).state).not.toBe("paused");
    const after = await chat(s.app, s.user.auth);
    expect((await rows(s.context.store, after.messageId))[0]!.route.order).toContain(s.primary.id);

    const short = await setup({ env: { PROVIDER_MAX_RETRIES: "1" } });
    short.primary.steps = ["429"];
    const retried = await chat(short.app, short.user.auth);
    expect(retried.text).toBe(ANSWER);
    expect((await rows(short.context.store, retried.messageId)).map((x) => [x.provider, x.retry, x.outcome])).toEqual([
      [short.primary.id, 0, "failure"],
      [short.primary.id, 1, "success"],
    ]);
    expect(short.context.ai.quota.status(short.primary.id).state).not.toBe("paused");
  });

  it("PROVIDER_QUOTAS: approaching a limit moves a provider behind others, a used-up one is skipped, and counts survive a restart", async () => {
    const store = await sharedStore();
    const env = { AI_DEFAULT_SENSITIVITY: "standard", PROVIDER_QUOTAS: JSON.stringify({ freepool: { windows: [{ type: "requests_per_day", limit: 3 }], softThreshold: 0.6 } }) };
    const s = await setup({ free: true, env, store });
    await chat(s.app, s.user.auth);
    await chat(s.app, s.user.auth);
    expect(s.f.calls).toBe(2);
    expect(s.context.ai.quota.status("freepool")).toMatchObject({ state: "soft", windows: [{ type: "requests_per_day", limit: 3, used: 2, remaining: 1 }] });

    // Approaching the limit: paid providers go first and the free one is the last resort.
    const third = await chat(s.app, s.user.auth);
    expect((await rows(store, third.messageId))[0]).toMatchObject({ provider: s.primary.id, route: { order: [s.primary.id, s.backup.id, "freepool"] } });
    s.primary.steps = ["503"];
    s.backup.steps = ["503"];
    const lastResort = await chat(s.app, s.user.auth);
    expect(lastResort.text).toBe(ANSWER);
    expect(s.context.ai.quota.status("freepool").state).toBe("exhausted");
    const after = await chat(s.app, s.user.auth);
    expect((await rows(store, after.messageId))[0]!.route.rejected).toContainEqual({ provider: "freepool", reason: "quota" });
    expect(s.f.calls).toBe(3);
    await s.app.close();
    apps.splice(apps.indexOf(s.app), 1);

    // A restart reads today's usage back from the ledger. With nothing else suitable, DASH AI is "busy".
    const restarted = await setup({ free: true, paid: false, env, store });
    expect(restarted.context.ai.quota.status("freepool")).toMatchObject({ state: "exhausted", windows: [{ used: 3 }] });
    const refused = await chat(restarted.app, restarted.user.auth);
    expect(refused.res.statusCode).toBe(429);
    expect(refused.res.json().error.message).toBe("DASH AI is very busy right now. Please try again in a moment.");
    expect(restarted.f.calls).toBe(0);
  });
});

describe("spend circuit breakers", () => {
  it("the system daily limit stops paid inference until the next UTC day; free providers carry on", async () => {
    const s = await setup({ env: { MAX_DAILY_AI_SPEND: "0.06" } });
    expect((await chat(s.app, s.user.auth)).text).toBe(ANSWER);
    expect((await chat(s.app, s.user.auth)).text).toBe(ANSWER);
    // $0.05 spent: $0.01 left cannot hold another request's $0.025 worst case.
    const blocked = await chat(s.app, s.user.auth);
    expect(blocked.res.statusCode).toBe(503);
    expect(blocked.res.json().error.message).toBe(NEUTRAL_UNAVAILABLE);
    expect(s.a.calls + s.b.calls).toBe(2);
    expect(await paidSpend(s.context.store)).toBeLessThanOrEqual(0.06);
    expect(s.context.metrics.render()).toMatch(/dash_ai_spend_blocked_total\{scope="system_daily"\} 1/);
    s.clock.t = Date.parse("2026-10-13T00:00:01Z");
    expect((await chat(s.app, s.user.auth)).text).toBe(ANSWER);

    const withFree = await setup({ free: true, env: { MAX_DAILY_AI_SPEND: "0.01", AI_DEFAULT_SENSITIVITY: "standard", FREE_POOL_ENABLED: "true" } });
    await withFree.context.store.recordInferenceAttempt(pastAttempt({}));
    expect((await chat(withFree.app, withFree.user.auth)).text).toBe(ANSWER);
    expect([withFree.f.calls, withFree.a.calls + withFree.b.calls]).toEqual([1, 0]);
  });

  it("the system monthly limit counts the provider's own charge before the estimate, and resets with the month", async () => {
    const s = await setup({ env: { MAX_DAILY_AI_SPEND: "100", MAX_MONTHLY_AI_SPEND: "4" } });
    await s.context.store.recordInferenceAttempt(pastAttempt({ createdAt: "2026-10-02T10:00:00Z", estimatedCostUsd: 0.01, providerCostUsd: 5 }));
    const blocked = await chat(s.app, s.user.auth);
    expect(blocked.res.statusCode).toBe(503);
    expect(s.a.calls + s.b.calls).toBe(0);
    s.clock.t = Date.parse("2026-11-01T00:00:01Z");
    expect((await chat(s.app, s.user.auth)).text).toBe(ANSWER);
  });

  it("a provider-reported charge on a new answer trips the daily limit at once", async () => {
    const s = await setup({ env: { MAX_DAILY_AI_SPEND: "0.4" } });
    s.primary.otherwise = "answer-provider-cost";
    const r = await chat(s.app, s.user.auth);
    expect((await rows(s.context.store, r.messageId))[0]).toMatchObject({ providerCostUsd: 0.5, estimatedCostUsd: PAID_ANSWER_USD });
    expect((await chat(s.app, s.user.auth)).res.statusCode).toBe(503);
  });

  it("a person's daily limit stops their requests only, with a message they can act on", async () => {
    const s = await setup({ env: { MAX_USER_DAILY_AI_SPEND: "0.03" } });
    expect((await chat(s.app, s.user.auth)).text).toBe(ANSWER);
    const limited = await chat(s.app, s.user.auth);
    expect(limited.res.statusCode).toBe(429);
    expect(limited.res.json().error).toMatchObject({ message: "You've reached today's DASH AI usage limit. Please try again tomorrow.", retryable: false });
    const other = await register(s.app);
    expect((await chat(s.app, other.auth)).text).toBe(ANSWER);
    s.clock.t = Date.parse("2026-10-13T00:00:01Z");
    expect((await chat(s.app, s.user.auth)).text).toBe(ANSWER);
  });

  it("a plan's daily limit covers every account on the plan", async () => {
    const s = await setup({ env: { AI_PLAN_DAILY_SPEND: JSON.stringify({ standard: 0.03 }) } });
    expect((await chat(s.app, s.user.auth)).text).toBe(ANSWER);
    const other = await register(s.app);
    expect((await chat(s.app, other.auth)).res.statusCode).toBe(429);
  });

  it("the per-request ceiling refuses a request whose worst case is too expensive, before any provider is called", async () => {
    const tight = await setup({ env: { MAX_REQUEST_AI_COST: "0.01" } });
    const refused = await chat(tight.app, tight.user.auth);
    expect(refused.res.statusCode).toBe(413);
    expect(refused.res.json().error.message).toBe("This request is too large for DASH AI right now. Try a shorter message or fewer documents.");
    expect(tight.a.calls + tight.b.calls).toBe(0);

    // 500 output tokens at $50/M is $0.025: a $1 ceiling allows it.
    const roomy = await setup({ env: { MAX_REQUEST_AI_COST: "1" } });
    expect((await chat(roomy.app, roomy.user.auth)).text).toBe(ANSWER);

    // A paid model nobody priced cannot be bounded, so a ceiling keeps it out.
    const unpriced = await setup({ env: { MAX_REQUEST_AI_COST: "1", MODEL_PRICES: "{}" } });
    expect((await chat(unpriced.app, unpriced.user.auth)).res.statusCode).toBe(413);
    expect(unpriced.a.calls + unpriced.b.calls).toBe(0);
  });
});

describe("spend limits hold under adversarial conditions", () => {
  it("an admitted request cannot take spend past a limit: its worst case must fit in what is left", async () => {
    // Checking only the spend already recorded would serve a second $0.025 answer at $0.025 of a
    // $0.03 limit and end the day at $0.05.
    const s = await setup({ env: { MAX_DAILY_AI_SPEND: "0.03" } });
    const answered = [];
    for (let i = 0; i < 4; i++) answered.push((await chat(s.app, s.user.auth)).text === ANSWER);
    expect(answered).toEqual([true, false, false, false]);
    expect(await paidSpend(s.context.store)).toBeCloseTo(PAID_ANSWER_USD, 10);
    expect(s.context.metrics.render()).toMatch(/dash_ai_spend_blocked_total\{scope="system_daily"\} 3/);
  });

  it("an answer whose served model id has no price is charged at its configured model's price", async () => {
    // Providers often report a dated snapshot of the alias the operator priced. Priced at nothing,
    // such answers would never trip a limit.
    const s = await setup({ env: { MAX_DAILY_AI_SPEND: "0.06" } });
    s.a.served = "snapshot-2026-01-01";
    s.b.served = "snapshot-2026-01-01";
    const first = await chat(s.app, s.user.auth);
    expect((await rows(s.context.store, first.messageId))[0]).toMatchObject({
      model: "snapshot-2026-01-01",
      configuredModel: s.primary.model,
      estimatedCostUsd: PAID_ANSWER_USD,
    });
    for (let i = 0; i < 3; i++) await chat(s.app, s.user.auth);
    expect(s.a.calls + s.b.calls).toBe(2);
    expect(await paidSpend(s.context.store)).toBeLessThanOrEqual(0.06);
  });

  it("under any spend limit a paid model with no price is never used (fails closed at runtime, not only at start-up)", async () => {
    const limited = await setup({ env: { MAX_DAILY_AI_SPEND: "10", MODEL_PRICES: "{}" } });
    expect((await chat(limited.app, limited.user.auth)).res.statusCode).toBe(503);
    expect(limited.a.calls + limited.b.calls).toBe(0);
    // Without any limit (development), an unpriced model still serves; production refuses to start that way.
    const unlimited = await setup({ env: { MODEL_PRICES: "{}" } });
    expect((await chat(unlimited.app, unlimited.user.auth)).text).toBe(ANSWER);
  });

  it("the worst case counts everything sent, the system prompt included, not only the person's words", async () => {
    // Input-only prices: the system prompt (well over 300 tokens) alone exceeds the $0.10 ceiling at
    // $1,000/M, while the short message alone (about 11 tokens) would cost about $0.01.
    const inputOnly = JSON.stringify({ "openai:paid-a-model": { inputPerMillion: 1000, outputPerMillion: 0 }, "anthropic:paid-b-model": { inputPerMillion: 1000, outputPerMillion: 0 } });
    const s = await setup({ env: { MAX_REQUEST_AI_COST: "0.1", MODEL_PRICES: inputOnly } });
    expect((await chat(s.app, s.user.auth)).res.statusCode).toBe(413);
    expect(s.a.calls + s.b.calls).toBe(0);
  });

  it("a request that offers tools counts every provider request its tool rounds may make", async () => {
    const s = await setup({ env: { MAX_REQUEST_AI_COST: "0.05" } });
    expect((await chat(s.app, s.user.auth)).text).toBe(ANSWER);
    // With tools on, an answer may take TOOL_MAX_ROUNDS (4) tool rounds and a final answer: 5 × $0.025.
    expect((await s.app.inject({ method: "PUT", url: "/v1/plugins/dash-demo", headers: s.user.auth, payload: { enabled: true } })).statusCode).toBe(200);
    const refused = await chat(s.app, s.user.auth);
    expect(refused.res.statusCode).toBe(413);
    expect(s.a.calls + s.b.calls).toBe(1);
  });
});

describe("the worst case of a tool-using answer", () => {
  const enableTools = async (s: Awaited<ReturnType<typeof setup>>) =>
    expect((await s.app.inject({ method: "PUT", url: "/v1/plugins/dash-demo", headers: s.user.auth, payload: { enabled: true } })).statusCode).toBe(200);
  const LOOP = { toolRounds: 4, resultCharsPerRound: 8 * (20_000 + 200) };

  it("each round may send everything before it: input grows by the round's output and tool results", () => {
    // 500 output tokens sent back (at up to 4 characters each) plus eight 20,000-character results.
    const growth = roundGrowthTokens(500, LOOP);
    expect(growth).toBe(Math.ceil((500 * 4 + 8 * 20_200) / 3));
    expect(roundInputBudgets(1_000, { rounds: 5, growthTokens: growth, contextTokens: 1_000_000 })).toEqual([0, 1, 2, 3, 4].map((k) => 1_000 + k * growth));
  });

  it("no round is budgeted past the provider's context window, and the first request is never cut", () => {
    expect(roundInputBudgets(1_000, { rounds: 5, growthTokens: 60_000, contextTokens: 128_000 })).toEqual([1_000, 61_000, 121_000, 128_000, 128_000]);
    // A first request larger than the window was admitted on its own size (the router checks fit).
    expect(roundInputBudgets(200_000, { rounds: 3, growthTokens: 10, contextTokens: 128_000 })).toEqual([200_000, 200_000, 200_000]);
    // Every request is billed its full output allowance.
    expect(worstCaseUsd({ inputPerMillion: 1, outputPerMillion: 10 }, [1_000_000, 2_000_000], 100_000)).toBeCloseTo(3 + 2, 10);
  });

  it("admission prices tool-result growth: a ceiling that fits five copies of the first request still refuses", async () => {
    // Input-only prices at $1/M. The first request (system prompt, tool schemas, message) is a few
    // thousand tokens, so five unchanged copies cost about $0.01; with tool results growing every
    // round the worst case is several hundred thousand tokens.
    const inputOnly = JSON.stringify({ "openai:paid-a-model": { inputPerMillion: 1, outputPerMillion: 0 }, "anthropic:paid-b-model": { inputPerMillion: 1, outputPerMillion: 0 } });
    const s = await setup({ env: { MAX_REQUEST_AI_COST: "0.1", MODEL_PRICES: inputOnly } });
    expect((await chat(s.app, s.user.auth)).text).toBe(ANSWER);
    await enableTools(s);
    const refused = await chat(s.app, s.user.auth);
    expect(refused.res.statusCode).toBe(413);
    expect(s.a.calls + s.b.calls).toBe(1);

    // The operator's context window bounds it: the same answer fits a ceiling sized for it.
    const budgets = s.context.ai.inputBudgets("openai", 3_000, LOOP);
    expect(budgets).toHaveLength(5);
    expect(Math.max(...budgets)).toBe(128_000);
  });

  it("the final answer after the last tool round is counted (TOOL_MAX_ROUNDS + 1 requests)", async () => {
    // Output-only prices: one round tool, then a final answer, each up to 500 tokens at $50/M.
    const tight = await setup({ env: { MAX_REQUEST_AI_COST: "0.049", TOOL_MAX_ROUNDS: "1" } });
    await enableTools(tight);
    expect((await chat(tight.app, tight.user.auth)).res.statusCode).toBe(413);
    const roomy = await setup({ env: { MAX_REQUEST_AI_COST: "0.051", TOOL_MAX_ROUNDS: "1" } });
    await enableTools(roomy);
    expect((await chat(roomy.app, roomy.user.auth)).text).toBe(ANSWER);
  });

  it("a round that grows past its admitted budget is answered without tools, and stops if even that would not fit", async () => {
    const s = await setup({ env: { MAX_REQUEST_AI_COST: "1" } });
    await enableTools(s);
    // Round 0 writes far more text than 500 output tokens can hold (about 70,000 estimated tokens
    // sent back), so round 1 is past its budget but inside the final answer's (the context window).
    s.primary.steps = ["tool", "tool"];
    s.primary.toolRoundText = "x".repeat(210_000);
    const early = await chat(s.app, s.user.auth);
    expect(early.failed).toBe(false);
    expect(s.primary.requests.map((r) => r.toolChoice)).toEqual(["auto", "none"]);
    const second = s.primary.requests[1]!;
    const budgets = s.context.ai.inputBudgets(s.primary.id, 0, LOOP);
    expect(estimateTokensForLedger(requestChars(second))).toBeLessThanOrEqual(budgets[budgets.length - 1]!);

    // Past even the final answer's budget: the answer ends there, no further request is sent.
    const t = await setup({ env: { MAX_REQUEST_AI_COST: "1" } });
    await enableTools(t);
    t.primary.steps = ["tool"];
    t.primary.toolRoundText = "x".repeat(600_000);
    const stopped = await chat(t.app, t.user.auth);
    expect(t.primary.calls).toBe(1);
    expect(byEvent(stopped.events, "message.end")[0]?.data.finishReason).toBe("length");

    // Without any limit or ceiling nothing is reserved, so nothing is enforced.
    const u = await setup();
    await enableTools(u);
    u.primary.steps = ["tool"];
    u.primary.toolRoundText = "x".repeat(210_000);
    await chat(u.app, u.user.auth);
    expect(u.primary.requests.map((r) => r.toolChoice)).toEqual(["auto", "auto"]);
  });

  it("reserves a model's real output limit where the adapter knows it, never more than MAX_OUTPUT_TOKENS", async () => {
    const bedrock = new BedrockAdapter({ kind: "api_key", apiKey: "test-key" }, "eu-west-1", { lite: "eu.amazon.nova-lite-v1:0", nova2Lite: "eu.amazon.nova-2-lite-v1:0" }, { client: {} as never });
    const made = await makeApp({ config: testConfig({ MAX_OUTPUT_TOKENS: "16000" }), providers: new ProviderRegistry({ bedrock }) });
    apps.push(made.app);
    const ai = made.context.ai;
    // Nova Lite cannot write more than 5,000 tokens; Nova 2 Lite can write 64,000, so MAX_OUTPUT_TOKENS binds.
    expect(ai.outputTokenCap("bedrock", "eu.amazon.nova-lite-v1:0")).toBe(5_000);
    expect(ai.outputTokenCap("bedrock", "eu.amazon.nova-2-lite-v1:0")).toBe(16_000);
    // Adapters without a known limit reserve MAX_OUTPUT_TOKENS.
    expect(ai.outputTokenCap("openai", "any-model")).toBe(16_000);

    // The worst case is the dearer of the two tiers, each with its own cap (one request, 3,000 input tokens).
    const { worstCaseCostUsd } = ai.costFields({ paidAllowed: true, blockedBy: null, headroom: null, totals: { systemDailyUsd: 0, systemMonthlyUsd: 0, planDailyUsd: null, userDailyUsd: null }, usage: [] }, 9_000);
    const lite = (3_000 * 0.06 + 5_000 * 0.24) / 1e6;
    const nova2 = (3_000 * 0.33 + 16_000 * 2.75) / 1e6;
    expect(worstCaseCostUsd!("bedrock")).toBeCloseTo(Math.max(lite, nova2), 12);
  });
});

describe("Automates", () => {
  const brief = { name: "Morning brief", prompt: "Write my morning brief.", mode: "business", schedule: { kind: "daily", time: "08:00" }, timeZone: "Africa/Lagos" };

  async function runOnce(s: Awaited<ReturnType<typeof setup>>, automationId: string) {
    const run = await s.app.inject({ method: "POST", url: `/v1/automations/${automationId}/run`, headers: s.user.auth });
    expect(run.statusCode).toBe(202);
    await s.context.automations.idle();
    const id = AutomationRunResponse.parse(run.json()).run.id;
    const detail = AutomationDetailResponse.parse((await s.app.inject({ method: "GET", url: `/v1/automations/${automationId}`, headers: s.user.auth })).json());
    return { id, run: detail.runs.find((r) => r.id === id)! };
  }

  it("each run's attempts go to the ledger, and a person's spend limit stops a run in DASH AI's words", async () => {
    const s = await setup({ env: { MAX_USER_DAILY_AI_SPEND: "0.03" } });
    const created = await s.app.inject({ method: "POST", url: "/v1/automations", headers: s.user.auth, payload: brief });
    const automation = Automation.parse(created.json());
    const first = await runOnce(s, automation.id);
    expect(first.run.status).toBe("ready");
    expect(await rows(s.context.store, first.id)).toMatchObject([{ task: "automation", mode: "business", userId: s.user.user.id, pricing: "paid", outcome: "success", tokenSource: "provider" }]);

    const second = await runOnce(s, automation.id);
    expect(second.run).toMatchObject({ status: "failed", error: "A DASH AI usage limit stopped this run. It can run again later." });
    expect(await rows(s.context.store, second.id)).toEqual([]);
    expect(s.a.calls + s.b.calls).toBe(1);
  });
});

describe("nothing about providers or costs reaches consumers", () => {
  it("after free-pool failover, consumer responses stay neutral; the operator view shows the provider platform", async () => {
    const s = await setup({ free: true, env: { AI_DEFAULT_SENSITIVITY: "standard" } });
    s.f.steps = ["quota"];
    const r = await chat(s.app, s.user.auth);
    expect(r.text).toBe(ANSWER);
    const consumer = [r.res.body];
    for (const url of ["/v1/conversations", "/v1/usage", "/v1/me/export", "/v1/assistant", "/v1/sync/conversations"]) {
      const res = await s.app.inject({ method: "GET", url, headers: s.user.auth });
      expect(res.statusCode, url).toBe(200);
      consumer.push(res.body);
    }
    const router = (authorization?: string) => s.app.inject({ method: "GET", url: "/v1/router", ...(authorization ? { headers: { authorization } } : {}) });
    const denied = await router(s.user.auth.authorization);
    expect(denied.statusCode).toBe(404);
    consumer.push(denied.body);
    for (const body of consumer) {
      expect(body).not.toMatch(LEAK);
      expect(containsProviderName(body)).toBe(false);
    }

    const operator = await router(`Bearer ${OPERATOR}`);
    expect(operator.statusCode).toBe(200);
    const platform = operator.json().platform;
    expect(platform.controls).toMatchObject({ aiEnabled: true, freePoolEnabled: true, paidProvidersEnabled: true, bedrockEnabled: false, defaultSensitivity: "standard" });
    expect(platform.spend.today.systemUsd).toBeCloseTo(PAID_ANSWER_USD, 10);
    expect(platform.providers.find((p: { provider: string }) => p.provider === "freepool")).toMatchObject({
      configured: true,
      privacy: "non_sensitive_only",
      sensitiveAllowed: false,
      pricing: "free",
      quota: { state: "paused", pauseReason: "quota_exhausted" },
      pricesUsdPerMillion: { "free-model": { inputPerMillion: 0, outputPerMillion: 0 } },
    });
    expect(platform.providers.find((p: { provider: string }) => p.provider === "bedrock")).toMatchObject({ configured: false, enabled: false });
  });
});
