/**
 * In-process operational metrics, rendered in the Prometheus text format. Every metric is declared
 * up front with a fixed set of label names, and every label value must look like an identifier
 * (provider id, error code, status, route name). Anything else is recorded as "other", so prompts,
 * answers, document text, tool payloads, emails, tokens or keys can never become a label, even by
 * mistake. Values are counts and durations only.
 */

const SAFE_LABEL = /^[a-z0-9][a-z0-9_.:-]{0,47}$/;
const sanitize = (value: string | number | boolean): string => {
  const text = String(value);
  return SAFE_LABEL.test(text) ? text : "other";
};

type Labels<N extends string> = Partial<Record<N, string | number | boolean>>;

abstract class Metric<N extends string> {
  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly N[],
  ) {}

  protected key(labels: Labels<N>): string {
    for (const name of Object.keys(labels)) {
      if (!this.labelNames.includes(name as N)) throw new Error(`Unknown label "${name}" for metric ${this.name}`);
    }
    return this.labelNames.map((n) => sanitize(labels[n] ?? "none")).join("\u0000");
  }

  protected labelText(key: string, extra = ""): string {
    const values = key.split("\u0000");
    const parts = this.labelNames.map((n, i) => `${n}="${values[i]}"`);
    if (extra) parts.push(extra);
    return parts.length > 0 ? `{${parts.join(",")}}` : "";
  }

  abstract render(): string[];
  abstract reset(): void;
}

export class Counter<N extends string = never> extends Metric<N> {
  private readonly values = new Map<string, number>();

  inc(labels: Labels<N> = {}, by = 1): void {
    const key = this.key(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }

  get(labels: Labels<N> = {}): number {
    return this.values.get(this.key(labels)) ?? 0;
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [key, value] of this.values) lines.push(`${this.name}${this.labelText(key)} ${value}`);
    return lines;
  }

  reset(): void {
    this.values.clear();
  }
}

export class Gauge<N extends string = never> extends Metric<N> {
  private readonly values = new Map<string, number>();

  set(labels: Labels<N>, value: number): void {
    this.values.set(this.key(labels), value);
  }

  get(labels: Labels<N> = {}): number | undefined {
    return this.values.get(this.key(labels));
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const [key, value] of this.values) lines.push(`${this.name}${this.labelText(key)} ${value}`);
    return lines;
  }

  reset(): void {
    this.values.clear();
  }
}

export class Histogram<N extends string = never> extends Metric<N> {
  private readonly series = new Map<string, { buckets: number[]; sum: number; count: number }>();

  constructor(name: string, help: string, labelNames: readonly N[], private readonly bounds: readonly number[]) {
    super(name, help, labelNames);
  }

  observe(labels: Labels<N>, value: number): void {
    const key = this.key(labels);
    const s = this.series.get(key) ?? { buckets: this.bounds.map(() => 0), sum: 0, count: 0 };
    this.bounds.forEach((b, i) => {
      if (value <= b) s.buckets[i]! += 1;
    });
    s.sum += value;
    s.count += 1;
    this.series.set(key, s);
  }

  count(labels: Labels<N> = {}): number {
    return this.series.get(this.key(labels))?.count ?? 0;
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [key, s] of this.series) {
      this.bounds.forEach((b, i) => lines.push(`${this.name}_bucket${this.labelText(key, `le="${b}"`)} ${s.buckets[i]}`));
      lines.push(`${this.name}_bucket${this.labelText(key, 'le="+Inf"')} ${s.count}`);
      lines.push(`${this.name}_sum${this.labelText(key)} ${Math.round(s.sum * 1000) / 1000}`);
      lines.push(`${this.name}_count${this.labelText(key)} ${s.count}`);
    }
    return lines;
  }

  reset(): void {
    this.series.clear();
  }
}

const SECONDS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120];

