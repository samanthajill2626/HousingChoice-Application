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
   * time (+ jitter) and retries. Calls are serialised FIFO so the shared rate
   * is honoured under concurrency.
   *
   * A DRAW LARGER THAN CAPACITY IS PAID IN FULL, NOT CLAMPED (fix wave 2,
   * adversarial 3 / conformance F3). `count` used to be clamped to capacity,
   * and capacity is `max(1, a2pRateLimitPerSec)` - so at the SHIPPED default
   * rate of 1/sec a nine-member group post drew exactly ONE token for nine
   * carrier messages. The meter read as if it metered and did not. Beyond
   * capacity the draw is now taken in capacity-sized instalments against the
   * same serialised budget, which costs the same wall-clock time the rate
   * implies (9 messages at 1/sec = ~9s of throughput) and can never overdraw.
   *
   * `timeoutMs` bounds the TOTAL wait, queue time included, and rejects with
   * `TokenBucketBusyError` when it is exceeded. Background jobs (every
   * pre-existing caller) pass nothing and keep the old unbounded behaviour; an
   * INTERACTIVE caller passes a bound so an Express request is never held open
   * indefinitely behind other waiters.
   */
  async acquire(count = 1, opts: { timeoutMs?: number } = {}): Promise<void> {
    const want = Math.max(count, 1);
    const deadline = opts.timeoutMs === undefined ? undefined : this.now() + opts.timeoutMs;
    // Chain onto the prior acquire so waiters drain in order against one budget.
    const prior = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      // The FIFO queue is part of the wait: N sends ahead of this one is exactly
      // how an interactive request ends up parked for minutes.
      if (deadline !== undefined && this.now() >= deadline) {
        throw new TokenBucketBusyError(want, opts.timeoutMs as number);
      }
      let remaining = want;
      // Guard against a runaway loop (a clock that never advances): bounded by
      // a generous iteration cap — in practice one or two sleeps suffice.
      for (let guard = 0; guard < 100_000; guard++) {
        this.refill();
        // Take at most one bucketful at a time; a larger draw pays instalments.
        const instalment = Math.min(remaining, this.capacity);
        if (this.tokens >= instalment) {
          this.tokens -= instalment;
          remaining -= instalment;
          if (remaining <= 0) return;
          continue;
        }
        const deficit = instalment - this.tokens;
        const waitMs = Math.ceil((deficit / this.refillPerSec) * 1000);
        const jitter = this.maxJitterMs > 0 ? Math.floor(Math.random() * this.maxJitterMs) : 0;
        if (deadline !== undefined && this.now() + waitMs > deadline) {
          throw new TokenBucketBusyError(want, opts.timeoutMs as number);
        }
        await this.sleep(waitMs + jitter);
      }
      throw new Error('TokenBucket.acquire: exceeded retry guard — is the clock advancing?');
    } finally {
      release();
    }
  }
}

/**
 * The bounded wait expired before this draw could be paid. Thrown ONLY when a
 * caller asked for a bound; the throughput was never spent, so the caller is
 * free to refuse the work and let a human retry (fix wave 2, adversarial 16).
 */
export class TokenBucketBusyError extends Error {
  constructor(
    readonly wanted: number,
    readonly waitedMs: number,
  ) {
    super(`token bucket busy: ${wanted} token(s) not available within ${waitedMs}ms`);
    this.name = 'TokenBucketBusyError';
  }
}

/**
 * THE PROCESS-WIDE A2P BUCKET (fix wave 5, adversarial 34).
 *
 * `acquire()` is only a meter if everything that meters draws from the SAME
 * instance. Relay fan-out, broadcasts and missed-call auto-text already share
 * one, built at boot and handed to the job handlers. A GROUP SEND is the first
 * metered outbound that runs in the APP process on an interactive route rather
 * than in a job - and one group post is up to NINE carrier messages, so leaving
 * it unmetered let a burst of group replies eat throughput that broadcasts and
 * tour reminders are being paced against.
 *
 * Memoized per process, sized from the same config the boot path uses. It is
 * therefore per-ECS-task, exactly like the existing bucket - the meter has
 * always been per-process, and this makes the group path no worse than the
 * paths beside it while closing the "nine messages, zero tokens" hole.
 *
 * PER PROCESS, NOT ACROSS THEM (fix wave 2, conformance F3). In a deployed
 * app/worker split the app draws from its own instance and the worker from
 * its own; both are built HERE (worker.ts calls this too, fix wave 2,
 * adversarial 31) so the sizing cannot drift, but no comment anywhere should
 * claim the two processes share a budget. They never have.
 */
let sharedBucket: TokenBucket | undefined;

export function sharedA2pBucket(a2pRateLimitPerSec: number): TokenBucket {
  sharedBucket ??= new TokenBucket({
    // capacity == the EXACT per-second rate (not ceil - at a fractional rate
    // ceil would let a burst exceed the tier), floored at 1.
    capacity: Math.max(1, a2pRateLimitPerSec),
    refillPerSec: a2pRateLimitPerSec,
  });
  return sharedBucket;
}

/** Test seam: drop the memoized instance so a suite can size its own. */
export function resetSharedA2pBucket(): void {
  sharedBucket = undefined;
}
