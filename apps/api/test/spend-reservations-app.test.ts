import { Automation, AutomationDetailResponse, AutomationRunResponse, type ProviderId, type StreamEvent } from "@dash-ai/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { NEUTRAL_UNAVAILABLE } from "../src/chat/publicSurface.js";
import { RESERVATION_GRACE_MS } from "../src/intelligence/platform.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { toProviderError, type ProviderAdapter, type ProviderChunk, type ProviderRequest } from "../src/providers/types.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import { PostgresStore } from "../src/store/postgresStore.js";
import type { ReserveSpendInput, ReserveSpendResult, SettleSpendResult, Store } from "../src/store/store.js";
import { chatBody, makeApp, register, sse, testConfig, testId, USING_POSTGRES } from "./helpers.js";
import { TEST_DATABASE_URL, createTestPgStore } from "./pgTestStore.js";

// Atomic in-flight spend reservations (ADR 0015) through the real chat and Automates paths: requests
// that are still running hold their worst case, so concurrent requests can no longer pass a limit
// together, and every hold is settled to the ledger's actual when its request ends. Providers are
// in-process fakes; nothing leaves the test.

type Step = "answer" | "cheap" | "503" | "wait";

/** A paid provider whose "wait" requests stay in flight until released (or aborted). */
class Engine implements ProviderAdapter {
  readonly demo = false;
  readonly requests: ProviderRequest[] = [];
  steps: Step[] = [];
  otherwise: Step = "answer";
  private waiting: Array<() => void> = [];
  constructor(
    readonly id: ProviderId,
    readonly model: string,
    readonly displayName: string,
  ) {}

  get calls(): number {
    return this.requests.length;
  }

