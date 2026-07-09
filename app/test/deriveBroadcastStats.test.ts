// S4 (broadcast live progress): deriveBroadcastStats is the single source of
// truth for the disjoint stat buckets. It derives every counter from the
// recipients map so a recipient is counted in EXACTLY ONE bucket and the
// buckets always sum to the audience (the map size). An empty map (drafts, or a
// legacy row with no map) passes the persisted stats through unchanged.
import { describe, expect, it } from 'vitest';
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
      ['c-s', { status: 'sent' }],
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
      sent: 1,
      delivered: 1,
      failed: 1,
      skipped_opted_out: 1,
      skipped_no_consent: 1,
    });
  });

  it('skipped split: only errorCode "no_consent" is skipped_no_consent; every other skip is opted_out', () => {
    const recipients = recips([
      ['c-1', { status: 'skipped', errorCode: 'no_consent' }],
      ['c-2', { status: 'skipped', errorCode: 'contact_opted_out' }],
      ['c-3', { status: 'skipped' }], // no errorCode -> opted_out bucket
    ]);
    const out = deriveBroadcastStats({ recipients, stats: zeroStats() });
    expect(out.skipped_no_consent).toBe(1);
    expect(out.skipped_opted_out).toBe(2);
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
          : { status },
      );
    }
    const recipients = recips(statuses.map((r, i) => [`c-${i}`, r]));
    const out = deriveBroadcastStats({ recipients, stats: zeroStats() });
    const sum =
      out.queued +
      out.sent +
      out.delivered +
      out.failed +
      out.skipped_opted_out +
      out.skipped_no_consent;
    expect(sum).toBe(out.audience);
    expect(out.audience).toBe(Object.keys(recipients).length);
  });
});
