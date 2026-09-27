// Cross-workspace RETRY-PROMISE MIRROR DRIFT GUARD (retry-send-window D10).
//
// dashboard/src/routes/contact/retryPromise.ts HAND-COPIES the promise's grace
// from app/src/lib/retrySendWindow.ts: the dashboard is a separate package and
// cannot import app code at runtime. The two copies answer ONE question - is an
// automatic retry of this message still scheduled? - on the two sides of a 409:
// the screen hides the Retry button while its answer is yes, and the manual
// Retry route refuses with `retry_pending` while the server's answer is yes. If
// they drift, a shorter screen grace offers a Retry the server refuses, and a
// longer one hides a Retry the server would accept.
//
// MECHANISM and DIRECTION: the same as mediaTypeMirror.test.ts - import both
// copies and compare RESOLVED values and answers, from the dashboard side,
// because the app module is a near-leaf and the app's test tsconfig has no
// `jsx` option to take the traffic the other way.
import { describe, expect, it } from 'vitest';
import {
  isRetryPromiseLive as appIsRetryPromiseLive,
  RETRY_PROMISE_GRACE_MS as APP_RETRY_PROMISE_GRACE_MS,
  RETRY_PROMISE_WITHDRAWN_AT,
} from '../../../../app/src/lib/retrySendWindow.js';
import { isRetryPromiseLive, RETRY_PROMISE_GRACE_MS } from './retryPromise.js';

const DUE = '2026-09-25T20:42:00.000Z';
const DUE_MS = Date.parse(DUE);

/** One table, both predicates: [stamp, reading clock]. */
const CASES: Array<[string | undefined, number]> = [
  [DUE, DUE_MS - 60_000],
  [DUE, DUE_MS],
  [DUE, DUE_MS + APP_RETRY_PROMISE_GRACE_MS - 1],
  [DUE, DUE_MS + APP_RETRY_PROMISE_GRACE_MS],
  [DUE, DUE_MS + 24 * 60 * 60 * 1000],
  [undefined, DUE_MS],
  ['', DUE_MS],
  ['not a time', DUE_MS],
  [RETRY_PROMISE_WITHDRAWN_AT, DUE_MS],
];

describe('dashboard retry promise mirrors app/src/lib/retrySendWindow.ts', () => {
  it('the grace is the SAME value on both sides', () => {
    expect(RETRY_PROMISE_GRACE_MS).toBe(APP_RETRY_PROMISE_GRACE_MS);
  });

  it('the screen and the 409 guard give the SAME answer for every case', () => {
    for (const [stamp, nowMs] of CASES) {
      expect(isRetryPromiseLive(stamp, nowMs), `${String(stamp)} read at ${String(nowMs)}`).toBe(
        appIsRetryPromiseLive(stamp, nowMs),
      );
    }
  });

  it('does not compare two vacuous answers', () => {
    // The floor that stops the assertions above passing if an import ever
    // resolves to nothing, or every case collapses to one answer.
    expect(APP_RETRY_PROMISE_GRACE_MS).toBeGreaterThan(0);
    const answers = CASES.map(([stamp, nowMs]) => appIsRetryPromiseLive(stamp, nowMs));
    expect(answers).toContain(true);
    expect(answers).toContain(false);
  });
});
