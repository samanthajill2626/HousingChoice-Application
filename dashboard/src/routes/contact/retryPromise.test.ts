// The screen's retry promise (retry-send-window D8, D10): live from before the
// retry is due until RETRY_PROMISE_GRACE_MS after it, on the SERVER's clock -
// never from a missing, unparseable or withdrawn stamp.
import { describe, expect, it } from 'vitest';
import { isRetryPromiseLive, RETRY_PROMISE_GRACE_MS } from './retryPromise.js';

const DUE = '2026-09-25T20:42:00.000Z';
const DUE_MS = Date.parse(DUE);

describe('isRetryPromiseLive', () => {
  it('is live before and after the retry is due, until the grace runs out - exclusive at the edge', () => {
    expect(isRetryPromiseLive(DUE, DUE_MS - 60_000)).toBe(true);
    expect(isRetryPromiseLive(DUE, DUE_MS)).toBe(true);
    expect(isRetryPromiseLive(DUE, DUE_MS + RETRY_PROMISE_GRACE_MS - 1)).toBe(true);
    expect(isRetryPromiseLive(DUE, DUE_MS + RETRY_PROMISE_GRACE_MS)).toBe(false);
    expect(isRetryPromiseLive(DUE, DUE_MS + 24 * 60 * 60 * 1000)).toBe(false);
  });

  it('grants two minutes of grace', () => {
    expect(RETRY_PROMISE_GRACE_MS).toBe(2 * 60 * 1000);
  });

  it('is never live without a parseable stamp', () => {
    expect(isRetryPromiseLive(undefined, DUE_MS)).toBe(false);
    expect(isRetryPromiseLive('', DUE_MS)).toBe(false);
    expect(isRetryPromiseLive('not a time', DUE_MS)).toBe(false);
  });

  it('reads the WITHDRAWN stamp - the epoch a failed enqueue writes (D7) - as long expired', () => {
    expect(isRetryPromiseLive('1970-01-01T00:00:00.000Z', DUE_MS)).toBe(false);
  });
});
