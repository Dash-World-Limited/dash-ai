import { Automation, AutomationDetailResponse, AutomationRunResponse, type ProviderId, type StreamEvent } from "@dash-ai/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { containsProviderName } from "../src/chat/publicSurface.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { toProviderError, type ProviderAdapter, type ProviderChunk, type ProviderRequest } from "../src/providers/types.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import type { ExtendSpendInput, ExtendSpendResult, InferenceAttemptRow, ReserveSpendInput, ReserveSpendResult, SpendReservationRecord, Store } from "../src/store/store.js";
import { builtinPlugin } from "../src/tools/builtin.js";
import { PluginRegistry } from "../src/tools/registry.js";
import { chatBody, register, sse, testConfig, testId, USING_POSTGRES } from "./helpers.js";
import { makeMockGithubPlugin } from "./mockPlugin.js";
import { createTestPgStore } from "./pgTestStore.js";

// Retry and fallback spend accounting (ADR 0016) through the real chat and Automates paths: every paid
// provider attempt beyond the admitted path (a retry, a fallback, a round whose room a retry used) is
// covered by the request's hold BEFORE it is sent, or it is not sent at all. Providers are in-process
// fakes; nothing leaves the test. Output-only prices keep the arithmetic exact: one request's worst
// case is MAX_OUTPUT_TOKENS (500) × the provider's output price, whatever the prompt's length.

type Step = "answer" | "cheap" | "503" | "429" | "401" | "partial" | "stall" | "wait" | "tool";

class Engine implements ProviderAdapter {
  readonly demo = false;
  readonly requests: ProviderRequest[] = [];
  /** The request's hold as the store had it when each request reached this provider. */
  readonly heldAtCall: Array<number | null> = [];
  steps: Step[] = [];
  /** A script several engines take turns from (whichever is called next takes the next step). */
  shared: Step[] | null = null;
  otherwise: Step = "answer";
  hold: () => Promise<number | null> = async () => null;
  private waiting: Array<() => void> = [];
  constructor(
    readonly id: ProviderId,
    readonly model: string,
    readonly displayName: string,
  ) {}

  get calls(): number {
    return this.requests.length;
  }