  /** Lets every request in flight finish. */
  release(): void {
    for (const w of this.waiting.splice(0)) w();
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderChunk> {
    this.requests.push(request);
    let step = this.steps.shift() ?? this.otherwise;
    if (step === "wait") {
      await new Promise<void>((resolve, reject) => {
        this.waiting.push(resolve);
        request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      step = "answer";
    }
    if (step === "503") throw toProviderError(this.displayName, { status: 503 });
    yield { type: "text", text: ANSWER };
    // 500 output tokens at $50/M = the worst case; a cheap answer uses 100 of them.
    yield { type: "finish", finishReason: "stop", usage: { inputTokens: 1_000, outputTokens: step === "cheap" ? 100 : 500 }, servedModel: this.model };
  }
}

const ANSWER = "Here is your plan.";
const PRICES = { "openai:paid-a-model": { inputPerMillion: 0, outputPerMillion: 50 }, "anthropic:paid-b-model": { inputPerMillion: 0, outputPerMillion: 50 } };
/** One request's worst case (MAX_OUTPUT_TOKENS=500 at $50/M) and a full answer's actual cost. */
const WORST_USD = 0.025;
const CHEAP_USD = 0.005;

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

async function setup(o: { env?: Record<string, string>; store?: Store; engines?: { a: Engine; b: Engine } } = {}) {
  const a = o.engines?.a ?? new Engine("openai", "paid-a-model", "PAIDA");
  const b = o.engines?.b ?? new Engine("anthropic", "paid-b-model", "PAIDB");
  const config = testConfig({
    PROVIDER_DETAILS: "hidden",
    PROVIDER_RETRY_BASE_MS: "0",
    PROVIDER_MAX_RETRIES: "0",
    MAX_OUTPUT_TOKENS: "500",
    MODEL_PRICES: JSON.stringify(PRICES),
    MAX_CONCURRENT_STREAMS_PER_USER: "20",
    RATE_LIMIT_CHAT_PER_MINUTE: "1000",
    ...o.env,
  });
  const made = await makeApp({ config, providers: new ProviderRegistry({ openai: a, anthropic: b }), store: o.store ?? (await sharedStore()) });
  apps.push(made.app);
  const user = await register(made.app);
  return { ...made, a, b, user, calls: () => a.calls + b.calls, release: () => (a.release(), b.release()) };
}

const byEvent = <N extends StreamEvent["event"]>(events: StreamEvent[], name: N) =>
  events.filter((e): e is Extract<StreamEvent, { event: N }> => e.event === name);

async function chat(app: FastifyInstance, auth: Record<string, string>) {
  const res = await app.inject({ method: "POST", url: "/v1/chat/stream", headers: auth, payload: chatBody({ modelChoice: "smart", message: { id: testId("msg"), content: "plan my week", attachmentIds: [] } }) });
  const events = res.statusCode === 200 ? sse(res.body) : [];
  return { res, text: byEvent(events, "message.delta").map((e) => e.data.text).join(""), messageId: byEvent(events, "stream.start")[0]?.data.targets[0]?.messageId ?? "" };
}

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 5_000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function systemUsage(s: Awaited<ReturnType<typeof setup>>, scope = "system_daily") {
  s.context.ai.spend.invalidate();
  const status = await s.context.ai.spend.check({ userId: null, plan: "standard" });
  return status.usage.find((u) => u.scope === scope)!;
}

describe("concurrent requests cannot pass a spend limit together", () => {
  it("five chats at once under room for two: exactly two reach a provider, the rest are refused before any call", async () => {
    const s = await setup({ env: { MAX_DAILY_AI_SPEND: "0.06" } });
    s.a.otherwise = s.b.otherwise = "wait";
    const users = [s.user, ...(await Promise.all(Array.from({ length: 4 }, () => register(s.app))))];
    const pending = users.map((u) => chat(s.app, u.auth));
    // Two admitted and in flight; the others were refused while those two still held their worst case.
    await until(() => s.calls() === 2, "two admitted requests");
    await new Promise((r) => setTimeout(r, 100));
    s.release();
    const results = await Promise.all(pending);
    expect(results.filter((r) => r.text === ANSWER)).toHaveLength(2);
    const refused = results.filter((r) => r.res.statusCode === 503);
    expect(refused).toHaveLength(3);
    for (const r of refused) expect(r.res.json().error.message).toBe(NEUTRAL_UNAVAILABLE);
    expect(s.calls()).toBe(2);
    expect(await systemUsage(s)).toMatchObject({ actualUsd: 2 * WORST_USD, reservedUsd: 0 });
    expect(s.context.metrics.render()).toMatch(/dash_ai_spend_reservations_total\{outcome="admitted"\} 2/);
  });

  it("a running request keeps its hold for as long as it runs; its unused part is freed when it settles", async () => {
    const s = await setup({ env: { MAX_DAILY_AI_SPEND: "0.04" } });
    s.a.steps = ["wait"];
    s.b.steps = ["wait"];
    s.a.otherwise = s.b.otherwise = "cheap";
    const first = chat(s.app, s.user.auth);
    await until(() => s.calls() === 1, "first request in flight");
    expect(await systemUsage(s)).toMatchObject({ actualUsd: 0, reservedUsd: WORST_USD });
    // Still running well after admission: the hold has not lapsed and still blocks.
    await new Promise((r) => setTimeout(r, 400));
    const blocked = await chat(s.app, s.user.auth);
    expect(blocked.res.statusCode).toBe(503);
    expect(s.calls()).toBe(1);
    s.release();
    expect((await first).text).toBe(ANSWER);
    // Settled at its actual ($0.025 held, $0.025 spent: nothing left over here), no longer held.
    expect(await systemUsage(s)).toMatchObject({ actualUsd: WORST_USD, reservedUsd: 0 });
    // A cheap answer settles below its hold: the difference is usable again at once.
    const cheap = await setup({ env: { MAX_DAILY_AI_SPEND: "0.04" } });
    cheap.a.otherwise = cheap.b.otherwise = "cheap";
    for (let i = 0; i < 3; i++) expect((await chat(cheap.app, cheap.user.auth)).text).toBe(ANSWER);
    expect(await systemUsage(cheap)).toMatchObject({ actualUsd: 3 * CHEAP_USD, reservedUsd: 0 });
  });

  it("a person's limit counts their own requests in flight; other people still get answers", async () => {
    const s = await setup({ env: { MAX_USER_DAILY_AI_SPEND: "0.03", MAX_DAILY_AI_SPEND: "10" } });
    s.a.otherwise = s.b.otherwise = "wait";
    const mine = chat(s.app, s.user.auth);
    await until(() => s.calls() === 1, "first request in flight");
    const second = await chat(s.app, s.user.auth);
    expect(second.res.statusCode).toBe(429);
    expect(second.res.json().error.message).toBe("You've reached today's DASH AI usage limit. Please try again tomorrow.");
    const other = await register(s.app);
    const theirs = chat(s.app, other.auth);
    await until(() => s.calls() === 2, "other person's request in flight");
    s.release();
    expect([(await mine).text, (await theirs).text]).toEqual([ANSWER, ANSWER]);
  });

  it.skipIf(!TEST_DATABASE_URL)("two API instances on one PostgreSQL database share every hold", async () => {
    const t = await createTestPgStore();
    disposers.push(t.dispose);
    const second = await PostgresStore.connect({ connectionString: TEST_DATABASE_URL!, cipher: t.cipher, schema: t.schema });
    disposers.push(() => second.close());
    const env = { MAX_DAILY_AI_SPEND: "0.06" };
    const one = await setup({ env, store: t.store });
    const two = await setup({ env, store: second });
    for (const e of [one.a, one.b, two.a, two.b]) e.otherwise = "wait";
    const extra = await register(two.app);
    const pending = [chat(one.app, one.user.auth), chat(two.app, two.user.auth), chat(one.app, one.user.auth), chat(two.app, extra.auth)];
    await until(() => one.calls() + two.calls() === 2, "two admitted requests across instances");
    await new Promise((r) => setTimeout(r, 100));
    one.release();
    two.release();
    const results = await Promise.all(pending);
    expect(results.filter((r) => r.text === ANSWER)).toHaveLength(2);
    expect(results.filter((r) => r.res.statusCode === 503)).toHaveLength(2);
    expect(one.calls() + two.calls()).toBe(2);
  });
});

describe("reservation lifecycle through the request paths", () => {
  /** A store that records reservations and can be made to fail. */
  class Spying extends MemoryStore {
    reserves: ReserveSpendInput[] = [];
    results: ReserveSpendResult[] = [];
    failReserve = false;
    failSettle = 0;
    settles = 0;
    override async reserveSpend(input: ReserveSpendInput): Promise<ReserveSpendResult> {
      if (this.failReserve) throw new Error("database unavailable");
      this.reserves.push(input);
      const r = await super.reserveSpend(input);
      this.results.push(r);
      return r;
    }
    override async settleSpendReservation(id: string): Promise<SettleSpendResult | undefined> {
      this.settles += 1;
      if (this.failSettle > 0) {
        this.failSettle -= 1;
        throw new Error("database unavailable");
      }
      return super.settleSpendReservation(id);
    }
  }

  const held = async (store: Spying, i = 0) => {
    const r = store.results[i];
    if (!r?.ok) throw new Error("no hold");
    return store.getSpendReservation(r.reservation.id);
  };

  it("a chat's hold is its worst case, keyed by the answer, leased for PROVIDER_TIMEOUT_MS plus grace, and settled to the ledger", async () => {
    const store = new Spying();
    const s = await setup({ store, env: { MAX_DAILY_AI_SPEND: "1", PROVIDER_TIMEOUT_MS: "30000" } });
    s.a.otherwise = s.b.otherwise = "cheap";
    const r = await chat(s.app, s.user.auth);
    expect(r.text).toBe(ANSWER);
    expect(store.reserves).toHaveLength(1);
    expect(store.reserves[0]).toMatchObject({ inferenceId: r.messageId, userId: s.user.user.id, task: "chat", amountUsd: WORST_USD, leaseMs: 30_000 + RESERVATION_GRACE_MS });
    const record = await held(store);
    expect(record).toMatchObject({ status: "settled", reservedUsd: WORST_USD, actualUsd: CHEAP_USD, inferenceId: r.messageId });
    expect(Date.parse(record!.expiresAt) - Date.parse(record!.createdAt)).toBe(30_000 + RESERVATION_GRACE_MS);
    // Operational metadata only.
    expect(JSON.stringify(record)).not.toContain("plan my week");
    expect(JSON.stringify(record)).not.toContain(ANSWER);
    expect(s.context.metrics.render()).toMatch(/dash_ai_spend_reservation_settlements_total\{status="settled"\} 1/);
  });

  it("no aggregate limit means no hold; a refusal before billing releases the hold; a free route takes none", async () => {
    const store = new Spying();
    const s = await setup({ store, env: { MAX_REQUEST_AI_COST: "1" } });
    expect((await chat(s.app, s.user.auth)).text).toBe(ANSWER);
    expect(store.reserves).toHaveLength(0);

    const refusing = new Spying();
    const r = await setup({ store: refusing, env: { MAX_DAILY_AI_SPEND: "1" } });
    r.a.otherwise = r.b.otherwise = "503";
    await chat(r.app, r.user.auth);
    expect(r.calls()).toBe(2); // both providers tried (fallback inside the route, covered by one hold)
    expect(await held(refusing)).toMatchObject({ status: "released", actualUsd: 0 });
  });

  it("a cancelled answer is settled with what may have been billed", async () => {
    const store = new Spying();
    const s = await setup({ store, env: { MAX_DAILY_AI_SPEND: "1", MODEL_PRICES: JSON.stringify({ "openai:paid-a-model": { inputPerMillion: 100, outputPerMillion: 50 }, "anthropic:paid-b-model": { inputPerMillion: 100, outputPerMillion: 50 } }) } });
    s.a.otherwise = s.b.otherwise = "wait";
    const pending = s.app.inject({ method: "POST", url: "/v1/chat/stream", headers: s.user.auth, payload: chatBody({ modelChoice: "smart", message: { id: testId("msg"), content: "plan my week", attachmentIds: [] } }) });
    await until(() => s.calls() === 1, "request in flight");
    s.context.streams.cancelAllForUser(s.user.user.id);
    await pending;
    const record = await held(store);
    expect(record?.status === "settled" || record?.status === "released").toBe(true);
    const ledger = await store.listInferenceAttempts(record!.inferenceId);
    const ledgerUsd = ledger.reduce((n, x) => n + (x.estimatedCostUsd ?? 0), 0);
    expect(record!.actualUsd).toBeCloseTo(ledgerUsd, 10);
  });

  it("when the hold cannot be checked, paid work is refused as busy and no provider is called (fails closed)", async () => {
    const store = new Spying();
    const s = await setup({ store, env: { MAX_DAILY_AI_SPEND: "1" } });
    store.failReserve = true;
    const r = await chat(s.app, s.user.auth);
    expect(r.res.statusCode).toBe(429);
    expect(r.res.json().error).toMatchObject({ message: "DASH AI is very busy right now. Please try again in a moment.", retryable: true });
    expect(s.calls()).toBe(0);
    expect(s.context.metrics.render()).toMatch(/dash_ai_spend_reservations_total\{outcome="error"\} 1/);
  });

  it("a failed settlement is retried; if it keeps failing the hold stays (over-protects) and is counted", async () => {
    const store = new Spying();
    const s = await setup({ store, env: { MAX_DAILY_AI_SPEND: "1" } });
    s.a.otherwise = s.b.otherwise = "cheap";
    store.failSettle = 2;
    expect((await chat(s.app, s.user.auth)).text).toBe(ANSWER);
    expect(await held(store, 0)).toMatchObject({ status: "settled" });

    store.failSettle = 10;
    expect((await chat(s.app, s.user.auth)).text).toBe(ANSWER);
    expect(await held(store, 1)).toMatchObject({ status: "active" });
    expect(s.context.metrics.render()).toMatch(/dash_ai_spend_reservation_failures_total\{stage="settle"\} 1/);
    // It still counts until settled or expired: the limit is protected, never loosened.
    expect((await systemUsage(s)).reservedUsd).toBeCloseTo(WORST_USD - CHEAP_USD, 10);
  });

  it("an actual above the hold is reported as an invariant violation", async () => {
    const store = new Spying();
    const s = await setup({ store, env: { MAX_DAILY_AI_SPEND: "1" } });
    const r = await store.reserveSpend({ id: testId("res"), inferenceId: "over-1", userId: null, plan: "standard", task: "chat", provider: "openai", model: "paid-a-model", amountUsd: 0.01, leaseMs: 60_000, limits: [] });
    if (!r.ok) throw new Error("expected a hold");
    await store.recordInferenceAttempt({
      id: testId("att"), inferenceId: "over-1", userId: null, plan: "standard", task: "chat", mode: "general", provider: "openai", model: "paid-a-model",
      configuredModel: "paid-a-model", pricing: "paid", createdAt: new Date().toISOString(), latencyMs: 1, outcome: "failure", errorCode: "provider_timeout",
      httpStatus: null, retry: 1, round: 0, fallbackIndex: 0, inputTokens: null, outputTokens: null, cachedInputTokens: null, estimatedInputTokens: 0,
      estimatedOutputTokens: 400, tokenSource: "estimated", estimatedCostUsd: 0.02, providerCostUsd: null, currency: "USD", route: {},
    });
    await s.context.ai.settle(r.reservation);
    expect(s.context.metrics.render()).toMatch(/dash_ai_spend_reservation_overage_total 1/);
    expect((await store.getSpendReservation(r.reservation.id))?.actualUsd).toBe(0.02);
  });

  it("an Automates run holds its worst case for its time budget and settles when it finishes", async () => {
    const store = new Spying();
    const s = await setup({ store, env: { MAX_DAILY_AI_SPEND: "1" } });
    s.a.otherwise = s.b.otherwise = "cheap";
    const created = await s.app.inject({ method: "POST", url: "/v1/automations", headers: s.user.auth, payload: { name: "Brief", prompt: "Write my brief.", mode: "business", schedule: { kind: "daily", time: "08:00" }, timeZone: "Africa/Lagos" } });
    const automation = Automation.parse(created.json());
    const run = await s.app.inject({ method: "POST", url: `/v1/automations/${automation.id}/run`, headers: s.user.auth });
    await s.context.automations.idle();
    const runId = AutomationRunResponse.parse(run.json()).run.id;
    const detail = AutomationDetailResponse.parse((await s.app.inject({ method: "GET", url: `/v1/automations/${automation.id}`, headers: s.user.auth })).json());
    expect(detail.runs.find((r) => r.id === runId)?.status).toBe("ready");
    expect(store.reserves[0]).toMatchObject({ inferenceId: runId, task: "automation", amountUsd: WORST_USD });
    expect(store.reserves[0]!.leaseMs).toBeGreaterThan(RESERVATION_GRACE_MS);
    expect(await held(store)).toMatchObject({ status: "settled", actualUsd: CHEAP_USD });

    store.failReserve = true;
    const again = await s.app.inject({ method: "POST", url: `/v1/automations/${automation.id}/run`, headers: s.user.auth });
    await s.context.automations.idle();
    const failedId = AutomationRunResponse.parse(again.json()).run.id;
    const after = AutomationDetailResponse.parse((await s.app.inject({ method: "GET", url: `/v1/automations/${automation.id}`, headers: s.user.auth })).json());
    expect(after.runs.find((r) => r.id === failedId)?.status).toBe("failed");
    expect(s.calls()).toBe(1);
  });
});
