import { describe, it, expect } from 'vitest';
import {
  presentDeliveryStatus,
  presentRelayDelivery,
  deliveryReason,
  isQuietSince,
  isStaleLeg,
  canEverGoStale,
  presentLegDelivery,
  STALE_SENT_AFTER_MS,
} from './deliveryStatus.js';
import type { RelayDeliverySlot } from './deliveryStatus.js';

describe('presentDeliveryStatus', () => {
  it('maps each delivery status to label / tone / isFailure', () => {
    expect(presentDeliveryStatus('queued')).toEqual({ label: 'Sending…', tone: 'neutral', isFailure: false });
    expect(presentDeliveryStatus('sent')).toEqual({ label: 'Sent', tone: 'info', isFailure: false });
    expect(presentDeliveryStatus('delivered')).toEqual({ label: 'Delivered', tone: 'success', isFailure: false });
    expect(presentDeliveryStatus('undelivered')).toEqual({ label: 'Undelivered', tone: 'danger', isFailure: true });
    expect(presentDeliveryStatus('failed')).toEqual({ label: 'Failed', tone: 'danger', isFailure: true });
  });

  it('maps queued_pending (connect-when-ready hold) to a neutral "Queued" chip, not a failure', () => {
    expect(presentDeliveryStatus('queued_pending')).toEqual({
      label: 'Queued - will send when connected',
      tone: 'neutral',
      isFailure: false,
    });
  });

  it('returns null for undefined — seed/legacy rows show no chip (not a false "Sending…")', () => {
    expect(presentDeliveryStatus(undefined)).toBeNull();
  });

  it('treats "sent" as a non-failure waypoint (sent ≠ delivered)', () => {
    expect(presentDeliveryStatus('sent')?.isFailure).toBe(false);
    expect(presentDeliveryStatus('delivered')?.isFailure).toBe(false);
  });
});

// The SINGLE clock comparison in this module. `presentDeliveryStatus`'s
// `sent`-only rule and the new per-leg staleness rule are two thin predicates
// over this one comparison - one threshold, no divergent copy.
describe('isQuietSince', () => {
  const Q0 = Date.parse('2026-08-19T21:28:59.000Z');

  it('is inclusive at exactly STALE_SENT_AFTER_MS and exclusive one millisecond under', () => {
    expect(isQuietSince(Q0, Q0 + STALE_SENT_AFTER_MS)).toBe(true);
    expect(isQuietSince(Q0, Q0 + STALE_SENT_AFTER_MS - 1)).toBe(false);
    expect(isQuietSince(Q0, Q0 + STALE_SENT_AFTER_MS * 100)).toBe(true);
  });

  it('is false for a clock that is absent or does not parse, however old the reader thinks it is', () => {
    const forever = Q0 + STALE_SENT_AFTER_MS * 100;
    expect(isQuietSince(undefined, forever)).toBe(false);
    expect(isQuietSince(Number.NaN, forever)).toBe(false);
    expect(isQuietSince(Number.POSITIVE_INFINITY, forever)).toBe(false);
  });
});

