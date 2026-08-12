// TokenBucket (M1.7) — pacing on an INJECTED clock + sleep so no real timers
// run. Verifies: an initial burst up to capacity is immediate; further
// acquisitions wait exactly the refill time; concurrent acquirers honour the
// shared rate; acquire never blocks forever.
import { describe, expect, it } from 'vitest';
import { TokenBucket, TokenBucketBusyError } from '../src/lib/tokenBucket.js';

/**
 * Fake clock + sleep: sleep ADVANCES the clock by the requested ms (so the
 * next refill check sees the time pass) and records the wait. Deterministic,
 * no real timers, jitter disabled.
 */
function fakeTime() {
  let nowMs = 0;
  const waits: number[] = [];
  return {
    now: () => nowMs,
    sleep: async (ms: number) => {
      waits.push(ms);
      nowMs += ms;
    },
    advance: (ms: number) => {
      nowMs += ms;
    },
    get waits() {
      return waits;
    },
  };
}

describe('TokenBucket', () => {
  it('serves an initial burst up to capacity with NO waits', async () => {
    const clock = fakeTime();
    const bucket = new TokenBucket({ capacity: 3, refillPerSec: 1, now: clock.now, sleep: clock.sleep, maxJitterMs: 0 });
    await bucket.acquire();
    await bucket.acquire();
    await bucket.acquire();
    expect(clock.waits).toEqual([]); // full bucket → immediate
  });

  it('paces the 2nd acquisition at the refill rate when the bucket is empty', async () => {
    const clock = fakeTime();
    // capacity 1, 1 token/sec: first immediate, second waits ~1000ms.
    const bucket = new TokenBucket({ capacity: 1, refillPerSec: 1, now: clock.now, sleep: clock.sleep, maxJitterMs: 0 });
    await bucket.acquire(); // immediate (starts full)
    await bucket.acquire(); // must wait one refill period
    expect(clock.waits).toEqual([1000]);
  });

  it('paces several acquisitions at the configured rate (2/sec)', async () => {
    const clock = fakeTime();
    const bucket = new TokenBucket({ capacity: 1, refillPerSec: 2, now: clock.now, sleep: clock.sleep, maxJitterMs: 0 });
    await bucket.acquire(); // immediate
    await bucket.acquire(); // +500ms
    await bucket.acquire(); // +500ms
    expect(clock.waits).toEqual([500, 500]);
  });

  it('serializes concurrent acquirers against ONE shared budget (no overshoot)', async () => {
    const clock = fakeTime();
    const bucket = new TokenBucket({ capacity: 1, refillPerSec: 1, now: clock.now, sleep: clock.sleep, maxJitterMs: 0 });
    // Fire 3 acquisitions concurrently: one immediate, the next two each wait
    // a full second (drained FIFO). Total simulated wait = 2 seconds.
    await Promise.all([bucket.acquire(), bucket.acquire(), bucket.acquire()]);
    expect(clock.waits.reduce((a, b) => a + b, 0)).toBe(2000);
    expect(clock.waits).toHaveLength(2);
  });

  it('does not block forever — resolves after the deficit refill', async () => {
    const clock = fakeTime();
    const bucket = new TokenBucket({ capacity: 2, refillPerSec: 4, now: clock.now, sleep: clock.sleep, maxJitterMs: 0 });
    await bucket.acquire(2); // drains the full bucket immediately
    await bucket.acquire(2); // needs 2 tokens at 4/sec → 500ms
    expect(clock.waits).toEqual([500]);
  });

  it('pays a request larger than capacity IN FULL, in instalments (never deadlocks)', async () => {
    // WAS "clamps a request larger than capacity" (fix wave 2, adversarial 3 /
    // conformance F3). The clamp made the meter lie: a group send draws one
    // token per carrier message, capacity is max(1, A2P_RATE_LIMIT_PER_SEC), and
    // the shipped default is 1.0 - so a nine-member group post drew ONE token
    // for nine messages and every test that stubbed the bucket said it drew
    // nine. A draw beyond capacity is now taken in capacity-sized instalments,
    // which costs exactly the wall-clock time the configured rate implies.
    const clock = fakeTime();
    const bucket = new TokenBucket({ capacity: 2, refillPerSec: 2, now: clock.now, sleep: clock.sleep, maxJitterMs: 0 });
    await bucket.acquire(5); // 2 immediate (starts full), then 2 @1000ms, then 1 @500ms
    expect(clock.waits).toEqual([1000, 500]);
  });

  it('a bounded acquire REFUSES rather than parking an interactive request forever', async () => {
    // Every pre-existing caller is a background job and passes no bound. A group
    // send is the first INTERACTIVE one: N queued sends serialise FIFO, so an
    // unbounded wait holds N Express requests open with no ceiling at all (fix
    // wave 2, adversarial 16).
    const clock = fakeTime();
    const bucket = new TokenBucket({ capacity: 1, refillPerSec: 1, now: clock.now, sleep: clock.sleep, maxJitterMs: 0 });
    await bucket.acquire(1); // drains the bucket
    await expect(bucket.acquire(9, { timeoutMs: 2000 })).rejects.toBeInstanceOf(TokenBucketBusyError);
    // It refused INSIDE the bound rather than waiting the nine seconds out.
    expect(clock.waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(2000);
  });

  it('a refusal REPORTS the instalments it already drew, and never claims it spent nothing', async () => {
    // The docstring used to promise "the throughput was never spent" (fix wave
    // 3, conformance 3). At capacity 1 - the shipped default tier - every
    // multi-member send is instalments, and the deadline check sits AFTER the
    // deductions, so a refusal has typically paid for part of the draw.
    const clock = fakeTime();
    const bucket = new TokenBucket({ capacity: 1, refillPerSec: 1, now: clock.now, sleep: clock.sleep, maxJitterMs: 0 });
    const err = await bucket.acquire(9, { timeoutMs: 2000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TokenBucketBusyError);
    const busy = err as TokenBucketBusyError;
    expect(busy.spent).toBeGreaterThan(0);
    expect(busy.message).toContain('not refunded');
    expect(busy.message).not.toContain('nothing drawn');
  });

  it('a bounded acquire that CAN be paid inside the bound still resolves', async () => {
    const clock = fakeTime();
    const bucket = new TokenBucket({ capacity: 2, refillPerSec: 2, now: clock.now, sleep: clock.sleep, maxJitterMs: 0 });
    await bucket.acquire(3, { timeoutMs: 5000 }); // 2 immediate, 1 @500ms
    expect(clock.waits).toEqual([500]);
  });

  it('FIX 6: a fractional rate sizes capacity EXACTLY (not ceil) so the burst stays under the tier', async () => {
    const clock = fakeTime();
    // worker/index size capacity as Math.max(1, a2pRateLimitPerSec). At 2.5/s
    // that is 2.5 — the initial burst admits 2 whole messages immediately, the
    // 3rd must wait. `ceil(2.5)=3` (the OLD code) would have let 3 burst out,
    // exceeding the registered tier — this asserts that can't happen.
    const capacity = Math.max(1, 2.5);
    const bucket = new TokenBucket({ capacity, refillPerSec: 2.5, now: clock.now, sleep: clock.sleep, maxJitterMs: 0 });
    await bucket.acquire(); // immediate (2.5 → 1.5 left)
    await bucket.acquire(); // immediate (1.5 → 0.5 left)
    expect(clock.waits).toEqual([]);
    await bucket.acquire(); // needs 0.5 more token at 2.5/sec → 200ms
    expect(clock.waits).toEqual([200]);
  });

  it('FIX 6: a sub-1/sec rate is floored at capacity 1 so a single message can still go', async () => {
    const clock = fakeTime();
    // Math.max(1, 0.5) === 1: a 0.5/s tier still admits ONE immediate message.
    const capacity = Math.max(1, 0.5);
    expect(capacity).toBe(1);
    const bucket = new TokenBucket({ capacity, refillPerSec: 0.5, now: clock.now, sleep: clock.sleep, maxJitterMs: 0 });
    await bucket.acquire(); // immediate
    expect(clock.waits).toEqual([]);
    await bucket.acquire(); // 1 token at 0.5/sec → 2000ms
    expect(clock.waits).toEqual([2000]);
  });

  // THE DEFECT THESE TWO PIN (fix wave 4, item 4). `timeoutMs` was documented as
  // bounding the TOTAL wait "queue time included" and was implemented as a check
  // AFTER `await prior` - so a request queued behind a long draw sat through the
  // whole of that draw and only then discovered its bound had expired minutes
  // ago. The bound capped the pacing wait; the wait the operator experiences,
  // which is the one it exists to cap, was unbounded.
  it('bounds the wait INCLUDING queue time - a queued send refuses AT the bound, not after the queue', async () => {
    const clock = fakeTime();
    let fireDeadline!: () => void;
    const bucket = new TokenBucket({
      capacity: 1,
      refillPerSec: 1,
      now: clock.now,
      // The predecessor parks mid-pacing and never finishes: that IS the queue an
      // interactive send gets stuck behind.
      sleep: () => new Promise<void>(() => {}),
      maxJitterMs: 0,
      queueTimeout: () =>
        new Promise<void>((resolve) => {
          fireDeadline = resolve;
        }),
    });

    void bucket.acquire(9); // takes the one token, then parks forever
    const queued = bucket.acquire(2, { timeoutMs: 200 });
    fireDeadline();

    const outcome = await Promise.race([
      queued.then(() => 'resolved' as const, (e: unknown) => e),
      new Promise((r) => setTimeout(() => r('still stuck in the queue'), 100)),
    ]);
    expect(outcome).toBeInstanceOf(TokenBucketBusyError);
    // It never reached the front, so it really did spend nothing.
    expect((outcome as TokenBucketBusyError).spent).toBe(0);
  });

  it('a timed-out waiter leaves the queue WITHOUT letting the next one jump the line', async () => {
    const clock = fakeTime();
    let fireDeadline!: () => void;
    const bucket = new TokenBucket({
      capacity: 1,
      refillPerSec: 1,
      now: clock.now,
      sleep: () => new Promise<void>(() => {}),
      maxJitterMs: 0,
      queueTimeout: () =>
        new Promise<void>((resolve) => {
          fireDeadline = resolve;
        }),
    });

    void bucket.acquire(9); // parks forever at the front
    const bounded = bucket.acquire(1, { timeoutMs: 200 });
    let behindRan = false;
    void bucket.acquire(1).then(() => {
      behindRan = true;
    });
    fireDeadline();

    await expect(bounded).rejects.toBeInstanceOf(TokenBucketBusyError);
    // The waiter BEHIND the refusal must still be blocked by the draw that is
    // still draining - releasing the tail eagerly would let it draw against the
    // same budget concurrently, which is the overshoot FIFO exists to prevent.
    await new Promise((r) => setTimeout(r, 20));
    expect(behindRan).toBe(false);
  });

  it('rejects nonsensical construction', () => {
    expect(() => new TokenBucket({ capacity: 0, refillPerSec: 1 })).toThrow();
    expect(() => new TokenBucket({ capacity: 1, refillPerSec: 0 })).toThrow();
  });
});
