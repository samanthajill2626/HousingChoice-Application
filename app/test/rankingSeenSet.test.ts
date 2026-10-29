// WP1 B2a S3.2 (spec D2.3, D2.5; charter 6.3): the stored facts of a pair and
// the unbounded seen set. Sends are every COUNTED share with its kind (a flyer
// sign-up reads signed_up; a legacy row falls back to sentAt); the decline is
// the stored record, never the derived outcome; a tour reaches nothing but its
// projection. Pure.
import { describe, expect, it } from 'vitest';
import { FLYER_SHARE_KEY } from '../src/lib/shareLedgerKeys.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import {
  DAY_MS,
  daysSince,
  declinedOf,
  instantMs,
  pairHistoryOf,
  sendFactsOf,
  tourProjection,
} from '../src/services/ranking/pairHistory.js';
import { MISSING_UNIT_LABEL, NO_ADDRESS_LABEL, buildSeenSet, seenUnitIds } from '../src/services/ranking/seenSet.js';
import { NOW, daysAgo, legacySendRow, sendRow, tourRow, unit } from './helpers/rankingFixtures.js';

describe('sendFactsOf - every counted send with its kind (spec D2.3, D2.5)', () => {
  it('reads each counted share, a flyer sign-up as signed_up, oldest first', () => {
    const row = sendRow('u1', 't1', [{ at: daysAgo(3) }, { at: daysAgo(9), key: FLYER_SHARE_KEY }, { at: daysAgo(1) }]);
    expect(sendFactsOf(row)).toEqual([
      { at: daysAgo(9), kind: 'signed_up' },
      { at: daysAgo(3), kind: 'sent' },
      { at: daysAgo(1), kind: 'sent' },
    ]);
  });

  it('skips a share that does not count', () => {
    const row = sendRow('u1', 't1', [{ at: daysAgo(3) }]);
    const withPending = { ...row, shares: { ...(row.shares ?? {}), 'bcast-9': { attempt: 'x#9', state: 'pending' as const } } };
    expect(sendFactsOf(withPending)).toEqual([{ at: daysAgo(3), kind: 'sent' }]);
  });

  it('falls back to sentAt on a legacy row with no shares (charter 6.3)', () => {
    expect(sendFactsOf(legacySendRow('u1', 't1', daysAgo(20)))).toEqual([{ at: daysAgo(20), kind: 'sent' }]);
  });
});

describe('declinedOf - the stored record, never the derived outcome', () => {
  it('keeps who and when, never the staff id', () => {
    const row = sendRow('u1', 't1', [{ at: daysAgo(4) }], { declined: { at: daysAgo(2), by: 'staff', staffId: 'user-1' } });
    expect(declinedOf(row)).toEqual({ by: 'staff', at: daysAgo(2) });
  });

  it('reads null when there is no row or no decline', () => {
    expect(declinedOf(undefined)).toBeNull();
    expect(declinedOf(sendRow('u1', 't1', [{ at: daysAgo(4) }]))).toBeNull();
  });
});

describe('tourProjection - the only tour facts that reach a card (spec D2.3)', () => {
  it('keeps status, outcome and the scheduled time; roster, reminder and bookkeeping fields never', () => {
    const tour = tourRow('tour-1', 't1', 'u1', {
      status: 'closed',
      outcome: 'move_forward',
      roster: [],
      rosterVersion: 3,
      currentLadderId: 'ladder-9',
      lastMarkedAt: daysAgo(1),
      groupThreadId: 'conv-1',
      updatedAt: daysAgo(0),
    });
    expect(tourProjection(tour)).toEqual({ status: 'closed', outcome: 'move_forward', scheduledAt: daysAgo(-2) });
  });

  it('reads a requested tour with no time and no outcome as nulls', () => {
    const { scheduledAt: _drop, ...requested } = tourRow('tour-2', 't1', 'u1', { status: 'requested' });
    expect(tourProjection(requested)).toEqual({ status: 'requested', outcome: null, scheduledAt: null });
  });
});

