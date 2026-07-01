// backfillConsentMethod — unit tests for the PURE planning function (the DB
// scan/write loop is exercised by hand against DynamoDB Local; here we pin the
// spec §2 mapping so the one-time backfill can't misclassify consent).
import { describe, it, expect } from 'vitest';
import { planConsentBackfill } from '../scripts/backfillConsentMethod.js';

describe('planConsentBackfill (spec §2)', () => {
  it('inbound_sms → inbound_text, consent_at from captured_at', () => {
    const plan = planConsentBackfill({
      capture_source: 'inbound_sms',
      captured_at: '2026-01-02T03:04:05.000Z',
    });
    expect(plan).toEqual({
      consent_method: 'inbound_text',
      consent_at: '2026-01-02T03:04:05.000Z',
    });
    // inbound_text is not a form method → no consent_version.
    expect(plan?.consent_version).toBeUndefined();
  });

  it('housing_fair → web_form + consent_version', () => {
    const plan = planConsentBackfill({
      capture_source: 'housing_fair',
      captured_at: '2026-01-02T03:04:05.000Z',
    });
    expect(plan).toEqual({
      consent_method: 'web_form',
      consent_at: '2026-01-02T03:04:05.000Z',
      consent_version: 'ctia-2026-06',
    });
  });

  it('flyer → web_form + consent_version', () => {
    const plan = planConsentBackfill({ capture_source: 'flyer', created_at: '2026-05-05T00:00:00.000Z' });
    expect(plan?.consent_method).toBe('web_form');
    expect(plan?.consent_version).toBe('ctia-2026-06');
    // captured_at absent → falls back to created_at.
    expect(plan?.consent_at).toBe('2026-05-05T00:00:00.000Z');
  });

  it('falls back captured_at → created_at → now', () => {
    const plan = planConsentBackfill({ capture_source: 'inbound_sms' });
    expect(plan?.consent_at).toBeTypeOf('string');
    expect(plan?.consent_at.length).toBeGreaterThan(0);
  });

  it('is idempotent: skips a contact that already has consent_method', () => {
    expect(
      planConsentBackfill({ consent_method: 'verbal_phone', capture_source: 'inbound_sms' }),
    ).toBeNull();
  });

  it('skips a contact whose capture_source implies no method', () => {
    expect(planConsentBackfill({ capture_source: 'manual' })).toBeNull();
    expect(planConsentBackfill({})).toBeNull();
  });
});
