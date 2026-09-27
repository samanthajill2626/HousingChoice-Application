// Cross-workspace RELAY WINDOW-CLOSE CODE MIRROR DRIFT GUARD (retry-send-window
// D8; build review A6).
//
// app/src/lib/retrySendWindow.ts owns RETRY_WINDOW_CLOSED_CODE, the close a
// WINDOW decline writes on a relay retry rung (the claim, D3, or the job, D4).
// The dashboard cannot import app code at runtime, so it HAND-COPIES the value
// twice: relayRetryJoin.ts's WINDOW_CLOSED_CODE, which the join treats as
// carrying NO display code so the leg keeps its original 30003 (the ruling: a
// declined late retry reads as a plain failed attempt), and the key of the
// "Not retried - message too old" fallback in deliveryStatus.ts's
// INTERNAL_CODE_REASONS. If the app value moved and a copy did not, the join
// would stop recognizing the close and the leg would read the fallback prose
// where the ruling wants the plain 30003 - and no other test would see it.
//
// MECHANISM and DIRECTION: the same as retryPromiseMirror.test.ts - import both
// sides and compare RESOLVED values, from the dashboard side.
import { describe, expect, it } from 'vitest';
import { RETRY_WINDOW_CLOSED_CODE as APP_RETRY_WINDOW_CLOSED_CODE } from '../../../../app/src/lib/retrySendWindow.js';
import { deliveryReason } from './deliveryStatus.js';
import { WINDOW_CLOSED_CODE } from './relayRetryJoin.js';

const FALLBACK_COPY = 'Not retried - message too old';

describe('dashboard relay window-close code mirrors app/src/lib/retrySendWindow.ts', () => {
  it('the join treats the SAME value as the app writes', () => {
    expect(WINDOW_CLOSED_CODE).toBe(APP_RETRY_WINDOW_CLOSED_CODE);
  });

  it('the no-tail fallback copy is keyed on the APP value', () => {
    expect(deliveryReason(APP_RETRY_WINDOW_CLOSED_CODE)).toBe(FALLBACK_COPY);
  });

  it('does not compare two vacuous values', () => {
    // The floor that stops the assertions above passing if an import ever
    // resolves to nothing, or the fallback answers every code alike.
    expect(typeof APP_RETRY_WINDOW_CLOSED_CODE).toBe('string');
    expect(APP_RETRY_WINDOW_CLOSED_CODE.length).toBeGreaterThan(0);
    expect(deliveryReason(`${APP_RETRY_WINDOW_CLOSED_CODE}_other`)).not.toBe(FALLBACK_COPY);
  });
});