  release(): void {
    for (const w of this.waiting.splice(0)) w();
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderChunk> {
    this.requests.push(request);
    const held = await this.hold();
    this.heldAtCall.push(held === null ? null : Math.round(held * 1e10) / 1e10);
    const step = this.shared?.shift() ?? this.steps.shift() ?? this.otherwise;
    const until = (resolveOn: "release" | "abort") =>
      new Promise<void>((resolve, reject) => {
        if (resolveOn === "release") this.waiting.push(resolve);
        request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    switch (step) {
      case "503":
        throw toProviderError(this.displayName, { status: 503 });
      case "429":
        throw toProviderError(this.displayName, { status: 429 });
      case "401":
        throw toProviderError(this.displayName, { status: 401 });
      case "partial":
        yield { type: "text", text: "Here is the start" };
        throw toProviderError(this.displayName, { status: 503 });
      case "stall":
        await until("abort");
        return;
      case "tool":
        yield { type: "tool_calls", calls: [{ id: `call_${this.requests.length}`, name: "mock-github__list_issues", argumentsJson: JSON.stringify({ repo: "dash/app" }) }] };
        yield { type: "finish", finishReason: "stop", usage: { inputTokens: 1_000, outputTokens: 100 }, servedModel: this.model };
        return;
      case "wait":
        await until("release");
        break;
      default:
        break;
    }
    yield { type: "text", text: ANSWER };
    yield { type: "finish", finishReason: "stop", usage: { inputTokens: 1_000, outputTokens: step === "cheap" ? 100 : 500 }, servedModel: this.model };
  }
}

const ANSWER = "Here is your plan.";
/** Output prices per million tokens: A $50 (worst case $0.025), B $50 unless a test makes it dearer or cheaper. */
const price = (a: number, b: number) => ({ "openai:paid-a-model": { inputPerMillion: 0, outputPerMillion: a }, "anthropic:paid-b-model": { inputPerMillion: 0, outputPerMillion: b } });
const WORST = 0.025;
const CHEAP = 0.005;
const FREEPOOL = {
  id: "freepool", displayName: "FREEPOOL-NAME", baseUrl: "https://free.example.test/v1", apiKeyEnv: "FREEPOOL_API_KEY", model: "free-model",
  contextTokens: 32_000, pricing: "free", privacy: "non_sensitive_only", inputPerMillion: 0, outputPerMillion: 0, quality: 0.8,
};

/** A store that records extensions and can be made to fail them. */
class Spying extends MemoryStore {
  reserves: ReserveSpendInput[] = [];
  extensions: Array<{ input: ExtendSpendInput; result: ExtendSpendResult | Error }> = [];
  failExtend = false;
  override async reserveSpend(input: ReserveSpendInput): Promise<ReserveSpendResult> {
    this.reserves.push(input);
    return super.reserveSpend(input);
  }
  override async extendSpendReservation(input: ExtendSpendInput): Promise<ExtendSpendResult> {
    if (this.failExtend) {
      const err = new Error("database unavailable");
      this.extensions.push({ input, result: err });
      throw err;
    }
    const result = await super.extendSpendReservation(input);
    this.extensions.push({ input, result });
    return result;
  }
}

const apps: FastifyInstance[] = [];
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
  while (disposers.length) await disposers.pop()!();
});

interface Options {
  env?: Record<string, string>;
  prices?: { a: number; b: number };
  store?: Store;
  free?: boolean;
  tools?: boolean;
}

async function setup(o: Options = {}) {
  const a = new Engine("openai", "paid-a-model", "PAIDA");
  const b = new Engine("anthropic", "paid-b-model", "PAIDB");
  const f = new Engine("freepool", "free-model", "FREEPOOL-NAME");
  let store = o.store;
  if (!store) {
    if (USING_POSTGRES) {
      const pg = await createTestPgStore();
      disposers.push(() => pg.dispose());
      store = pg.store;
    } else store = new Spying();
  }
  const config = testConfig({
    PROVIDER_DETAILS: "hidden",
    PROVIDER_RETRY_BASE_MS: "0",
    PROVIDER_MAX_RETRIES: "0",
    MAX_OUTPUT_TOKENS: "500",
    MODEL_PRICES: JSON.stringify(price(o.prices?.a ?? 50, o.prices?.b ?? 50)),
    COMPATIBLE_PROVIDERS: JSON.stringify([FREEPOOL]),
    ...(o.free ? { FREE_POOL_ENABLED: "true", AI_DEFAULT_SENSITIVITY: "standard", PROVIDER_QUOTAS: JSON.stringify({ freepool: { windows: [{ type: "requests_per_day", limit: 100 }], softThreshold: 0.01 } }) } : {}),
    ...o.env,
  });
  const mock = makeMockGithubPlugin();
  const providers = new ProviderRegistry({ openai: a, anthropic: b, ...(o.free ? { freepool: f } : {}) }, [], [{ id: "freepool", displayName: "FREEPOOL-NAME" }]);
  const { app, context } = await buildApp({ config, providers, store, plugins: new PluginRegistry().register(builtinPlugin).register(mock.plugin) });
  await app.ready();
  apps.push(app);
  const user = await register(app);
  if (o.tools) expect((await app.inject({ method: "PUT", url: "/v1/plugins/mock-github", headers: user.auth, payload: { enabled: true } })).statusCode).toBe(200);
  if (o.free) context.ai.quota.record("freepool", { requests: 1, tokens: 0, costUsd: 0 }); // "soft": the free provider becomes the last resort
  // The paid providers in the order DASH AI tries them for this chat.
  const route = context.router.route({ task: "chat", mode: "general", sensitivity: context.ai.classify({ documents: 0, toolsOffered: Boolean(o.tools) }), ...(o.tools ? { requires: ["tool_use"] } : {}) });
  const order = route.ok ? route.providers : [];
  const paid = order.filter((p) => p !== "freepool").map((p) => (p === "openai" ? a : b));
  const [primary, backup] = paid as [Engine, Engine];
  // Each engine notes the hold at the moment a request reaches it.
  const holdNow = async (): Promise<number | null> => {
    const r = await currentHold(store!);
    return r?.reservedUsd ?? null;
  };
  for (const e of [a, b, f]) e.hold = holdNow;
  return { app, context, store: store!, a, b, f, primary, backup, order, user, calls: () => a.calls + b.calls + f.calls };
}

/** The most recent hold (each test makes one request at a time). */
let lastInference = "";
async function currentHold(store: Store): Promise<SpendReservationRecord | undefined> {
  return lastInference ? holdFor(store, lastInference) : undefined;
}
async function holdFor(store: Store, inferenceId: string): Promise<SpendReservationRecord | undefined> {
  const ids = reservationIds.get(store) ?? new Map<string, string>();
  const id = ids.get(inferenceId);
  return id ? store.getSpendReservation(id) : undefined;
}
const reservationIds = new WeakMap<Store, Map<string, string>>();

const byEvent = <N extends StreamEvent["event"]>(events: StreamEvent[], name: N) =>
  events.filter((e): e is Extract<StreamEvent, { event: N }> => e.event === name);

/** Wraps the store so the test can find each request's hold by its inference id. */
function track(store: Store): void {
  const ids = new Map<string, string>();
  reservationIds.set(store, ids);
  const reserve = store.reserveSpend.bind(store);
  store.reserveSpend = async (input) => {
    ids.set(input.inferenceId, input.id);
    lastInference = input.inferenceId;
    return reserve(input);
  };
}

async function chat(s: Awaited<ReturnType<typeof setup>>, content = "plan my week") {
  const res = await s.app.inject({ method: "POST", url: "/v1/chat/stream", headers: s.user.auth, payload: chatBody({ modelChoice: "smart", mode: "general", message: { id: testId("msg"), content, attachmentIds: [] } }) });
  const events = res.statusCode === 200 ? sse(res.body) : [];
  const messageId = byEvent(events, "stream.start")[0]?.data.targets[0]?.messageId ?? "";
  return {
    res,
    events,
    messageId,
    text: byEvent(events, "message.delta").map((e) => e.data.text).join(""),
    error: byEvent(events, "message.error")[0]?.data.error,
    end: byEvent(events, "message.end")[0]?.data,
  };
}

async function ledger(store: Store, inferenceId: string): Promise<InferenceAttemptRow[]> {
  return (await store.listInferenceAttempts(inferenceId)).sort((x, y) => x.fallbackIndex - y.fallbackIndex || x.round - y.round || x.retry - y.retry);
}
const ledgerUsd = (rows: InferenceAttemptRow[]) => Math.round(rows.filter((r) => r.pricing === "paid").reduce((n, r) => n + (r.providerCostUsd ?? r.estimatedCostUsd ?? 0), 0) * 1e10) / 1e10;

/** The request's hold after it ended: settled to exactly its paid ledger rows, never below them. */
async function settledHold(s: Awaited<ReturnType<typeof setup>>, inferenceId: string) {
  const hold = await holdFor(s.store, inferenceId);
  if (!hold) throw new Error("no hold for this request");
  const rows = await ledger(s.store, inferenceId);
  expect(hold.status === "settled" || hold.status === "released").toBe(true);
  expect(hold.actualUsd).toBeCloseTo(ledgerUsd(rows), 10);
  expect(hold.actualUsd!).toBeLessThanOrEqual(hold.reservedUsd + 1e-9); // no overage
  return { hold, rows };
}

const metric = (s: Awaited<ReturnType<typeof setup>>, pattern: RegExp) => pattern.test(s.context.metrics.render());

async function tracked(o: Options = {}) {
  const s = await setup(o);
  track(s.store);
  return s;
}

describe("retries: covered before they are sent, or not sent", () => {
  it("first attempt fails before output, the retry is covered by extending the hold first, and succeeds (no overage)", async () => {
    const s = await tracked({ env: { MAX_DAILY_AI_SPEND: "1", PROVIDER_MAX_RETRIES: "1" } });
    s.primary.steps = ["503", "cheap"];
    const r = await chat(s);
    expect(r.text).toBe(ANSWER);
    expect([s.primary.calls, s.backup.calls]).toEqual([2, 0]);
    // The 503 may have been billed: it keeps its worst case, so the retry needed room beyond the admitted path,
    // and that room was in the hold when the retry reached the provider.
    expect(s.primary.heldAtCall).toEqual([WORST, 2 * WORST]);
    const { hold, rows } = await settledHold(s, r.messageId);
    expect(rows.map((x) => [x.retry, x.outcome])).toEqual([[0, "failure"], [1, "success"]]);
    expect(hold).toMatchObject({ reservedUsd: 2 * WORST, actualUsd: CHEAP });
    expect(metric(s, /dash_ai_spend_extensions_total\{kind="retry",outcome="extended"\} 1/)).toBe(true);
    expect(metric(s, /dash_ai_spend_extension_usd_total\{kind="retry"\} 0\.025/)).toBe(true);
  });

  it("CRITICAL: a retry the limit cannot cover is NOT sent; nor is a paid fallback; the person gets a neutral error", async () => {
    const s = await tracked({ env: { MAX_DAILY_AI_SPEND: "0.04", PROVIDER_MAX_RETRIES: "2" } });
    s.primary.otherwise = "503";
    s.backup.otherwise = "answer";
    const r = await chat(s);
    expect([s.primary.calls, s.backup.calls]).toEqual([1, 0]);
    expect(r.error).toMatchObject({ code: "provider_error", retryable: true, message: "DASH AI couldn't complete that response. Please try again." });
    expect(containsProviderName(JSON.stringify(r.events))).toBe(false);
    expect(JSON.stringify(r.events)).not.toMatch(/spend|reserv/i);
    const { hold, rows } = await settledHold(s, r.messageId);
    expect(rows).toHaveLength(1);
    expect(hold.reservedUsd).toBe(WORST); // refused extensions changed nothing
    expect(metric(s, /dash_ai_spend_prevented_attempts_total\{kind="retry",reason="denied"\} 1/)).toBe(true);
    expect(metric(s, /dash_ai_spend_prevented_attempts_total\{kind="fallback",reason="denied"\} 1/)).toBe(true);
  });

  it("a provider that refused with 429 before working is not counted as billed: its retry fits the admitted hold", async () => {
    const s = await tracked({ env: { MAX_DAILY_AI_SPEND: "0.03", PROVIDER_MAX_RETRIES: "1" } });
    s.primary.steps = ["429", "answer"];
    const r = await chat(s);
    expect(r.text).toBe(ANSWER);
    expect(s.primary.calls).toBe(2);
    const { hold } = await settledHold(s, r.messageId);
    expect(hold.reservedUsd).toBe(WORST);
    expect(metric(s, /dash_ai_spend_extension_attempts_total\{/)).toBe(false);
  });

  it("CASE J: the hold cannot be extended (database error): the paid retry and the paid fallback are not sent", async () => {
    const store = new Spying();
    const s = await tracked({ store, env: { MAX_DAILY_AI_SPEND: "1", PROVIDER_MAX_RETRIES: "2" } });
    store.failExtend = true;
    s.primary.otherwise = "503";
    const r = await chat(s);
    expect(s.calls()).toBe(1);
    expect(r.error).toMatchObject({ code: "provider_error" });
    expect(store.extensions.length).toBeGreaterThanOrEqual(1);
    expect(metric(s, /dash_ai_spend_extensions_total\{kind="retry",outcome="error"\} 1/)).toBe(true);
    expect(metric(s, /dash_ai_spend_reservation_failures_total\{stage="extend"\} 2/)).toBe(true);
    await settledHold(s, r.messageId);
  });

  it("a cancel after the provider started ends the answer: no retry, no fallback; the attempt settles from the ledger", async () => {
    const s = await tracked({ env: { MAX_DAILY_AI_SPEND: "1", PROVIDER_MAX_RETRIES: "2" } });
    s.primary.otherwise = "wait";
    const pending = chat(s);
    const deadline = Date.now() + 5_000;
    while (s.calls() === 0 && Date.now() < deadline) await new Promise((x) => setTimeout(x, 5));
    s.context.streams.cancelAllForUser(s.user.user.id);
    const r = await pending;
    expect(r.end?.finishReason).toBe("cancelled");
    expect(s.calls()).toBe(1);
    await settledHold(s, r.messageId);
  });
});

describe("fallbacks: priced at the fallback provider and covered before it is sent", () => {
  it("primary fails, the fallback is covered by an extension first and answers", async () => {
    const s = await tracked({ env: { MAX_DAILY_AI_SPEND: "1" } });
    s.primary.steps = ["503"];
    const r = await chat(s);
    expect(r.text).toBe(ANSWER);
    expect([s.primary.calls, s.backup.calls]).toEqual([1, 1]);
    expect(s.backup.heldAtCall).toEqual([2 * WORST]);
    const { hold, rows } = await settledHold(s, r.messageId);
    expect(rows.map((x) => [x.provider, x.fallbackIndex, x.outcome])).toEqual([[s.primary.id, 0, "failure"], [s.backup.id, 1, "success"]]);
    expect(hold).toMatchObject({ reservedUsd: 2 * WORST, actualUsd: WORST });
    expect(metric(s, /dash_ai_spend_extensions_total\{kind="fallback",outcome="extended"\} 1/)).toBe(true);
  });

  it("CASE G: a fallback dearer than the primary has its own (higher) worst case reserved before it is sent", async () => {
    // Whichever provider DASH tries first, the other one costs four times as much.
    const probe = await setup({ env: { MAX_DAILY_AI_SPEND: "1" } });
    const dearB = probe.backup.id === "anthropic";
    const s = await tracked({ env: { MAX_DAILY_AI_SPEND: "1" }, prices: dearB ? { a: 50, b: 200 } : { a: 200, b: 50 } });
    expect(s.backup.id).toBe(probe.backup.id);
    s.primary.steps = ["503"];
    const r = await chat(s);
    expect(r.text).toBe(ANSWER);
    // Admitted on the dearest provider in the route ($0.10); the failed primary keeps $0.025: +$0.025 first.
    expect(s.primary.heldAtCall).toEqual([0.1]);
    expect(s.backup.heldAtCall).toEqual([0.125]);
    const { hold } = await settledHold(s, r.messageId);
    expect(hold).toMatchObject({ reservedUsd: 0.125, actualUsd: 0.1 });
    // Priced at the fallback's own price: under a limit that only fits the cheaper one, it is not sent.
    const tight = await tracked({ env: { MAX_DAILY_AI_SPEND: "0.11" }, prices: dearB ? { a: 50, b: 200 } : { a: 200, b: 50 } });
    tight.primary.steps = ["503"];
    const refused = await chat(tight);
    expect([tight.primary.calls, tight.backup.calls]).toEqual([1, 0]);
    expect(refused.error).toBeDefined();
  });

  it("CASE H: a fallback cheaper than the room already held needs no extension", async () => {
    const probe = await setup({ env: { MAX_DAILY_AI_SPEND: "1" } });
    const dearPrimary = probe.primary.id === "openai" ? { a: 100, b: 50 } : { a: 50, b: 100 };
    const s = await tracked({ env: { MAX_DAILY_AI_SPEND: "1" }, prices: dearPrimary });
    // The primary refused the server's credentials (401, before any work): it cost nothing.
    s.primary.steps = ["401"];
    const r = await chat(s);
    expect(r.text).toBe(ANSWER);
    expect(s.backup.heldAtCall).toEqual([2 * WORST]);
    const { hold } = await settledHold(s, r.messageId);
    expect(hold).toMatchObject({ reservedUsd: 2 * WORST, actualUsd: WORST });
    expect(metric(s, /dash_ai_spend_extension_attempts_total\{/)).toBe(false);
  });

  it("a provider timeout, then the fallback: the timed-out attempt keeps its worst case and the fallback is covered", async () => {
    const s = await tracked({ env: { MAX_DAILY_AI_SPEND: "1", PROVIDER_IDLE_TIMEOUT_MS: "500" } });
    s.primary.steps = ["stall"];
    const r = await chat(s);
    expect(r.text).toBe(ANSWER);
    expect(s.backup.heldAtCall).toEqual([2 * WORST]);
    const { rows } = await settledHold(s, r.messageId);
    expect(rows[0]).toMatchObject({ outcome: "failure", errorCode: "provider_timeout" });
  });

  it("CASE I (chat): partial output then failure is final: no retry, no fallback, settled from the ledger", async () => {
    const s = await tracked({ env: { MAX_DAILY_AI_SPEND: "1", PROVIDER_MAX_RETRIES: "2" } });
    s.primary.steps = ["partial"];
    const r = await chat(s);
    expect(r.text).toBe("Here is the start");
    expect(r.error).toBeDefined();
    expect(s.calls()).toBe(1);
    const { hold, rows } = await settledHold(s, r.messageId);
    expect(rows).toHaveLength(1);
    expect(hold.reservedUsd).toBe(WORST);
  });

  it("when a paid retry and the paid fallback cannot be covered, a free provider later in the route still answers", async () => {
    const s = await tracked({ free: true, env: { MAX_DAILY_AI_SPEND: "0.04", PROVIDER_MAX_RETRIES: "1" } });
    expect(s.order).toEqual([s.primary.id, s.backup.id, "freepool"]);
    s.primary.otherwise = "503";
    const r = await chat(s);
    expect(r.text).toBe(ANSWER);
    expect([s.primary.calls, s.backup.calls, s.f.calls]).toEqual([1, 0, 1]);
    const { rows } = await settledHold(s, r.messageId);
    expect(rows.map((x) => [x.provider, x.pricing])).toEqual([[s.primary.id, "paid"], ["freepool", "free"]]);
    expect(metric(s, /dash_ai_spend_prevented_attempts_total\{kind="retry",reason="denied"\} 1/)).toBe(true);
    expect(metric(s, /dash_ai_spend_prevented_attempts_total\{kind="fallback",reason="denied"\} 1/)).toBe(true);
  });

  it("retry and fallback in one answer, both covered: several ledger rows under one hold, no overage", async () => {
    const s = await tracked({ env: { MAX_DAILY_AI_SPEND: "1", PROVIDER_MAX_RETRIES: "1" } });
    s.primary.otherwise = "503";
    const r = await chat(s);
    expect(r.text).toBe(ANSWER);
    expect([s.primary.calls, s.backup.calls]).toEqual([2, 1]);
    expect(s.backup.heldAtCall).toEqual([0.075]);
    const { hold, rows } = await settledHold(s, r.messageId);
    expect(rows).toHaveLength(3);
    expect(hold).toMatchObject({ reservedUsd: 0.075, actualUsd: WORST });
  });
});

describe("tool rounds", () => {
  it("normal tool rounds are part of the admitted path: a full tool loop never extends the hold", async () => {
    const s = await tracked({ tools: true, env: { MAX_DAILY_AI_SPEND: "1", TOOL_MAX_ROUNDS: "2" } });
    s.primary.steps = ["tool", "tool", "answer"];
    const r = await chat(s, "list my issues");
    expect(r.text).toBe(ANSWER);
    expect(s.primary.calls).toBe(3);
    const { hold, rows } = await settledHold(s, r.messageId);
    expect(rows.map((x) => x.round)).toEqual([0, 1, 2]);
    // Admitted for three requests (two tool rounds and the final answer); held at that the whole time.
    expect(s.primary.heldAtCall).toEqual([hold.reservedUsd, hold.reservedUsd, hold.reservedUsd]);
    expect(metric(s, /dash_ai_spend_extension_attempts_total\{/)).toBe(false);
  });

  it("a round whose room an earlier retry used is extended first; if that is refused the answer ends where it is", async () => {
    const roomy = await tracked({ tools: true, env: { MAX_DAILY_AI_SPEND: "1", TOOL_MAX_ROUNDS: "1", PROVIDER_MAX_RETRIES: "1" } });
    roomy.primary.steps = ["503", "tool", "answer"];
    const ok = await chat(roomy, "list my issues");
    expect(ok.text).toBe(ANSWER);
    expect(roomy.primary.calls).toBe(3);
    await settledHold(roomy, ok.messageId);
    expect(metric(roomy, /dash_ai_spend_extensions_total\{kind="round",outcome="extended"\} 1/)).toBe(true);

    // Admitted at $0.05 (two requests); after the retry the final round needs $0.055 in all: over $0.052.
    const tight = await tracked({ tools: true, env: { MAX_DAILY_AI_SPEND: "0.052", TOOL_MAX_ROUNDS: "1", PROVIDER_MAX_RETRIES: "1" } });
    tight.primary.steps = ["503", "tool", "answer"];
    const ended = await chat(tight, "list my issues");
    // The retried tool round ran; the final round could not be covered and was never sent.
    expect(tight.primary.calls).toBe(2);
    expect(ended.end?.finishReason).toBe("length");
    expect(ended.error).toBeUndefined();
    await settledHold(tight, ended.messageId);
    expect(metric(tight, /dash_ai_spend_prevented_attempts_total\{kind="round",reason="denied"\} 1/)).toBe(true);
  });
});

describe("Automates runs", () => {
  async function run(s: Awaited<ReturnType<typeof setup>>) {
    const created = await s.app.inject({ method: "POST", url: "/v1/automations", headers: s.user.auth, payload: { name: "Brief", prompt: "Write my brief.", mode: "general", schedule: { kind: "daily", time: "08:00" }, timeZone: "Africa/Lagos" } });
    const automation = Automation.parse(created.json());
    const started = await s.app.inject({ method: "POST", url: `/v1/automations/${automation.id}/run`, headers: s.user.auth });
    await s.context.automations.idle();
    const runId = AutomationRunResponse.parse(started.json()).run.id;
    const detail = AutomationDetailResponse.parse((await s.app.inject({ method: "GET", url: `/v1/automations/${automation.id}`, headers: s.user.auth })).json());
    return { runId, run: detail.runs.find((x) => x.id === runId)! };
  }

  it("a failed attempt's retry is covered first; one the limit cannot cover is not sent", async () => {
    const s = await tracked({ env: { MAX_DAILY_AI_SPEND: "1", PROVIDER_MAX_RETRIES: "1" } });
    s.a.shared = s.b.shared = ["503", "cheap"];
    const ok = await run(s);
    expect(ok.run.status).toBe("ready");
    const first = s.a.calls > 0 ? s.a : s.b;
    expect(s.calls()).toBe(2);
    expect(first.heldAtCall).toEqual([WORST, 2 * WORST]); // the retry went to the same provider, after the extension
    await settledHold(s, ok.runId);

    const tight = await tracked({ env: { MAX_DAILY_AI_SPEND: "0.04", PROVIDER_MAX_RETRIES: "1" } });
    tight.a.otherwise = tight.b.otherwise = "503";
    const refused = await run(tight);
    expect(refused.run.status).toBe("failed");
    expect(tight.calls()).toBe(1); // no retry, no fallback
    await settledHold(tight, refused.runId);
  });

  it("CASE I (Automates): partial output then failure: the fallback is covered first, nothing is counted twice", async () => {
    const s = await tracked({ env: { MAX_DAILY_AI_SPEND: "1" } });
    s.a.shared = s.b.shared = ["partial", "answer"];
    const r = await run(s);
    expect(r.run.status).toBe("ready");
    expect([s.a.calls, s.b.calls]).toEqual([1, 1]);
    const fallback = s.a.heldAtCall.length && s.b.heldAtCall.length ? [s.a.heldAtCall[0], s.b.heldAtCall[0]].sort() : [];
    expect(fallback).toEqual([WORST, 2 * WORST]); // admitted at one worst case; the fallback found two held
    const { hold, rows } = await settledHold(s, r.runId);
    // The partial attempt is in the ledger at its estimate, the fallback at its reported usage: one row each.
    expect(rows).toHaveLength(2);
    expect(hold.actualUsd).toBeCloseTo(ledgerUsd(rows), 10);
    expect(hold.actualUsd!).toBeGreaterThan(WORST);
  });

  it("CASE J (Automates): an extension that cannot be checked sends nothing more", async () => {
    const store = new Spying();
    const s = await tracked({ store, env: { MAX_DAILY_AI_SPEND: "1", PROVIDER_MAX_RETRIES: "1" } });
    store.failExtend = true;
    s.primary.otherwise = "503";
    const r = await run(s);
    expect(r.run.status).toBe("failed");
    expect(s.calls()).toBe(1);
  });
});
