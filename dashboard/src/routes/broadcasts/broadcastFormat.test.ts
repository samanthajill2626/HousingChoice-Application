// Smoke tests for the pure Broadcasts presentation helpers — the load-bearing
// logic the QA agent will lean on (audience summary, contactKey split, recipient
// flattening + failures-first ordering, status tone). Pure functions, no DOM.
import { describe, expect, it } from 'vitest';
import type { BroadcastRecipient, BroadcastStats } from '../../api/index.js';
import {
  audienceSummary,
  sendReachLabel,
  splitContactKey,
  toRecipientViews,
  voucherSizeLabel,
  presentRecipientStatus,
  shareRecipientReason,
  presentShareLabel,
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

describe('sendReachLabel', () => {
  it('pluralizes tenant/tenants by count', () => {
    expect(sendReachLabel(1)).toBe('To 1 tenant');
    expect(sendReachLabel(0)).toBe('To 0 tenants');
    expect(sendReachLabel(5)).toBe('To 5 tenants');
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

  it("a status-'sent' slot is 'Sending…' until carrierSentAt lands, then 'Sent'", () => {
    // Dispatched-but-carrier-unconfirmed must read exactly like the same
    // message's 1:1 bubble (still at queued/"Sending…") - the two surfaces may
    // never disagree about one message at one instant.
    const dispatched = presentRecipientStatus('sent');
    expect(dispatched.label).toBe('Sending…');
    expect(dispatched.tone).toBe('neutral');
    expect(dispatched.isFailure).toBe(false);

    const confirmed = presentRecipientStatus('sent', '2026-07-16T00:00:01.000Z');
    expect(confirmed.label).toBe('Sent');
    expect(confirmed.tone).toBe('info');
  });

  it('toRecipientViews carries carrierSentAt through to the row', () => {
    const views = toRecipientViews({
      'c-1': { status: 'sent', carrierSentAt: '2026-07-16T00:00:01.000Z' },
      'c-2': { status: 'sent' },
    });
    const byKey = new Map(views.map((v) => [v.contactKey, v]));
    expect(byKey.get('c-1')?.carrierSentAt).toBe('2026-07-16T00:00:01.000Z');
    expect(byKey.get('c-2')?.carrierSentAt).toBeUndefined();
  });
});

describe('shareRecipientReason (share-skip-fix D7)', () => {
  it('maps every skip code to its staff-facing reason, exactly', () => {
    expect(shareRecipientReason('skipped', 'manual_mode')).toBe('Automatic texts were off for this conversation');
    expect(shareRecipientReason('skipped', 'opted_out')).toBe('Opted out of texts');
    expect(shareRecipientReason('skipped', 'contact_opted_out')).toBe('Opted out of texts');
    expect(shareRecipientReason('skipped', 'unreachable')).toBe("Number can't receive texts");
    expect(shareRecipientReason('skipped', 'no_consent')).toBe('No texting consent recorded');
    expect(shareRecipientReason('skipped', 'contact_no_consent')).toBe('No texting consent recorded');
    expect(shareRecipientReason('skipped', 'contact_deleted')).toBe('Contact was deleted');
    expect(shareRecipientReason('skipped', 'breaker_open')).toBe('Stopped by the automatic-text safety limit');
    expect(shareRecipientReason('skipped', 'sms_sending_disabled')).toBe('Texting is turned off');
  });

  it('a legacy skip with no code reads the honest disjunction; an unknown code shows the code', () => {
    expect(shareRecipientReason('skipped', undefined)).toBe('Opted out or number unreachable');
    expect(shareRecipientReason('skipped', 'something_new')).toBe('Not sent (something_new)');
  });

  it('failed rows: no_contact has its own line; carrier and fan-out codes keep deliveryReason; no code = Delivery failed', () => {
    expect(shareRecipientReason('failed', 'no_contact')).toBe('No contact or phone on file');
    expect(shareRecipientReason('failed', '30007')).toBe('Carrier filtered the message (error 30007)');
    expect(shareRecipientReason('failed', 'transient_cap')).toBe('Sending gave up after repeated temporary errors');
    expect(shareRecipientReason('failed', 'enqueue_failed')).toBe('Sending could not be scheduled');
    expect(shareRecipientReason('failed', undefined)).toBe('Delivery failed');
    // retry-send-window D8: a failed share row reads the PLAIN 30003. The slot
    // carries no retry_due_at, so the row cannot know a retry is scheduled and
    // promises none (under-promising, never false); reading the failed message's
    // live stamp is share-skip-fix Branch B's, under the same rule.
    expect(shareRecipientReason('failed', '30003')).toBe('Phone unreachable (error 30003)');
  });

  it('no reason for the in-flight and success states', () => {
    for (const s of ['queued', 'sent', 'delivered'] as const) {
      expect(shareRecipientReason(s, 'anything')).toBeUndefined();
    }
  });
});

function stats(over: Partial<BroadcastStats> = {}): BroadcastStats {
  return { audience: 0, sent: 0, delivered: 0, failed: 0, skipped_opted_out: 0, skipped_no_consent: 0, queued: 0, ...over };
}

describe('presentShareLabel (share-skip-fix D6)', () => {
  it('a finished share whose EVERY recipient was skipped reads Not sent (neutral)', () => {
    expect(presentShareLabel('sent', stats({ audience: 1, skipped_other: 1 }))).toEqual({ label: 'Not sent', tone: 'neutral' });
    expect(presentShareLabel('sent', stats({ audience: 3, skipped_opted_out: 1, skipped_no_consent: 1, skipped_other: 1 }))).toEqual({ label: 'Not sent', tone: 'neutral' });
    // Legacy stats without skipped_other: the two old buckets alone decide.
    expect(presentShareLabel('sent', stats({ audience: 2, skipped_opted_out: 2 }))).toEqual({ label: 'Not sent', tone: 'neutral' });
  });

  it('anything else keeps the status label and tone', () => {
    expect(presentShareLabel('sent', stats({ audience: 2, skipped_other: 1, delivered: 1 }))).toEqual({ label: 'Sent', tone: 'positive' });
    expect(presentShareLabel('sent', stats({ audience: 2, skipped_other: 1, failed: 1 }))).toEqual({ label: 'Sent', tone: 'positive' });
    expect(presentShareLabel('sending', stats({ audience: 1, skipped_other: 1 }))).toEqual({ label: 'Sending', tone: 'progress' });
    expect(presentShareLabel('failed', stats({ audience: 1, failed: 1 }))).toEqual({ label: 'Failed', tone: 'danger' });
    expect(presentShareLabel('draft', stats({ audience: 5 }))).toEqual({ label: 'Draft', tone: 'neutral' });
    expect(presentShareLabel('sent', stats())).toEqual({ label: 'Sent', tone: 'positive' }); // audience 0 is not "all skipped"
    expect(presentShareLabel('sent')).toEqual({ label: 'Sent', tone: 'positive' }); // no stats at hand
  });
});
