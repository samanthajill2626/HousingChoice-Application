import { describe, it, expect } from 'vitest';
import { presentDeliveryStatus, presentRelayDelivery, deliveryReason } from './deliveryStatus.js';

describe('presentDeliveryStatus', () => {
  it('maps each delivery status to label / tone / isFailure', () => {
    expect(presentDeliveryStatus('queued')).toEqual({ label: 'Sending…', tone: 'neutral', isFailure: false });
    expect(presentDeliveryStatus('sent')).toEqual({ label: 'Sent', tone: 'info', isFailure: false });
    expect(presentDeliveryStatus('delivered')).toEqual({ label: 'Delivered', tone: 'success', isFailure: false });
    expect(presentDeliveryStatus('undelivered')).toEqual({ label: 'Undelivered', tone: 'danger', isFailure: true });
    expect(presentDeliveryStatus('failed')).toEqual({ label: 'Failed', tone: 'danger', isFailure: true });
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
    // Both intro legs bounce 30034 (the group-text bug): one reason, not two.
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
});
