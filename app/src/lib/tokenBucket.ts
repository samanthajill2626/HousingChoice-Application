// TokenBucket (M1.7) — await-able pacing for A2P-throttled outbound sends.
//
// The relay fan-out (and the future M1.8 broadcast) share ONE bucket sized
// from config (a2pRateLimitPerSec), instantiated once at worker boot, so the
// COMBINED outbound rate stays under the registered A2P tier no matter how
// many fan-outs run concurrently. acquire() resolves as soon as tokens are
// available, sleeping (with small jitter) when they are not — it never blocks
// forever (a refill always arrives).
//
// PURE + injectable time: the bucket takes a `now()` clock and a `sleep(ms)`
// so unit tests drive it on a fake clock with no real timers — matching the
// codebase's time-injection convention (no bare Date.now() in metered paths).
import { setTimeout as delay } from 'node:timers/promises';

export interface TokenBucketOptions {
  /** Max tokens the bucket holds (burst ceiling). */
  capacity: number;
  /** Tokens added per second (the sustained rate). */
  refillPerSec: number;
  /** Injectable monotonic-ish clock (ms). Default Date.now. */
  now?: () => number;
  /** Injectable sleep. Default node:timers/promises setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Max random jitter (ms) added to each computed wait so concurrent
   * acquirers don't wake in lockstep and burst the provider. Default 25ms;
   * tests pass 0 for deterministic timing.
   */
  maxJitterMs?: number;
}

export class TokenBucket {
  readonly capacity: number;
  readonly refillPerSec: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxJitterMs: number;
  private tokens: number;
  private lastRefill: number;
  /**
   * Serialises waiters so they drain in FIFO order against the SAME token
   * budget — without this, N concurrent acquirers would each independently
   * "see" tokens and overshoot the rate. Each acquire chains onto the prior.
   */
  private tail: Promise<void> = Promise.resolve();

  constructor(opts: TokenBucketOptions) {
    if (!(opts.capacity > 0)) throw new Error('TokenBucket: capacity must be > 0');
    if (!(opts.refillPerSec > 0)) throw new Error('TokenBucket: refillPerSec must be > 0');
    this.capacity = opts.capacity;
    this.refillPerSec = opts.refillPerSec;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => delay(ms));
    this.maxJitterMs = opts.maxJitterMs ?? 25;
    // Start full so the first burst (up to capacity) is immediate.
    this.tokens = opts.capacity;
    this.lastRefill = this.now();
  }

  /** Refill tokens accrued since the last check, capped at capacity. */
  private refill(): void {
    const t = this.now();
    const elapsedMs = t - this.lastRefill;
    if (elapsedMs <= 0) return;
    const accrued = (elapsedMs / 1000) * this.refillPerSec;
    if (accrued <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + accrued);
    this.lastRefill = t;
  }

  /**
   * Acquire `count` tokens, awaiting availability. Resolves immediately when
   * enough tokens are on hand; otherwise sleeps for the exact deficit-refill
   * time (+ jitter) and retries. count is clamped to capacity (a single
   * request can never want more than the bucket can ever hold). Calls are
   * serialised FIFO so the shared rate is honoured under concurrency.
   */
  async acquire(count = 1): Promise<void> {
    const want = Math.min(Math.max(count, 1), this.capacity);
    // Chain onto the prior acquire so waiters drain in order against one budget.
    const prior = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      // Guard against a runaway loop (a clock that never advances): bounded by
      // a generous iteration cap — in practice one or two sleeps suffice.
      for (let guard = 0; guard < 100_000; guard++) {
        this.refill();
        if (this.tokens >= want) {
          this.tokens -= want;
          return;
        }
        const deficit = want - this.tokens;
        const waitMs = Math.ceil((deficit / this.refillPerSec) * 1000);
        const jitter = this.maxJitterMs > 0 ? Math.floor(Math.random() * this.maxJitterMs) : 0;
        await this.sleep(waitMs + jitter);
      }
      throw new Error('TokenBucket.acquire: exceeded retry guard — is the clock advancing?');
    } finally {
      release();
    }
  }
}
