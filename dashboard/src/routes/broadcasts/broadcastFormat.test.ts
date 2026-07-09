// Smoke tests for the pure Broadcasts presentation helpers — the load-bearing
// logic the QA agent will lean on (audience summary, contactKey split, recipient
// flattening + failures-first ordering, status tone). Pure functions, no DOM.
import { describe, expect, it } from 'vitest';
import type { BroadcastRecipient } from '../../api/index.js';
import {
  audienceSummary,
  splitContactKey,
  toRecipientViews,
  voucherSizeLabel,
  presentRecipientStatus,
} from './broadcastFormat.js';

describe('voucherSizeLabel', () => {
  it('maps sizes to chip labels (0 → Studio, 4+ caps)', () => {
    expect(voucherSizeLabel(0)).toBe('Studio');
    expect(voucherSizeLabel(2)).toBe('2-BR');
    expect(voucherSizeLabel(4)).toBe('4+ BR');
    expect(voucherSizeLabel(7)).toBe('4+ BR');
  });
});

describe('audienceSummary', () => {
  it('leads with Tenants and appends size + authority when set', () => {
    expect(audienceSummary({ contact_type: 'tenant' })).toBe('Tenants');
    expect(
      audienceSummary({ contact_type: 'tenant', bedroomSize: 2, housing_authority: 'Atlanta' }),
    ).toBe('Tenants - 2-BR - Atlanta');
  });
});

describe('splitContactKey', () => {
  it('splits a contactId vs a phone# key', () => {
    expect(splitContactKey('c123')).toEqual({ contactId: 'c123' });
    expect(splitContactKey('phone#+14040000007')).toEqual({ phone: '+14040000007' });
  });
});

describe('toRecipientViews', () => {
  it('flattens the map and sorts failures first', () => {
    const recipients: Record<string, BroadcastRecipient> = {
      c1: { status: 'delivered' },
      'phone#+14040000007': { status: 'failed', errorCode: '30003' },
      c3: { status: 'queued' },
    };
    const views = toRecipientViews(recipients);
    expect(views[0]?.status).toBe('failed');
    expect(views[0]?.phone).toBe('+14040000007');
    expect(views[0]?.errorCode).toBe('30003');
    // The non-failed rows keep their relative order after the failure.
    expect(views.map((v) => v.contactKey)).toContain('c1');
    expect(views.map((v) => v.contactKey)).toContain('c3');
  });

  it('composes the row name from the server firstName/lastName', () => {
    const views = toRecipientViews({
      c1: { status: 'delivered', firstName: 'Jane', lastName: 'Doe', phone: '+14040000007' },
    });
    expect(views[0]?.name).toBe('Jane Doe');
    // The server-provided phone rides along for the secondary line.
    expect(views[0]?.phone).toBe('+14040000007');
    expect(views[0]?.contactId).toBe('c1');
  });

  it('prefers the server-provided phone over the phone# key', () => {
    const views = toRecipientViews({
      'phone#+14040000001': { status: 'sent', phone: '+14040000007' },
    });
    expect(views[0]?.phone).toBe('+14040000007');
  });

  it('falls back to the phone# key when the server omits a phone', () => {
    const views = toRecipientViews({
      'phone#+14040000007': { status: 'sent' },
    });
    expect(views[0]?.phone).toBe('+14040000007');
    // No name resolvable -> the view carries no composed name (row shows phone).
    expect(views[0]?.name).toBeUndefined();
  });

  it('leaves name undefined for a deleted contact (no name, no phone)', () => {
    const views = toRecipientViews({ c9: { status: 'queued' } });
    expect(views[0]?.name).toBeUndefined();
    expect(views[0]?.phone).toBeUndefined();
    expect(views[0]?.contactId).toBe('c9');
  });
});

describe('presentRecipientStatus', () => {
  it('maps statuses onto the delivery model + handles skipped', () => {
    expect(presentRecipientStatus('delivered').tone).toBe('success');
    expect(presentRecipientStatus('failed').isFailure).toBe(true);
    expect(presentRecipientStatus('skipped').label).toBe('Skipped');
  });
});