// The S3 eligibility table: a leg is STALE when it has a clock that proves the
// LEG ITSELF started and that clock has been quiet for STALE_SENT_AFTER_MS.
//
// | leg status | parseable sentAt | ages from | can go stale |
// | sent       | yes              | sentAt    | yes |
// | sent       | no               | msg.at    | yes |
// | queued     | yes              | sentAt    | yes |
// | queued     | no               | -         | NO  |
// | queued_pending | either       | -         | no  |
// | terminal (delivered/failed/undelivered) | either | - | no |
describe('isStaleLeg / canEverGoStale - the S3 eligibility table', () => {
  const iso = (ms: number): string => new Date(ms).toISOString();
  // A fixed instant to build every clock from; nothing here reads the real clock.
  const L0 = Date.parse('2026-08-19T21:28:59.000Z');
  const NOW = L0 + STALE_SENT_AFTER_MS * 4;
  /** Quiet for four thresholds - stale by any reading. */
  const QUIET_MS = L0;
  const QUIET = iso(QUIET_MS);
  /** One minute old as of NOW - nowhere near the threshold. */
  const FRESH_MS = NOW - 60_000;
  const FRESH = iso(FRESH_MS);
  /** Three weeks before NOW: a connect-when-ready compose time. */
  const ANCIENT_MS = NOW - 21 * 24 * 60 * 60 * 1000;

  it('ages a `sent` leg from its OWN sentAt, not from the message clock', () => {
    // Fresh leg clock, ancient message clock -> NOT stale. This is the released
    // connect-when-ready hold: the message was composed weeks ago, the leg went
    // out a minute ago.
    expect(isStaleLeg({ status: 'sent', sentAt: FRESH }, ANCIENT_MS, NOW)).toBe(false);
    // Quiet leg clock, fresh message clock -> stale. The leg's own clock rules.
    expect(isStaleLeg({ status: 'sent', sentAt: QUIET }, FRESH_MS, NOW)).toBe(true);
  });

  it('ages a `sent` leg with NO sentAt from the message clock - a native group-text leg, whose msg.at IS its send time', () => {
    expect(isStaleLeg({ status: 'sent' }, QUIET_MS, NOW)).toBe(true);
    expect(isStaleLeg({ status: 'sent' }, FRESH_MS, NOW)).toBe(false);
    expect(isStaleLeg({ status: 'sent' }, undefined, NOW)).toBe(false);
  });

  it('falls a `sent` leg with an UNPARSEABLE sentAt to the no-clock row rather than a NaN clock that never ages', () => {
    expect(isStaleLeg({ status: 'sent', sentAt: 'not-a-date' }, QUIET_MS, NOW)).toBe(true);
    expect(isStaleLeg({ status: 'sent', sentAt: '' }, FRESH_MS, NOW)).toBe(false);
  });

  it('ages a `queued` leg from its sentAt when it has one - the fan-out reported queued with a provider timestamp', () => {
    expect(isStaleLeg({ status: 'queued', sentAt: QUIET }, undefined, NOW)).toBe(true);
    expect(isStaleLeg({ status: 'queued', sentAt: FRESH }, ANCIENT_MS, NOW)).toBe(false);
  });

  it('NEVER stales a `queued` leg with no sentAt, however old - a released connect-when-ready hold, and a fan-out that never ran', () => {
    // Both shapes are BYTE-IDENTICAL at the data layer: parent queued, every slot
    // { status: 'queued' }, no sentAt, msg.at arbitrarily old. Silence is the
    // decided answer; a false red on a message about to send trains staff to
    // ignore the cue.
    expect(isStaleLeg({ status: 'queued' }, ANCIENT_MS, NOW)).toBe(false);
    expect(isStaleLeg({ status: 'queued' }, QUIET_MS, NOW)).toBe(false);
    expect(isStaleLeg({ status: 'queued', sentAt: 'not-a-date' }, ANCIENT_MS, NOW)).toBe(false);
  });

  it('never stales a queued_pending hold - it has not been dispatched, so it cannot be overdue', () => {
    expect(isStaleLeg({ status: 'queued_pending' }, ANCIENT_MS, NOW)).toBe(false);
    expect(isStaleLeg({ status: 'queued_pending', sentAt: QUIET }, ANCIENT_MS, NOW)).toBe(false);
  });

  it('never stales a terminal leg - delivered, failed and undelivered are all settled', () => {
    for (const status of ['delivered', 'failed', 'undelivered'] as const) {
      expect(isStaleLeg({ status }, ANCIENT_MS, NOW)).toBe(false);
      expect(isStaleLeg({ status, sentAt: QUIET }, ANCIENT_MS, NOW)).toBe(false);
    }
  });

  it('evaluates staleness ONLY when a clock is supplied - a withheld nowMs is false for every slot, sentAt or not', () => {
    expect(isStaleLeg({ status: 'sent', sentAt: QUIET }, QUIET_MS, undefined)).toBe(false);
    expect(isStaleLeg({ status: 'sent' }, QUIET_MS, undefined)).toBe(false);
    expect(isStaleLeg({ status: 'queued', sentAt: QUIET }, QUIET_MS, undefined)).toBe(false);
  });

  it('K (hard-failed) and J (stale) are DISJOINT - a hard-failed leg is terminal, so it is never also counted not-confirmed', () => {
    for (const status of ['failed', 'undelivered'] as const) {
      expect(isStaleLeg({ status, sentAt: QUIET, errorCode: '30005' }, QUIET_MS, NOW)).toBe(false);
    }
  });

  it('canEverGoStale is true for exactly the three stale-CAPABLE rows of the table', () => {
    expect(canEverGoStale({ status: 'sent', sentAt: FRESH }, ANCIENT_MS, NOW)).toBe(true);
    expect(canEverGoStale({ status: 'sent' }, FRESH_MS, NOW)).toBe(true);
    expect(canEverGoStale({ status: 'queued', sentAt: FRESH }, undefined, NOW)).toBe(true);
    // and stays true once the leg has already crossed the boundary - "can EVER"
    // is about having a clock, not about the answer today.
    expect(canEverGoStale({ status: 'sent', sentAt: QUIET }, undefined, NOW)).toBe(true);
  });

  it('canEverGoStale is false for the rows with no ageing clock, so the ticker never spins on them', () => {
    expect(canEverGoStale({ status: 'queued' }, ANCIENT_MS, NOW)).toBe(false);
    expect(canEverGoStale({ status: 'queued', sentAt: 'not-a-date' }, ANCIENT_MS, NOW)).toBe(false);
    expect(canEverGoStale({ status: 'queued_pending' }, ANCIENT_MS, NOW)).toBe(false);
    expect(canEverGoStale({ status: 'queued_pending', sentAt: FRESH }, ANCIENT_MS, NOW)).toBe(false);
    for (const status of ['delivered', 'failed', 'undelivered'] as const) {
      expect(canEverGoStale({ status, sentAt: FRESH }, ANCIENT_MS, NOW)).toBe(false);
    }
  });

  it('canEverGoStale is false for a NaN message clock - messageInstant returns "" for a non-ISO tsMsgId and Date.parse("") is NaN', () => {
    expect(canEverGoStale({ status: 'sent' }, Number.NaN, NOW)).toBe(false);
    expect(canEverGoStale({ status: 'sent', sentAt: 'not-a-date' }, Number.NaN, NOW)).toBe(false);
    expect(canEverGoStale({ status: 'sent' }, undefined, NOW)).toBe(false);
    // ...and isStaleLeg agrees, so such a leg is neither stale nor ever will be:
    // under a shape test it would be "eligible" for ever and the interval would
    // never terminate.
    expect(isStaleLeg({ status: 'sent' }, Number.NaN, NOW)).toBe(false);
  });

  it('canEverGoStale is false for a WITHHELD clock, so an imported bubble schedules nothing', () => {
    expect(canEverGoStale({ status: 'sent', sentAt: QUIET }, QUIET_MS, undefined)).toBe(false);
    expect(canEverGoStale({ status: 'queued', sentAt: FRESH }, QUIET_MS, undefined)).toBe(false);
    expect(canEverGoStale({ status: 'sent' }, QUIET_MS, undefined)).toBe(false);
  });

  it('canEverGoStale and isStaleLeg agree about WHICH clock a slot uses - they derive it from one helper', () => {
    // A `sent` leg with a fresh sentAt but an ancient message clock is the case
    // that separates them if they ever drift: eligible (it has a clock), not yet
    // stale (that clock is a minute old).
    const slot = { status: 'sent', sentAt: FRESH } as const;
    expect(canEverGoStale(slot, ANCIENT_MS, NOW)).toBe(true);
    expect(isStaleLeg(slot, ANCIENT_MS, NOW)).toBe(false);
    // A `queued` leg with no sentAt is the mirror: never eligible, never stale.
    expect(canEverGoStale({ status: 'queued' }, ANCIENT_MS, NOW)).toBe(false);
    expect(isStaleLeg({ status: 'queued' }, ANCIENT_MS, NOW)).toBe(false);
  });
});

