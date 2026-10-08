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
  skippedTotal,
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
  it('pluralizes recipient/recipients by count (spec 2026-10-06 D20: a seed may be a partner)', () => {
    expect(sendReachLabel(1)).toBe('To 1 recipient');
    expect(sendReachLabel(0)).toBe('To 0 recipients');
    expect(sendReachLabel(5)).toBe('To 5 recipients');
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

  // SOR D20/D22: the recipient row keys on `send_unconfirmed` BEFORE the
  // status - the same "Not confirmed" the relay row reads, never "Failed".
  it('keys on send_unconfirmed before status', () => {
    const notConfirmed = {
      label: 'Not confirmed',
      tone: 'danger',
      isFailure: false,
      reason: "Couldn't confirm whether this text went out",
    };
    expect(presentRecipientStatus('failed', undefined, 'send_unconfirmed')).toEqual(notConfirmed);
    expect(presentRecipientStatus('queued', undefined, 'send_unconfirmed')).toEqual(notConfirmed);
    // Any other code keeps the status-keyed presentation.
    expect(presentRecipientStatus('failed', undefined, '30007').isFailure).toBe(true);
    expect(presentRecipientStatus('failed', undefined, '30007').label).toBe('Failed');
    expect(presentRecipientStatus('queued', undefined, 'send_retryable').isFailure).toBe(false);
  });

  it('toRecipientViews still sorts an unconfirmed row first - it is failed-status, and danger-toned', () => {
    const views = toRecipientViews({
      c2: { status: 'delivered' },
      c1: { status: 'failed', errorCode: 'send_unconfirmed' },
    });
    expect(views.map((v) => v.contactKey)).toEqual(['c1', 'c2']);
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
    // share-sent-outcome D3: with NO promise facts at hand the row promises
    // nothing and reads the PLAIN 30003 (under-promising, never false).
    expect(shareRecipientReason('failed', '30003')).toBe('Phone unreachable (error 30003)');
  });

  // share-sent-outcome D3: the row carries its newest attempt's promise facts
  // (retryDueAt / retryOutcome, from that attempt's own message row) and judges
  // liveness on the SERVER clock it is handed - RSW's copy, same rule as the
  // one-to-one bubble.
  it('a failed 30003 row reads "will retry" while its promise is live, "retry not confirmed" when its chain ended unresolved, and the plain copy once the promise lapsed', () => {
    const now = Date.parse('2026-07-01T12:00:00.000Z');
    expect(shareRecipientReason('failed', '30003', { retryDueAt: '2026-07-01T12:03:00.000Z', serverNowMs: now })).toBe(
      'Phone unreachable - will retry (error 30003)',
    );
    // Still live inside the 2-minute grace past the due instant.
    expect(shareRecipientReason('failed', '30003', { retryDueAt: '2026-07-01T11:58:30.000Z', serverNowMs: now })).toBe(
      'Phone unreachable - will retry (error 30003)',
    );
    expect(
      shareRecipientReason('failed', '30003', {
        retryDueAt: '1970-01-01T00:00:00.000Z',
        retryOutcome: 'unconfirmed',
        serverNowMs: now,
      }),
    ).toBe('Phone unreachable - retry not confirmed (error 30003)');
    // Lapsed (due + grace behind the server clock) and withdrawn read plain.
    expect(shareRecipientReason('failed', '30003', { retryDueAt: '2026-07-01T11:57:00.000Z', serverNowMs: now })).toBe(
      'Phone unreachable (error 30003)',
    );
    expect(shareRecipientReason('failed', '30003', { retryDueAt: '1970-01-01T00:00:00.000Z', serverNowMs: now })).toBe(
      'Phone unreachable (error 30003)',
    );
    // A non-30003 failure never promises, whatever the facts say.
    expect(shareRecipientReason('failed', '30007', { retryDueAt: '2026-07-01T12:03:00.000Z', serverNowMs: now })).toBe(
      'Carrier filtered the message (error 30007)',
    );
  });

  it('no reason for the in-flight and success states', () => {
    for (const s of ['queued', 'sent', 'delivered'] as const) {
      expect(shareRecipientReason(s, 'anything')).toBeUndefined();
    }
  });

  // SOR Sec 2a item 1 / D23: a failed row falls through to deliveryReason,
  // whose internal map answers the SOR codes first - prose, never a tail.
  it('answers the internal map for the failed SOR codes', () => {
    expect(shareRecipientReason('failed', 'send_unconfirmed')).toBe(
      "Couldn't confirm whether this text went out",
    );
    expect(shareRecipientReason('failed', 'redrive_refused')).toBe(
      "Wasn't resent: the group closed or the member left",
    );
    expect(shareRecipientReason('failed', 'sms_sending_disabled')).toBe(
      'SMS sending is switched off, so nothing was sent',
    );
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

  it('share-sent-outcome D4: a finished share derives its label from the buckets; draft, sending and no-stats keep the stored label', () => {
    expect(presentShareLabel('sent', stats({ audience: 2, skipped_other: 1, delivered: 1 }))).toEqual({ label: 'Sent', tone: 'positive' });
    // Nothing reached, one failure, one skip: Not sent, danger (was "Sent").
    expect(presentShareLabel('sent', stats({ audience: 2, skipped_other: 1, failed: 1 }))).toEqual({ label: 'Not sent', tone: 'danger' });
    expect(presentShareLabel('sending', stats({ audience: 1, skipped_other: 1 }))).toEqual({ label: 'Sending', tone: 'progress' });
    // "Failed" retires as a pill for a finished share: Not sent, danger.
    expect(presentShareLabel('failed', stats({ audience: 1, failed: 1 }))).toEqual({ label: 'Not sent', tone: 'danger' });
    expect(presentShareLabel('draft', stats({ audience: 5 }))).toEqual({ label: 'Draft', tone: 'neutral' });
    // Audience 0 is not "all skipped", and nothing reached: Not sent, danger.
    expect(presentShareLabel('sent', stats())).toEqual({ label: 'Not sent', tone: 'danger' });
    expect(presentShareLabel('sent')).toEqual({ label: 'Sent', tone: 'positive' }); // no stats at hand
  });

  it('share-sent-outcome D4: first match wins - Sent (any reached, sending included), Sending (none reached, one pending), Not confirmed, Not sent', () => {
    // A stored-failed share that reached someone reads Sent.
    expect(presentShareLabel('failed', stats({ audience: 2, delivered: 1, failed: 1 }))).toEqual({ label: 'Sent', tone: 'positive' });
    // Accepted by the carrier but not yet confirmed counts as reached.
    expect(presentShareLabel('sent', stats({ audience: 2, sending: 1, failed: 1 }))).toEqual({ label: 'Sent', tone: 'positive' });
    // None reached, a retry pending: Sending, progress - it outranks Not confirmed.
    expect(presentShareLabel('sent', stats({ audience: 1, failed: 1, retry_pending: 1 }))).toEqual({ label: 'Sending', tone: 'progress' });
    expect(presentShareLabel('failed', stats({ audience: 2, failed: 1, retry_pending: 1, unconfirmed: 1 }))).toEqual({
      label: 'Sending',
      tone: 'progress',
    });
    // A reached recipient outranks a pending one.
    expect(presentShareLabel('sent', stats({ audience: 2, delivered: 1, failed: 1, retry_pending: 1 }))).toEqual({
      label: 'Sent',
      tone: 'positive',
    });
    // None reached or pending, one unconfirmed: Not confirmed, danger (deviation 4).
    expect(presentShareLabel('failed', stats({ audience: 2, failed: 1, unconfirmed: 1 }))).toEqual({
      label: 'Not confirmed',
      tone: 'danger',
    });
    // A share the route marked failed with EVERY slot still queued: Not sent, danger.
    expect(presentShareLabel('failed', stats({ audience: 3, queued: 3 }))).toEqual({ label: 'Not sent', tone: 'danger' });
    // A lapsed count of 0 reads as no pending at all.
    expect(presentShareLabel('sent', stats({ audience: 1, failed: 1, retry_pending: 0 }))).toEqual({ label: 'Not sent', tone: 'danger' });
  });
});

// SOR D22: `unconfirmed` is its own bucket, NEVER a skip. Those recipients MAY
// have been texted, so a share of them must never read "Not sent".
describe('the unconfirmed bucket (SOR D22)', () => {
  it('skippedTotal never includes unconfirmed', () => {
    expect(skippedTotal(stats({ unconfirmed: 5 }))).toBe(0);
    expect(skippedTotal(stats({ skipped_other: 1, unconfirmed: 5 }))).toBe(1);
  });

  it('share-sent-outcome D4: a sent share whose other recipients were all skipped reads Not confirmed (danger), never Not sent', () => {
    expect(presentShareLabel('sent', stats({ audience: 2, skipped_other: 1, unconfirmed: 1 }))).toEqual({
      label: 'Not confirmed',
      tone: 'danger',
    });
  });
});

describe('toRecipientViews - share-sent-outcome D3 facts', () => {
  it('keeps the message id, the newest attempt and the promise facts the row judges', () => {
    const views = toRecipientViews({
      c1: {
        status: 'failed',
        errorCode: '30003',
        conversationId: 'conv-1',
        tsMsgId: '2026-07-01T11:55:00.000Z#SM1',
        latestAttempt: '2026-07-01T11:57:00.000Z#SM2',
        retryDueAt: '2026-07-01T12:03:00.000Z',
        retryPending: true,
      },
      c2: { status: 'failed', errorCode: '30003', retryOutcome: 'unconfirmed' },
      c3: { status: 'delivered' },
    });
    const byKey = new Map(views.map((v) => [v.contactKey, v]));
    expect(byKey.get('c1')).toMatchObject({
      tsMsgId: '2026-07-01T11:55:00.000Z#SM1',
      latestAttempt: '2026-07-01T11:57:00.000Z#SM2',
      retryDueAt: '2026-07-01T12:03:00.000Z',
      retryPending: true,
    });
    expect(byKey.get('c2')).toMatchObject({ retryOutcome: 'unconfirmed' });
    expect(byKey.get('c2')).not.toHaveProperty('retryPending');
    expect(byKey.get('c3')).not.toHaveProperty('tsMsgId');
    expect(byKey.get('c3')).not.toHaveProperty('retryDueAt');
  });
});
