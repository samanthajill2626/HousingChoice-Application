import { describe, it, expect } from 'vitest';
import {
  presentDeliveryStatus,
  presentRelayDelivery,
  deliveryReason,
  STALE_SENT_AFTER_MS,
} from './deliveryStatus.js';

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
