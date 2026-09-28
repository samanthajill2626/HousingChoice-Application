// S4 (broadcast live progress): deriveBroadcastStats is the single source of
// truth for the disjoint stat buckets. It derives every counter from the
// recipients map so a recipient is counted in EXACTLY ONE bucket and the
// buckets always sum to the audience (the map size). An empty map (drafts, or a
// legacy row with no map) passes the persisted stats through unchanged.
import { describe, expect, it } from 'vitest';
import { SEND_UNCONFIRMED_CODE } from '../src/lib/sendOutcome.js';
import {
  deriveBroadcastStats,
  zeroStats,
  type BroadcastRecipient,
  type BroadcastStats,
} from '../src/repos/broadcastsRepo.js';

function recips(
  entries: Array<[string, BroadcastRecipient]>,
): Record<string, BroadcastRecipient> {
  return Object.fromEntries(entries);
}

describe('deriveBroadcastStats (S4 disjoint buckets)', () => {
  it('empty map: returns the persisted stats unchanged (drafts show the estimate)', () => {
    const persisted: BroadcastStats = { ...zeroStats(), audience: 42 };
    const out = deriveBroadcastStats({ recipients: {}, stats: persisted });
    expect(out).toEqual(persisted);
    expect(out).toBe(persisted); // same object (passthrough, no recompute)
  });

  it('computes every bucket from the map (disjoint), audience = map size', () => {
    const recipients = recips([
      ['c-q', { status: 'queued' }],
      ['c-s', { status: 'sent', carrierSentAt: '2026-07-16T00:00:01.000Z' }],
      ['c-d', { status: 'delivered' }],
      ['c-f', { status: 'failed', errorCode: '30007' }],
      ['c-opt', { status: 'skipped' }], // opted-out (no errorCode)
      ['c-nc', { status: 'skipped', errorCode: 'no_consent' }],
    ]);
    // Legacy cumulative persisted stats are DELIBERATELY wrong here - they must
    // be ignored when the map is present.
    const out = deriveBroadcastStats({
      recipients,
      stats: { ...zeroStats(), audience: 999, sent: 999, delivered: 999 },
    });
    expect(out).toEqual({
      audience: 6,
      queued: 1,
      sending: 0,
      sent: 1,
      delivered: 1,
      failed: 1,
      unconfirmed: 0,
      skipped_opted_out: 1,
      skipped_no_consent: 1,
      skipped_other: 0,
    });
  });

  it('routes a failed slot carrying send_unconfirmed to unconfirmed and to no other bucket (D22)', () => {
    const s = deriveBroadcastStats({
      recipients: recips([
        ['a', { status: 'failed', errorCode: SEND_UNCONFIRMED_CODE }],
        ['b', { status: 'failed', errorCode: '30007' }],
        ['c', { status: 'failed' }],
      ]),
      stats: zeroStats(),
    });
    expect(s).toMatchObject({ unconfirmed: 1, failed: 2, audience: 3 });
    expect(s.skipped_opted_out + s.skipped_no_consent + (s.skipped_other ?? 0)).toBe(0);
    // The code alone decides: a slot that is not failed keeps its own bucket.
    const queued = deriveBroadcastStats({
      recipients: recips([['a', { status: 'queued', errorCode: SEND_UNCONFIRMED_CODE }]]),
      stats: zeroStats(),
    });
    expect(queued).toMatchObject({ queued: 1, unconfirmed: 0, failed: 0 });
  });

  it('zeroStats carries the unconfirmed bucket at zero', () => {
    expect(zeroStats().unconfirmed).toBe(0);
  });

  it("splits the in-flight states: on-our-box 'queued' vs dispatched-unconfirmed 'sending' vs carrier-confirmed 'sent'", () => {
    // The fan-out stamps 'sent' at dispatch as its idempotency claim; the
    // carrier's own sent callback stamps carrierSentAt. The two in-flight
    // buckets stay SEPARATE (founder ask 2026-07-16): a stuck send must be
    // diagnosable as stuck-on-our-box (queued) vs stuck-at-the-carrier
    // (sending) - different failures, different fixes.
    const recipients = recips([
      ['c-dispatched', { status: 'sent' }],
      ['c-confirmed', { status: 'sent', carrierSentAt: '2026-07-16T00:00:01.000Z' }],
      ['c-deferred', { status: 'queued', errorCode: '429' }],
      ['c-unsent', { status: 'queued' }],
    ]);
    const out = deriveBroadcastStats({ recipients, stats: zeroStats() });
    expect(out.queued).toBe(2); // deferred-retry + awaiting-fan-out: on our box
    expect(out.sending).toBe(1); // dispatched, carrier not yet confirmed
    expect(out.sent).toBe(1); // only the carrier-confirmed one
    expect(out.audience).toBe(4);
  });

  it('skipped split (share-skip-fix D7): consent codes -> no_consent; opt-out codes and code-less -> opted_out; everything else -> skipped_other', () => {
    const recipients = recips([
      ['c-1', { status: 'skipped', errorCode: 'no_consent' }],
      ['c-1b', { status: 'skipped', errorCode: 'contact_no_consent' }],
      ['c-2', { status: 'skipped', errorCode: 'contact_opted_out' }],
      ['c-2b', { status: 'skipped', errorCode: 'opted_out' }],
      ['c-3', { status: 'skipped' }], // legacy first-fence skip: opt-out or unreachable, unknown which
      ['c-4', { status: 'skipped', errorCode: 'manual_mode' }],
      ['c-5', { status: 'skipped', errorCode: 'unreachable' }],
      ['c-6', { status: 'skipped', errorCode: 'contact_deleted' }],
    ]);
    const out = deriveBroadcastStats({ recipients, stats: zeroStats() });
    expect(out.skipped_no_consent).toBe(2);
    expect(out.skipped_opted_out).toBe(3);
    expect(out.skipped_other).toBe(3);
    expect(out.audience).toBe(8);
  });

  it('INVARIANT: queued+sent+delivered+failed+skipped_opted_out+skipped_no_consent == audience == map size', () => {
    const statuses: Array<BroadcastRecipient> = [];
    const pool: BroadcastRecipient['status'][] = [
      'queued',
      'sent',
      'delivered',
      'failed',
      'skipped',
    ];
    for (let i = 0; i < 50; i++) {
      const status = pool[i % pool.length]!;
      statuses.push(
        status === 'skipped' && i % 2 === 0
          ? { status, errorCode: 'no_consent' }
          : status === 'failed' && i % 2 === 1
            ? { status, errorCode: SEND_UNCONFIRMED_CODE }
            : { status },
      );
    }
    const recipients = recips(statuses.map((r, i) => [`c-${i}`, r]));
    const out = deriveBroadcastStats({ recipients, stats: zeroStats() });
    // The unconfirmed bucket is exercised, not vacuously zero.
    expect(out.unconfirmed).toBeGreaterThan(0);
    const sum =
      out.queued +
      (out.sending ?? 0) +
      out.sent +
      out.delivered +
      out.failed +
      (out.unconfirmed ?? 0) +
      out.skipped_opted_out +
      out.skipped_no_consent +
      (out.skipped_other ?? 0);
    expect(sum).toBe(out.audience);
    expect(out.audience).toBe(Object.keys(recipients).length);
  });

  // share-sent-outcome D4 / D1: the two caller-supplied options.
  it('retry_pending is absent unless supplied, and never joins the bucket sum', () => {
    const b = { recipients: { c1: { status: 'failed' as const, errorCode: '30003' } }, stats: { ...zeroStats(), audience: 1 } };
    expect(deriveBroadcastStats(b).retry_pending).toBeUndefined();
    const withPending = deriveBroadcastStats(b, { retryPending: 1 });
    expect(withPending.retry_pending).toBe(1);
    expect(withPending.failed).toBe(1); // the sub-bucket does not shrink failed
  });
  it('an unconfirmedKeys entry moves a failed slot into unconfirmed (the row said its chain ended unresolved)', () => {
    const b = { recipients: { c1: { status: 'failed' as const, errorCode: '30003' } }, stats: { ...zeroStats(), audience: 1 } };
    expect(deriveBroadcastStats(b, { unconfirmedKeys: new Set(['c1']) })).toMatchObject({ failed: 0, unconfirmed: 1 });
  });
  it('the empty-map passthrough returns the persisted object itself when no option is supplied (the :26 pin), and a copy with retry_pending when one is', () => {
    const persisted = zeroStats();
    expect(deriveBroadcastStats({ recipients: {}, stats: persisted })).toBe(persisted);
    expect(deriveBroadcastStats({ recipients: {}, stats: persisted }, { retryPending: 0 })).toEqual({ ...persisted, retry_pending: 0 });
  });
});