/** All metrics the API emits. One instance per app (tests get their own). */
export class Metrics {
  readonly aiRequestSeconds = new Histogram("dash_ai_request_seconds", "Duration of one provider answer, from request to final status.", ["provider", "status"], SECONDS);
  readonly providerFailures = new Counter("dash_provider_failures_total", "Provider attempts that failed, by normalized error code.", ["provider", "code", "retryable"]);
  readonly providerRetries = new Counter("dash_provider_retries_total", "Provider requests retried after a retryable failure.", ["provider", "code"]);
  readonly estimatedCostUsd = new Counter("dash_ai_estimated_cost_usd_total", "Estimated USD cost of real answers with a known price (see MODEL_PRICES).", ["provider"]);
  readonly inferenceAttempts = new Counter("dash_ai_inference_attempts_total", "Provider attempts recorded in the inference ledger.", ["provider", "pricing", "outcome"]);
  readonly attemptCostUsd = new Counter("dash_ai_attempt_cost_usd_total", "USD cost of provider attempts (provider-reported, else estimated), by pricing class.", ["pricing"]);
  readonly providerPauses = new Counter("dash_ai_provider_pauses_total", "Providers temporarily disabled after reporting an exhausted quota or a long wait.", ["provider", "reason"]);
  readonly ledgerWriteFailures = new Counter("dash_ai_ledger_write_failures_total", "Provider attempts that could not be written to the inference ledger (spend limits under-count until fixed).", []);
  readonly spendBlocked = new Counter("dash_ai_spend_blocked_total", "Requests for which a spend limit stopped paid providers.", ["scope"]);
  readonly spendReservations = new Counter("dash_ai_spend_reservations_total", "Spend reservation attempts at admission (admitted, denied, error = could not check: refused).", ["outcome"]);
  readonly spendReservationSettlements = new Counter("dash_ai_spend_reservation_settlements_total", "Spend reservations ended (settled, released, expired = settled after its lease ran out).", ["status"]);
  readonly spendReservationOverage = new Counter("dash_ai_spend_reservation_overage_total", "INVARIANT VIOLATION: requests whose actual paid cost exceeded their reservation.", []);
  readonly spendReservationOverageUsd = new Counter("dash_ai_spend_reservation_overage_usd_total", "USD by which settled requests exceeded their reservations.", []);
  readonly spendReservationFailures = new Counter("dash_ai_spend_reservation_failures_total", "Spend reservation store errors, by stage (reserve, settle, sweep).", ["stage"]);
  readonly spendReservationsExpired = new Counter("dash_ai_spend_reservations_expired_total", "Lapsed spend reservations marked expired by housekeeping (their request never settled).", []);
  readonly providerFallbacks = new Counter("dash_provider_fallbacks_total", "Answers DASH AI routed to another provider after a failure before any output.", ["from", "to", "code"]);
  readonly routerDecisions = new Counter("dash_router_decisions_total", "Requests the DASH Intelligence Router routed, by task and first-choice provider.", ["task", "provider"]);
  readonly routerUnavailable = new Counter("dash_router_unavailable_total", "Requests the router could not route, by task and reason.", ["task", "reason"]);
  readonly automationRuns = new Counter("dash_automation_runs_total", "Automation runs finished, by trigger and status.", ["trigger", "status"]);
  readonly automationRunSeconds = new Histogram("dash_automation_run_seconds", "Duration of one automation run, from start to final status.", ["status"], SECONDS);
  readonly pushDeliveries = new Counter("dash_push_deliveries_total", "Push delivery attempts by outcome (sent, retry, failed, invalid_token, signed_out, disabled, already_read, expired, no_transport).", ["outcome"]);
  readonly toolInvocations = new Counter("dash_tool_invocations_total", "Tool calls by outcome (ok, denied, invalid_arguments, timeout, error, cancelled, unknown_tool, replayed).", ["plugin", "tool", "status"]);
  readonly syncFailures = new Counter("dash_sync_failures_total", "Sync requests that failed, by operation and error code.", ["operation", "code"]);
  readonly syncRequests = new Counter("dash_sync_requests_total", "Sync requests handled, by operation.", ["operation"]);
  readonly rateLimitRejections = new Counter("dash_rate_limit_rejections_total", "Requests refused by a rate limit.", ["limit"]);
  readonly rateLimitBackendErrors = new Counter("dash_rate_limit_backend_errors_total", "Shared rate-limit backend errors (requests fell back to per-instance limits).", ["backend"]);
  readonly documentRejections = new Counter("dash_document_rejections_total", "Uploaded documents stored as unsupported, by reason.", ["kind", "reason"]);
  readonly documentExtractionSeconds = new Histogram("dash_document_extraction_seconds", "Time spent extracting text from one document.", ["kind", "status"], SECONDS);
  readonly databaseUp = new Gauge("dash_database_up", "1 when the last database health check succeeded, else 0.", ["store"]);
  readonly rateLimitBackendUp = new Gauge("dash_rate_limit_backend_up", "1 when the shared rate-limit backend answered its last health check, else 0.", ["backend"]);

  private all(): Metric<string>[] {
    return Object.values(this).filter((m): m is Metric<string> => m instanceof Metric);
  }

  render(): string {
    return `${this.all().flatMap((m) => m.render()).join("\n")}\n`;
  }

  reset(): void {
    for (const m of this.all()) m.reset();
  }
}
