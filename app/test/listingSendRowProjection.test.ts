// toListingSendRow(item, opts) - the pure serializer both GET projections and
// the outcome route share (last-heard-from spec 5.4; plan 3.6). The options
// object replaced the positional signature.
import { describe, expect, it } from 'vitest';
import { toListingSendRow, type ListingSendItem } from '../src/repos/listingSendsRepo.js';

const ITEM: ListingSendItem = {
  unitId: 'unit-1',
  contactId: 'c-1',
  sentAt: '2026-06-16T10:00:00.000Z',
  via: 'broadcast',
  broadcastId: 'b-1',
  created_at: 'x',
  updated_at: 'x',
  declined: { at: '2026-06-17T10:00:00.000Z', by: 'staff', staffId: 'usr_x' },
};

describe('toListingSendRow(item, opts)', () => {
  it('serializes the options object; drops furniture and the stored decline unless passed', () => {
    expect(toListingSendRow(ITEM, { outcome: 'replied', interestedSupported: true })).toEqual({
      contactId: 'c-1',
      unitId: 'unit-1',
      sentAt: '2026-06-16T10:00:00.000Z',
      via: 'broadcast',
      broadcastId: 'b-1',
      outcome: 'replied',
      interestedSupported: true,
    });
  });
  it('carries every optional field when given; declined never carries staffId; recipientMissing only when true', () => {
    const row = toListingSendRow(ITEM, {
      tour: { tourId: 't-1', state: 'requested' },
      tenantName: 'Tia Moss',
      facts: { type: 'tenant' },
      outcome: 'not_interested',
      lastHeardFromAt: '2026-06-18T10:00:00.000Z',
      declined: { at: '2026-06-17T10:00:00.000Z', by: 'staff' },
      interestedSupported: true,
      interestedMode: 'route',
      eligible: false,
      recipientMissing: false,
    });
    expect(row).toEqual({
      contactId: 'c-1',
      tenantName: 'Tia Moss',
      unitId: 'unit-1',
      sentAt: '2026-06-16T10:00:00.000Z',
      via: 'broadcast',
      broadcastId: 'b-1',
      tour: { tourId: 't-1', state: 'requested' },
      type: 'tenant',
      lastHeardFromAt: '2026-06-18T10:00:00.000Z',
      outcome: 'not_interested',
      declined: { at: '2026-06-17T10:00:00.000Z', by: 'staff' },
      interestedSupported: true,
      interestedMode: 'route',
      eligible: false,
    });
  });
  it('(PIN) an uncounted row without sentAt is never projected', () => {
    const { sentAt: _drop, ...noSent } = ITEM;
    expect(() => toListingSendRow(noSent as ListingSendItem, { outcome: 'no_reply', interestedSupported: true })).toThrow(/has no sentAt/);
  });
});
