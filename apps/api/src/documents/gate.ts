/**
 * Backpressure for document uploads on one instance. Every upload takes a ticket BEFORE its body is
 * read, so the uploads held in memory are bounded by `maxActive + maxWaiting` (each up to 10 MB), and
 * one account can hold at most `maxPerAccount` of them. When there is no room, the upload is refused at
 * once as busy instead of waiting without limit. A waiting upload gives up after `maxWaitMs`, or as
 * soon as its client disconnects; a ticket is released exactly once whatever happens (parser timeout,
 * crash, client gone, shutdown).
 */

export class GateBusy extends Error {
  constructor(readonly reason: "saturated" | "account" | "wait_timeout" | "closed") {
    super("Document extraction is busy");
    this.name = "GateBusy";
  }
}

export interface ExtractionGateOptions {
  /** Extraction processes running at once on this instance. */
  maxActive: number;
  /** Uploads waiting for an extraction process (their bodies are in memory). */
  maxWaiting: number;
  /** Uploads one account may have in progress on this instance (receiving, waiting or extracting). */
  maxPerAccount: number;
  /** How long an upload may wait for an extraction process before it is refused as busy. */
  maxWaitMs: number;
}

interface Waiter {
  start: () => void;
  fail: (err: GateBusy) => void;
}

export interface GateTicket {
  /** Runs `fn` in an extraction slot: waits (bounded) for one first. Rejects with GateBusy. */
  run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  /** Gives the ticket back. Idempotent. */
  release(): void;
}

export class ExtractionGate {
  private active = 0;
  /** Tickets held (receiving a body, waiting or extracting). */
  private held = 0;
  private readonly perAccount = new Map<string, number>();
  private readonly queue: Waiter[] = [];
  private closed = false;

  constructor(
    readonly options: ExtractionGateOptions,
    private readonly onChange: (state: { active: number; waiting: number; held: number }) => void = () => undefined,
  ) {}

  /** Uploads that may be in memory at once (active + waiting). */
  get capacity(): number {
    return this.options.maxActive + this.options.maxWaiting;
  }

  get state(): { active: number; waiting: number; held: number } {
    return { active: this.active, waiting: this.queue.length, held: this.held };
  }

  private changed(): void {
    this.onChange(this.state);
  }

  /** A place for one upload, or GateBusy (thrown) when there is none. Never waits. */
  enter(account: string): GateTicket {
    if (this.closed) throw new GateBusy("closed");
    if (this.held >= this.capacity) throw new GateBusy("saturated");
    const mine = this.perAccount.get(account) ?? 0;
    if (mine >= this.options.maxPerAccount) throw new GateBusy("account");
    this.held += 1;
    this.perAccount.set(account, mine + 1);
    this.changed();

    let released = false;
    let running = false;
    const release = () => {
      if (released) return;
      released = true;
      this.held -= 1;
      const left = (this.perAccount.get(account) ?? 1) - 1;
      if (left <= 0) this.perAccount.delete(account);
      else this.perAccount.set(account, left);
      if (running) {
        running = false;
        this.active -= 1;
        this.next();
      }
      this.changed();
    };

    const acquire = (signal?: AbortSignal): Promise<void> => {
      if (this.active < this.options.maxActive && this.queue.length === 0) {
        this.active += 1;
        running = true;
        this.changed();
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        const waiter: Waiter = {
          start: () => {
            cleanup();
            this.active += 1;
            running = true;
            resolve();
          },
          fail: (err) => {
            cleanup();
            reject(err);
          },
        };
        const onAbort = () => {
          this.remove(waiter);
          waiter.fail(new GateBusy("closed"));
        };
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        };
        const timer = setTimeout(() => {
          this.remove(waiter);
          waiter.fail(new GateBusy("wait_timeout"));
        }, this.options.maxWaitMs);
        if (signal?.aborted) return onAbort();
        signal?.addEventListener("abort", onAbort, { once: true });
        this.queue.push(waiter);
        this.changed();
      });
    };

    return {
      run: async <T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
        if (released) throw new GateBusy("closed");
        await acquire(signal);
        try {
          return await fn();
        } finally {
          if (running) {
            running = false;
            this.active -= 1;
            this.next();
            this.changed();
          }
        }
      },
      release,
    };
  }

  private remove(waiter: Waiter): void {
    const i = this.queue.indexOf(waiter);
    if (i >= 0) this.queue.splice(i, 1);
    this.changed();
  }

  private next(): void {
    while (this.active < this.options.maxActive && this.queue.length > 0) this.queue.shift()!.start();
  }

  /** Shutdown: refuse new uploads and every waiting one (running extractions finish or are killed). */
  close(): void {
    this.closed = true;
    for (const w of this.queue.splice(0)) w.fail(new GateBusy("closed"));
    this.changed();
  }
}
