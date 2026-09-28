export interface RateDecision {
  allowed: boolean;
  /** Milliseconds until one more request would be allowed (0 when allowed). */
  retryAfterMs: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * Token-bucket rate limiter kept in memory. Each key gets `capacity` requests that refill evenly
 * over `windowMs`. This is a foundation for a single instance; a multi-instance deployment should
 * move buckets to a shared store (see docs/roadmap.md).
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly capacity: number,
    private readonly windowMs: number = 60_000,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 50_000,
  ) {}

  consume(key: string, cost = 1): RateDecision {
    const now = this.now();
    const refillPerMs = this.capacity / this.windowMs;
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: now };
    bucket.tokens = Math.min(this.capacity, bucket.tokens + (now - bucket.updatedAt) * refillPerMs);
    bucket.updatedAt = now;

    let decision: RateDecision;
    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      decision = { allowed: true, retryAfterMs: 0 };
    } else {
      decision = { allowed: false, retryAfterMs: Math.ceil((cost - bucket.tokens) / refillPerMs) };
    }
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    if (this.buckets.size > this.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest !== undefined) this.buckets.delete(oldest);
    }
    return decision;
  }

  reset(key?: string): void {
    if (key === undefined) this.buckets.clear();
    else this.buckets.delete(key);
  }
}