describe('presentRelayDelivery', () => {
  it('counts up in neutral while legs are still in flight', () => {
    expect(
      presentRelayDelivery([{ status: 'delivered' }, { status: 'sent' }]),
    ).toEqual({ label: 'delivered 1/2', tone: 'neutral', isFailure: false });
    expect(
      presentRelayDelivery([{ status: 'queued' }, { status: 'queued' }]),
    ).toEqual({ label: 'delivered 0/2', tone: 'neutral', isFailure: false });
  });

  it('finalizes GREEN — same "Delivered" cue as a 1:1 bubble — when every leg delivered', () => {
    expect(
      presentRelayDelivery([{ status: 'delivered' }, { status: 'delivered' }]),
    ).toEqual({ label: 'Delivered 2/2', tone: 'success', isFailure: false });
  });

  it('turns danger and counts the failures when a leg hard-fails, surfacing the code(s)', () => {
    expect(
      presentRelayDelivery([{ status: 'delivered' }, { status: 'failed', errorCode: '30005' }]),
    ).toEqual({
      label: 'delivered 1/2 - 1 failed',
      tone: 'danger',
      isFailure: true,
      reason: 'Number is invalid (error 30005)',
    });
    // undelivered is a hard failure too; the still-in-flight leg keeps counting.
    // No code on the failed leg → no reason field.
    expect(
      presentRelayDelivery([{ status: 'undelivered' }, { status: 'queued' }]),
    ).toEqual({ label: 'delivered 0/2 - 1 failed', tone: 'danger', isFailure: true });
  });

  it('surfaces the A2P-unregistered code (30034) and dedupes repeated codes across legs', () => {
    // Both intro legs bounce 30034 (the relay-group bug): one reason, not two.
    expect(
      presentRelayDelivery([
        { status: 'undelivered', errorCode: '30034' },
        { status: 'undelivered', errorCode: '30034' },
      ]),
    ).toEqual({
      label: 'delivered 0/2 - 2 failed',
      tone: 'danger',
      isFailure: true,
      reason: 'Number not registered for A2P 10DLC (error 30034)',
    });
  });

  it('joins distinct failure reasons when legs fail for different codes', () => {
    expect(
      presentRelayDelivery([
        { status: 'failed', errorCode: '30005' },
        { status: 'undelivered', errorCode: '30034' },
      ]),
    ).toEqual({
      label: 'delivered 0/2 - 2 failed',
      tone: 'danger',
      isFailure: true,
      reason: 'Number is invalid (error 30005); Number not registered for A2P 10DLC (error 30034)',
    });
  });

  it('excludes opted-out members from the count — the opt-out note explains them, and N/M must stay reachable', () => {
    expect(
      presentRelayDelivery([
        { status: 'delivered' },
        { status: 'delivered' },
        { status: 'failed', errorCode: 'contact_opted_out' },
      ]),
    ).toEqual({ label: 'Delivered 2/2', tone: 'success', isFailure: false });
  });

  it('excludes an UNDELIVERED opted-out leg too - group receipts record 21610 that way', () => {
    // The relay fan-out writes `failed` on a suppressed leg; the group-text
    // receipts path writes what Twilio actually reports for a 21610, which is
    // `undelivered`. Both mean "never really sent", so both must be excluded -
    // otherwise a group text paints an opted-out member as a hard failure while
    // the identical relay leg is quietly excluded.
    expect(
      presentRelayDelivery([
        { status: 'delivered' },
        { status: 'delivered' },
        { status: 'undelivered', errorCode: 'contact_opted_out' },
      ]),
    ).toEqual({ label: 'Delivered 2/2', tone: 'success', isFailure: false });
  });

  it('returns null when there is nothing to summarize (no legs, or everyone opted out)', () => {
    expect(presentRelayDelivery([])).toBeNull();
    expect(
      presentRelayDelivery([{ status: 'failed', errorCode: 'contact_opted_out' }]),
    ).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // The clock-passing half. Every assertion ABOVE this line omits the staleness
  // inputs and is the explicit NO-CLOCK contract; the twins below pass the same
  // slot arrays WITH a clock, because the only production caller always does.
  // ---------------------------------------------------------------------------
  const iso = (ms: number): string => new Date(ms).toISOString();
  const R0 = Date.parse('2026-08-19T21:28:59.000Z');
  const NOW = R0 + STALE_SENT_AFTER_MS * 4;
  /** Quiet for four thresholds. */
  const QUIET = iso(R0);
  /** One minute old as of NOW. */
  const FRESH = iso(NOW - 60_000);
  const MSG_AT = NOW - 60_000;

  it('twin of "counts up in neutral": a quiet `sent` leg turns the SAME array danger once a clock is passed', () => {
    expect(
      presentRelayDelivery([{ status: 'delivered' }, { status: 'sent', sentAt: QUIET }], MSG_AT, NOW),
    ).toEqual({
      label: 'delivered 1/2 - 1 not confirmed',
      tone: 'danger',
      // NOT a failure: no receipt is not proof of failure, and isFailure is what
      // offers a Retry that could double-send.
      isFailure: false,
    });
  });

  it('twin of "counts up in neutral": two `queued` legs escalate ONLY when they carry a sentAt', () => {
    expect(
      presentRelayDelivery(
        [
          { status: 'queued', sentAt: QUIET },
          { status: 'queued', sentAt: QUIET },
        ],
        MSG_AT,
        NOW,
      ),
    ).toEqual({ label: 'delivered 0/2 - 2 not confirmed', tone: 'danger', isFailure: false });
    // Same array, same clock, no sentAt: the released connect-when-ready hold and
    // the fan-out that never ran. Stays neutral for ever, by decision.
    expect(
      presentRelayDelivery(
        [{ status: 'queued' }, { status: 'queued' }],
        NOW - STALE_SENT_AFTER_MS * 1000,
        NOW,
      ),
    ).toEqual({ label: 'delivered 0/2', tone: 'neutral', isFailure: false });
  });

  it('twin of "undelivered is a hard failure too": a failed leg AND a stale leg add up, and the counts stay separate', () => {
    expect(
      presentRelayDelivery(
        [{ status: 'undelivered' }, { status: 'queued', sentAt: QUIET }],
        MSG_AT,
        NOW,
      ),
    ).toEqual({
      label: 'delivered 0/2 - 1 failed, 1 not confirmed',
      tone: 'danger',
      // A real failure exists here, unlike the stale-only branch.
      isFailure: true,
    });
  });

  it('puts the reason LAST and takes it from the FAILED legs only - it belongs to them, not to the unconfirmed ones', () => {
    expect(
      presentRelayDelivery(
        [
          { status: 'failed', errorCode: '30034' },
          { status: 'sent', sentAt: QUIET },
          { status: 'delivered' },
        ],
        MSG_AT,
        NOW,
      ),
    ).toEqual({
      label: 'delivered 1/3 - 1 failed, 1 not confirmed',
      tone: 'danger',
      isFailure: true,
      reason: 'Number not registered for A2P 10DLC (error 30034)',
    });
  });

  it('keeps opted-out members out of the not-confirmed denominator too, exactly as it keeps them out of N/M', () => {
    expect(
      presentRelayDelivery(
        [
          { status: 'delivered' },
          { status: 'sent', sentAt: QUIET },
          { status: 'failed', errorCode: 'contact_opted_out' },
        ],
        MSG_AT,
        NOW,
      ),
    ).toEqual({ label: 'delivered 1/2 - 1 not confirmed', tone: 'danger', isFailure: false });
  });

  it('escalates exactly AT STALE_SENT_AFTER_MS and not one millisecond before', () => {
    const atBoundary = [{ status: 'sent', sentAt: iso(NOW - STALE_SENT_AFTER_MS) }] as const;
    const justUnder = [{ status: 'sent', sentAt: iso(NOW - STALE_SENT_AFTER_MS + 1) }] as const;
    expect(presentRelayDelivery([...atBoundary], MSG_AT, NOW)).toEqual({
      label: 'delivered 0/1 - 1 not confirmed',
      tone: 'danger',
      isFailure: false,
    });
    expect(presentRelayDelivery([...justUnder], MSG_AT, NOW)).toEqual({
      label: 'delivered 0/1',
      tone: 'neutral',
      isFailure: false,
    });
  });

  it('still finalizes GREEN with a clock passed - every leg delivered is terminal, so nothing can be not-confirmed', () => {
    expect(
      presentRelayDelivery(
        [
          { status: 'delivered', deliveredAt: QUIET },
          { status: 'delivered', deliveredAt: QUIET },
        ],
        NOW - STALE_SENT_AFTER_MS * 1000,
        NOW,
      ),
    ).toEqual({ label: 'Delivered 2/2', tone: 'success', isFailure: false });
  });

  it('K (failed) and J (not confirmed) are DISJOINT - a hard-failed leg is never also counted not-confirmed', () => {
    // Both legs failed and both are ancient. If the two counts overlapped this
    // would read "2 failed, 2 not confirmed" and the chip would double-count the
    // whole group.
    expect(
      presentRelayDelivery(
        [
          { status: 'failed', sentAt: QUIET },
          { status: 'undelivered', sentAt: QUIET },
        ],
        NOW - STALE_SENT_AFTER_MS * 1000,
        NOW,
      ),
    ).toEqual({ label: 'delivered 0/2 - 2 failed', tone: 'danger', isFailure: true });
  });

  it('still returns null with a clock passed when there is nothing to summarize', () => {
    expect(presentRelayDelivery([], MSG_AT, NOW)).toBeNull();
    expect(
      presentRelayDelivery(
        [{ status: 'failed', errorCode: 'contact_opted_out', sentAt: QUIET }],
        NOW - STALE_SENT_AFTER_MS * 1000,
        NOW,
      ),
    ).toBeNull();
  });

  it('cannot select the not-confirmed branches at all when the clock is withheld, however quiet the legs are', () => {
    // Plan D-a, total: a caller cannot withhold a per-slot sentAt, so withholding
    // the READING clock is the only complete off switch - and it is what keeps
    // every pre-existing no-clock assertion in this file honest rather than lucky.
    expect(
      presentRelayDelivery([{ status: 'delivered' }, { status: 'sent', sentAt: QUIET }]),
    ).toEqual({ label: 'delivered 1/2', tone: 'neutral', isFailure: false });
    expect(
      presentRelayDelivery([{ status: 'sent', sentAt: QUIET }], NOW - STALE_SENT_AFTER_MS * 1000),
    ).toEqual({ label: 'delivered 0/1', tone: 'neutral', isFailure: false });
    expect(
      presentRelayDelivery([{ status: 'undelivered' }, { status: 'queued', sentAt: QUIET }]),
    ).toEqual({ label: 'delivered 0/2 - 1 failed', tone: 'danger', isFailure: true });
  });

  it('leaves a fresh leg neutral even with a clock - the ordinary in-flight bubble is unchanged', () => {
    expect(
      presentRelayDelivery([{ status: 'delivered' }, { status: 'sent', sentAt: FRESH }], MSG_AT, NOW),
    ).toEqual({ label: 'delivered 1/2', tone: 'neutral', isFailure: false });
  });
});

describe('deliveryReason', () => {
  it('maps known Twilio error codes to human reasons AND always surfaces the code number', () => {
    expect(deliveryReason('30007')).toBe('Carrier filtered the message (error 30007)');
    expect(deliveryReason('21610')).toBe('Recipient has opted out (STOP) (error 21610)');
    expect(deliveryReason('30034')).toBe('Number not registered for A2P 10DLC (error 30034)');
  });

  it('falls back to a generic line that still surfaces the raw code', () => {
    expect(deliveryReason('99999')).toBe('Delivery failed (error 99999)');
  });

  it('returns undefined when there is no code', () => {
    expect(deliveryReason(undefined)).toBeUndefined();
    expect(deliveryReason('')).toBeUndefined();
  });

  // A16 / adversarial 14. When EVERY member of a group has opted out,
  // deriveGroupDeliveryStatus writes the message-level aggregate as
  // { status: 'undelivered', errorCode: 'contact_opted_out' } - and the bubble
  // has no per-leg rollup to fall back on, so this reason IS the chip. The
  // generic branch rendered "Delivery failed (error contact_opted_out)", which
  // dresses a token this app invents as a carrier error number an operator could
  // look up. Staff-facing UI copy, so it lives here beside ERROR_CODE_REASONS,
  // NOT in the app's message catalog (that catalog is member-facing copy).
  it('renders the app-internal opted-out token as operator copy, never as an error number', () => {
    const reason = deliveryReason('contact_opted_out');
    expect(reason).toBe('Everyone here has opted out - nothing was sent');
    expect(reason).not.toMatch(/contact_opted_out/);
    expect(reason).not.toMatch(/error/i);
  });

  // Adversarial 30. Both reason maps are bare object literals, so a code that
  // happens to name an Object.prototype member resolves off the PROTOTYPE. The
  // internal map's early return then hands the caller a FUNCTION where the type
  // says string (the error map was accidentally safe only because its template
  // wrap coerced whatever it found into "function Object() { [native code] }").
  // An error_code is provider/wire data - it is never trusted as a key.
  it('never resolves a delivery reason off Object.prototype', () => {
    for (const code of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
      const reason = deliveryReason(code);
      expect(typeof reason).toBe('string');
      expect(reason).toBe(`Delivery failed (error ${code})`);
    }
  });
});

describe('presentDeliveryStatus - a `sent` that never advanced', () => {
  const T0 = Date.parse('2026-08-19T21:28:59.000Z');

  it('still reads "Sent" while a receipt could plausibly still arrive', () => {
    expect(presentDeliveryStatus('sent', T0, T0 + 60_000)).toEqual({
      label: 'Sent',
      tone: 'info',
      isFailure: false,
    });
  });

  it('stops implying delivery once it has gone quiet', () => {
    expect(presentDeliveryStatus('sent', T0, T0 + STALE_SENT_AFTER_MS)).toEqual({
      label: 'Sent - not confirmed',
      tone: 'danger',
      // NOT a failure: no receipt is not proof of non-delivery, and a Retry here
      // could double-send a message that actually landed.
      isFailure: false,
    });
  });

  it('leaves every OTHER status alone no matter how old', () => {
    const old = T0 + STALE_SENT_AFTER_MS * 100;
    expect(presentDeliveryStatus('delivered', T0, old)?.label).toBe('Delivered');
    expect(presentDeliveryStatus('queued', T0, old)?.label).toBe('Sending…');
    expect(presentDeliveryStatus('failed', T0, old)?.label).toBe('Failed');
  });

  it('behaves exactly as before when no timestamp is supplied', () => {
    expect(presentDeliveryStatus('sent')).toEqual({
      label: 'Sent',
      tone: 'info',
      isFailure: false,
    });
  });

  it('ignores an unparseable timestamp rather than crying stale', () => {
    // Date.parse of a malformed `at` yields NaN.
    expect(presentDeliveryStatus('sent', Number.NaN, T0)?.label).toBe('Sent');
  });
});

describe('presentLegDelivery - one recipient row', () => {
  const iso = (ms: number): string => new Date(ms).toISOString();
  const P0 = Date.parse('2026-08-19T21:28:59.000Z');
  const NOW = P0 + STALE_SENT_AFTER_MS * 4;
  const QUIET = iso(P0);
  const MSG_AT = NOW - 60_000;
  // The queued label ships with a U+2026 ellipsis. Written as an escape so this
  // source line stays ASCII while still evaluating to the real shipped string -
  // and NOT as presentDeliveryStatus('queued'), which would be an assertion that
  // the delegate returns what the delegate returns and would pass even if the
  // delegation broke.
  const SENDING = 'Sending\u2026';

  it('delegates every ordinary status to the 1:1 presenter, so a leg and a 1:1 message never disagree', () => {
    expect(presentLegDelivery({ status: 'queued' }, 'relay', MSG_AT, NOW)).toEqual({
      label: SENDING,
      tone: 'neutral',
      isFailure: false,
    });
    expect(presentLegDelivery({ status: 'queued_pending' }, 'relay', MSG_AT, NOW)).toEqual({
      label: 'Queued - will send when connected',
      tone: 'neutral',
      isFailure: false,
    });
    expect(presentLegDelivery({ status: 'sent' }, 'relay', MSG_AT, NOW)).toEqual({
      label: 'Sent',
      tone: 'info',
      isFailure: false,
    });
    expect(presentLegDelivery({ status: 'delivered', deliveredAt: QUIET }, 'relay', MSG_AT, NOW)).toEqual({
      label: 'Delivered',
      tone: 'success',
      isFailure: false,
    });
    expect(presentLegDelivery({ status: 'failed', errorCode: '30005' }, 'relay', MSG_AT, NOW)).toEqual({
      label: 'Failed',
      tone: 'danger',
      isFailure: true,
    });
    expect(presentLegDelivery({ status: 'undelivered' }, 'group_text', MSG_AT, NOW)).toEqual({
      label: 'Undelivered',
      tone: 'danger',
      isFailure: true,
    });
  });

  // THE regression this function exists to avoid. `presentDeliveryStatus`'s
  // `nowMs` is a DEFAULTED parameter, so its opt-out is withholding the
  // TIMESTAMP - which means delegating as
  // `presentDeliveryStatus(slot.status, messageAtMs, nowMs)` would age a `sent`
  // leg from the MESSAGE clock and paint this row red. Reachable in production:
  // a connect-when-ready hold waits days for its number to warm, so msg.at is
  // arbitrarily old while the leg itself went out seconds ago.
  it('reads a plain "Sent" on a released connect-when-ready hold - a fresh leg under a three-week-old message', () => {
    const now = Date.now();
    const threeWeeksAgo = now - 21 * 24 * 60 * 60 * 1000;
    expect(
      presentLegDelivery(
        { status: 'sent', sentAt: iso(now - 60_000) },
        'relay',
        threeWeeksAgo,
        now,
      ),
    ).toEqual({ label: 'Sent', tone: 'info', isFailure: false });
  });

  it('reads a plain "Sent" on the DISABLED path too - a withheld clock never ages anything', () => {
    // Same delegation call shape as the enabled path, so there is exactly one
    // way this function can reach the 1:1 presenter.
    expect(presentLegDelivery({ status: 'sent', sentAt: QUIET }, 'relay')).toEqual({
      label: 'Sent',
      tone: 'info',
      isFailure: false,
    });
    expect(
      presentLegDelivery({ status: 'sent', sentAt: QUIET }, 'relay', NOW - STALE_SENT_AFTER_MS * 1000),
    ).toEqual({ label: 'Sent', tone: 'info', isFailure: false });
    expect(presentLegDelivery({ status: 'queued', sentAt: QUIET }, 'relay')).toEqual({
      label: SENDING,
      tone: 'neutral',
      isFailure: false,
    });
  });

  it('renders its OWN stale label for a quiet `sent` leg, matching STALE_SENT_PRESENTATION', () => {
    expect(presentLegDelivery({ status: 'sent', sentAt: QUIET }, 'relay', MSG_AT, NOW)).toEqual({
      label: 'Sent - not confirmed',
      tone: 'danger',
      isFailure: false,
    });
  });

  it('renders a DIFFERENT stale label for a quiet `queued` leg - the 1:1 rule is sent-only and will not produce one', () => {
    expect(presentLegDelivery({ status: 'queued', sentAt: QUIET }, 'relay', MSG_AT, NOW)).toEqual({
      label: 'Queued - not confirmed',
      tone: 'danger',
      isFailure: false,
    });
  });

  it('never says "Sent - not confirmed" on a leg the provider never reported sent - the two stale strings must differ', () => {
    const sentLeg = presentLegDelivery({ status: 'sent', sentAt: QUIET }, 'relay', MSG_AT, NOW);
    const queuedLeg = presentLegDelivery({ status: 'queued', sentAt: QUIET }, 'relay', MSG_AT, NOW);
    expect(queuedLeg?.label).not.toBe(sentLeg?.label);
    expect(queuedLeg?.label).not.toMatch(/^Sent/);
  });

  it('never stales a `queued` leg with no sentAt, so a released hold and a dead fan-out stay quiet on the row too', () => {
    expect(
      presentLegDelivery({ status: 'queued' }, 'relay', NOW - STALE_SENT_AFTER_MS * 1000, NOW),
    ).toEqual({ label: SENDING, tone: 'neutral', isFailure: false });
  });

  it('labels an opted-out RELAY leg as not sent - the app itself declined to send', () => {
    expect(
      presentLegDelivery({ status: 'failed', errorCode: 'contact_opted_out' }, 'relay', MSG_AT, NOW),
    ).toEqual({ label: 'Not sent - opted out', tone: 'neutral', isFailure: false });
  });

  it('labels an opted-out GROUP TEXT leg product-awarely - there Twilio skips the participant', () => {
    // The group receipts path records what Twilio reports for a 21610, which is
    // `undelivered`; the relay fan-out records `failed`. The CODE alone
    // identifies the row, exactly as it does in the rollup's denominator filter.
    expect(
      presentLegDelivery(
        { status: 'undelivered', errorCode: 'contact_opted_out' },
        'group_text',
        MSG_AT,
        NOW,
      ),
    ).toEqual({
      label: 'Not sent - opted out (Twilio skips them)',
      tone: 'neutral',
      isFailure: false,
    });
    // Same slot on the other product reads the other way round.
    expect(
      presentLegDelivery(
        { status: 'undelivered', errorCode: 'contact_opted_out' },
        'relay',
        MSG_AT,
        NOW,
      )?.label,
    ).toBe('Not sent - opted out');
  });

  it('never puts the message-level AGGREGATE opt-out copy on a single row', () => {
    // deliveryReason maps contact_opted_out to "Everyone here has opted out -
    // nothing was sent". That copy was written for the whole-message chip; on the
    // row of the one member in five who opted out it is a fresh instance of the
    // misread this feature exists to kill. It also must not read as a failure,
    // because the bubble only renders a reason when the row isFailure.
    for (const kind of ['relay', 'group_text'] as const) {
      const row = presentLegDelivery(
        { status: 'failed', errorCode: 'contact_opted_out' },
        kind,
        MSG_AT,
        NOW,
      );
      expect(row?.label).not.toMatch(/Everyone here/);
      expect(row?.isFailure).toBe(false);
    }
  });

  it('does not treat a transient carrier code on a still-retrying `queued` leg as a failure', () => {
    // relayFanOut writes { status: 'queued', errorCode: <transient code> } while
    // it retries. An errorCode does NOT imply failure, and printing a carrier
    // code beside a leg that is still going would be its own misread - the row
    // renders a reason only when its own presentation isFailure.
    expect(presentLegDelivery({ status: 'queued', errorCode: '30003' }, 'relay', MSG_AT, NOW)).toEqual({
      label: SENDING,
      tone: 'neutral',
      isFailure: false,
    });
  });

  it('returns null for an unrecognised status - the row shows a name and NO state chip, never an invented one', () => {
    const offWire = { status: 'gremlin' } as unknown as RelayDeliverySlot;
    expect(presentLegDelivery(offWire, 'relay', MSG_AT, NOW)).toBeNull();
  });
});
