// Pure broadcast-helper tests — labels, merge-token preview, recipient resolution.
import { describe, expect, it } from 'vitest';
import type { UnitItem } from '../../api';
import {
  broadcastStatusLabel,
  broadcastStatusTone,
  defaultShareTemplate,
  recipientDeliveryStatus,
  recipientLabel,
  unitTokenPreview,
} from './broadcast';

function unit(over: Partial<UnitItem> = {}): UnitItem {
  return {
    unitId: 'u1',
    landlordId: 'k1',
    status: 'available',
    beds: 2,
    rent_min: 1200,
    rent_max: 1500,
    address: '123 Main St',
    ...over,
  };
}

describe('defaultShareTemplate', () => {
  it('ends with the flyer-link token so the flyer is appended by default', () => {
    expect(defaultShareTemplate(unit())).toMatch(/\[FlyerLink\]$/);
  });
  it('mentions the bedroom count when known', () => {
    expect(defaultShareTemplate(unit({ beds: 3 }))).toContain('3-bedroom');
  });
  it('omits the bedroom phrase when beds is unknown', () => {
    expect(defaultShareTemplate(unit({ beds: undefined }))).not.toContain('-bedroom');
  });
});

describe('unitTokenPreview', () => {
  it('resolves beds/address/rent from the unit', () => {
    expect(unitTokenPreview(unit())).toEqual({
      beds: '2',
      address: '123 Main St',
      rent: '$1,200–$1,500',
    });
  });
  it('returns empty strings for unknown values (never fabricated)', () => {
    expect(unitTokenPreview(undefined)).toEqual({ beds: '', address: '', rent: '' });
  });
});

describe('recipientLabel', () => {
  it('formats a phone# key as a phone number (honest fallback)', () => {
    expect(recipientLabel('phone#+13135551234', new Map())).toBe('(313) 555-1234');
  });
  it('uses a resolved name when available for a contactId key', () => {
    expect(recipientLabel('c-1', new Map([['c-1', 'Alice']]))).toBe('Alice');
  });
  it('falls back to a contact id stub when the name is unknown (never fabricated)', () => {
    expect(recipientLabel('c-abcdef1234', new Map())).toBe('Contact c-abcdef');
  });
});

describe('recipientDeliveryStatus', () => {
  it('maps send/delivery states 1:1 to the shared DeliveryStatus', () => {
    expect(recipientDeliveryStatus('queued')).toBe('queued');
    expect(recipientDeliveryStatus('sent')).toBe('sent');
    expect(recipientDeliveryStatus('delivered')).toBe('delivered');
    expect(recipientDeliveryStatus('failed')).toBe('failed');
  });
  it('returns undefined for skipped (never sent — no delivery peer)', () => {
    expect(recipientDeliveryStatus('skipped')).toBeUndefined();
  });
});

describe('broadcast status presentation', () => {
  it('labels each lifecycle status', () => {
    expect(broadcastStatusLabel('draft')).toBe('Draft');
    expect(broadcastStatusLabel('sending')).toBe('Sending');
    expect(broadcastStatusLabel('sent')).toBe('Sent');
    expect(broadcastStatusLabel('failed')).toBe('Failed');
  });
  it('tones sent as success and failed as danger', () => {
    expect(broadcastStatusTone('sent')).toBe('success');
    expect(broadcastStatusTone('failed')).toBe('danger');
  });
});