describe('seenUnitIds and buildSeenSet - every property sent or toured, unbounded (spec D2.3)', () => {
  it('lists every unit of either source once, by unit id', () => {
    const sends = [sendRow('u3', 't1', [{ at: daysAgo(2) }]), sendRow('u1', 't1', [{ at: daysAgo(4) }])];
    const tours = [tourRow('tour-1', 't1', 'u2'), tourRow('tour-2', 't1', 'u1')];
    expect(seenUnitIds(sends, tours)).toEqual(['u1', 'u2', 'u3']);
  });

  it('builds each home: label, sends, decline, tours in creation order, last send and newest activity', () => {
    const units = new Map<string, UnitItem>([
      ['u1', unit('u1')],
      ['u2', unit('u2')],
    ]);
    const sends = [sendRow('u2', 't1', [{ at: daysAgo(4) }], { declined: { at: daysAgo(2), by: 'staff', staffId: 'user-1' } })];
    const tours = [
      tourRow('tour-b', 't1', 'u1', { createdAt: daysAgo(6), scheduledAt: daysAgo(1), status: 'toured' }),
      tourRow('tour-a', 't1', 'u1', { createdAt: daysAgo(8), status: 'requested', scheduledAt: undefined }),
    ];
    expect(buildSeenSet({ sends, tours, units })).toEqual([
      {
        unitId: 'u1',
        unit: units.get('u1'),
        label: 'u1 Main St, Decatur',
        attachLabel: 'u1 Main St, Decatur',
        sends: [],
        lastSendAt: null,
        declined: null,
        tours: [
          { status: 'requested', outcome: null, scheduledAt: null },
          { status: 'toured', outcome: null, scheduledAt: daysAgo(1) },
        ],
        activityAt: daysAgo(1),
      },
      {
        unitId: 'u2',
        unit: units.get('u2'),
        label: 'u2 Main St, Decatur',
        attachLabel: 'u2 Main St, Decatur',
        sends: [{ at: daysAgo(4), kind: 'sent' }],
        lastSendAt: daysAgo(4),
        declined: { by: 'staff', at: daysAgo(2) },
        tours: [],
        activityAt: daysAgo(2),
      },
    ]);
  });

  it('a unit a COMPLETE read did not find keeps its sends, decline and tours under the placeholder label', () => {
    const sends = [sendRow('u3', 't1', [{ at: daysAgo(7) }], { declined: { at: daysAgo(6), by: 'engine' } })];
    const [home] = buildSeenSet({ sends, tours: [tourRow('tour-1', 't1', 'u3')], units: new Map() });
    expect(home).toMatchObject({
      unitId: 'u3',
      unit: null,
      label: MISSING_UNIT_LABEL,
      attachLabel: undefined,
      sends: [{ at: daysAgo(7), kind: 'sent' }],
      declined: { by: 'engine', at: daysAgo(6) },
      tours: [{ status: 'scheduled', outcome: null, scheduledAt: daysAgo(-2) }],
    });
  });

  it('a soft-deleted unit is still listed with its own label', () => {
    const deleted = unit('u4', { deleted_at: daysAgo(1) });
    const [home] = buildSeenSet({ sends: [sendRow('u4', 't1', [{ at: daysAgo(3) }])], tours: [], units: new Map([['u4', deleted]]) });
    expect(home).toMatchObject({ unitId: 'u4', unit: deleted, label: 'u4 Main St, Decatur', attachLabel: 'u4 Main St, Decatur' });
  });

  it('a unit with no usable address reads the no-address label and attaches nothing (C5)', () => {
    const legacy = { ...unit('u5'), address: '5 Old Rd, Atlanta, GA 30310' } as unknown as UnitItem;
    const [home] = buildSeenSet({ sends: [sendRow('u5', 't1', [{ at: daysAgo(3) }])], tours: [], units: new Map([['u5', legacy]]) });
    expect(home).toMatchObject({ unitId: 'u5', label: NO_ADDRESS_LABEL, attachLabel: undefined });
  });
});

describe('pairHistoryOf - this tenant and this property (spec D2.5)', () => {
  it('a pair with no send and no tour has an empty history', () => {
    expect(pairHistoryOf(undefined, NOW)).toEqual({ sends: [], declined: null, tours: [], daysSinceLastSend: null });
  });

  it('carries the sends with kinds, the stored decline, the tour projections and whole days since the last send', () => {
    const units = new Map([['u1', unit('u1')]]);
    const half = new Date(NOW.getTime() - 4.5 * DAY_MS).toISOString();
    const sends = [sendRow('u1', 't1', [{ at: daysAgo(10), key: FLYER_SHARE_KEY }, { at: half }], { declined: { at: daysAgo(12), by: 'staff' } })];
    const [home] = buildSeenSet({ sends, tours: [tourRow('tour-1', 't1', 'u1')], units });
    expect(pairHistoryOf(home, NOW)).toEqual({
      sends: [
        { at: daysAgo(10), kind: 'signed_up' },
        { at: half, kind: 'sent' },
      ],
      declined: { by: 'staff', at: daysAgo(12) },
      tours: [{ status: 'scheduled', outcome: null, scheduledAt: daysAgo(-2) }],
      daysSinceLastSend: 4,
    });
  });

  it('keeps a decline a LATER send would supersede in the derived outcome (charter 6.3)', () => {
    const sends = [sendRow('u1', 't1', [{ at: daysAgo(1) }], { declined: { at: daysAgo(10), by: 'staff' } })];
    const [home] = buildSeenSet({ sends, tours: [], units: new Map([['u1', unit('u1')]]) });
    expect(pairHistoryOf(home, NOW).declined).toEqual({ by: 'staff', at: daysAgo(10) });
  });

  it('daysSince and instantMs: null for nothing, never negative, unparseable reads as nothing', () => {
    expect(daysSince(null, NOW)).toBeNull();
    expect(daysSince(daysAgo(-3), NOW)).toBe(0);
    expect(instantMs('not a date')).toBeUndefined();
    expect(instantMs(daysAgo(1))).toBe(NOW.getTime() - DAY_MS);
  });
});
