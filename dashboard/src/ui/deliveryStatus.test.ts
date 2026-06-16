import { describe, expect, it } from 'vitest';
import { deliveryReason, presentDeliveryStatus } from './deliveryStatus.js';
import type { DeliveryStatus } from '../api/types.js';

describe('presentDeliveryStatus', () => {
  it('maps every delivery status to a label + tone', () => {
    const statuses: DeliveryStatus[] = ['queued', 'sent', 'delivered', 'undelivered', 'failed'];
    for (const status of statuses) {
      const p = presentDeliveryStatus(status);
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.tone.length).toBeGreaterThan(0);
    }
  });

  it('treats "sent" as a non-failure waypoint (sent ≠ delivered)', () => {
    const sent = presentDeliveryStatus('sent');
    const delivered = presentDeliveryStatus('delivered');
    expect(sent.isFailure).toBe(false);
    expect(sent.label).toBe('Sent');
    expect(delivered.label).toBe('Delivered');
    expect(delivered.tone).toBe('success');
    expect(sent.tone).not.toBe('success'); // visually distinct from delivered
  });

  it('flags undelivered + failed as failures', () => {
    expect(presentDeliveryStatus('undelivered').isFailure).toBe(true);
    expect(presentDeliveryStatus('failed').isFailure).toBe(true);
    expect(presentDeliveryStatus('queued').isFailure).toBe(false);
  });

  it('never returns undefined for a missing/unknown status (defensive — older or seed messages may carry no delivery_status)', () => {
    // The persisted `delivery_status` is in practice optional: seed data and any
    // message stored before the status machine ran omit it, so the field arrives
    // `undefined` (or, defensively, an unrecognized string). MessageBubble
    // destructures `{ isFailure }` from this for EVERY message, so a missing
    // status must yield a safe, non-failure presentation — never `undefined`
    // (which previously threw and unmounted the whole thread view).
    for (const bad of [undefined, '', 'received', 'accepted', 'bogus']) {
      const p = presentDeliveryStatus(bad as unknown as DeliveryStatus);
      expect(p).toBeDefined();
      expect(typeof p.label).toBe('string');
      expect(p.tone.length).toBeGreaterThan(0);
      expect(p.isFailure).toBe(false); // an unknown status is not a known failure
    }
  });
});

describe('deliveryReason (error_code → human reason)', () => {
  it('maps the §7.1 codes to specific reasons', () => {
    expect(deliveryReason('30003')).toMatch(/unreachable/i);
    expect(deliveryReason('30005')).toMatch(/invalid/i);
    expect(deliveryReason('30006')).toMatch(/landline/i);
    expect(deliveryReason('30007')).toMatch(/filtered/i);
    expect(deliveryReason('21610')).toMatch(/opted out/i);
  });

  it('falls back to a generic reason that surfaces the raw code', () => {
    const reason = deliveryReason('99999');
    expect(reason).toBeDefined();
    expect(reason).toContain('99999');
  });

  it('returns undefined when there is no error code', () => {
    expect(deliveryReason(undefined)).toBeUndefined();
    expect(deliveryReason('')).toBeUndefined();
  });
});
