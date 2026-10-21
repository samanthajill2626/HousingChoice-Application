// matching-blast-rules (spec docs/superpowers/specs/
// 2026-10-14-matching-blast-rules-design.md) - the pure rules module
// app/src/lib/blastAudienceRules.ts: D1 read order, D2 the authority-list
// normalizer and the wire shape, D4 the tour hold rule (every row of the
// table, its boundaries, the pick among several, the per-tenant map), D5 the
// default-checked rule. No I/O, no clock.
import { describe, expect, it } from 'vitest';
import {
  authoritiesOfFilter,
  BLAST_TENANT_STATUSES,
  bedroomSizesOfFilter,
  checkedByDefault,
  MAX_FILTER_AUTHORITIES,
  pickTourHold,
  TOUR_HOLD_KIND_ORDER,
  TOUR_REQUEST_HOLD_MS,
  tourHoldOf,
  tourHoldsByTenant,
  VOUCHER_CHIP_MAX,
  voucherSizeMatches,
  wireAudienceFilter,
  type DefaultCheckFlags,
  type TourHold,
  type TourHoldInput,
  type TourHoldKind,
} from '../src/lib/blastAudienceRules.js';
import type { AudienceFilter } from '../src/repos/broadcastsRepo.js';
import type { TourItem } from '../src/repos/toursRepo.js';

const HOUR = 60 * 60 * 1000;
const NOW_ISO = '2026-10-14T12:00:00.000Z';
const NOW = Date.parse(NOW_ISO);
const iso = (ms: number): string => new Date(ms).toISOString();
/** 2026-10-09 and 2026-10-20 at noon UTC: a past and a future tour date. */
const AT_PAST = iso(NOW - 5 * 24 * HOUR);
const AT_FUTURE = iso(NOW + 6 * 24 * HOUR);

/** The fields the rule reads; defaults to a scheduled tour with no date. */
function tour(over: Partial<TourHoldInput>): TourHoldInput {
  return { tourId: 'tour-1', tenantId: 'c-1', status: 'scheduled', ...over };
}

/** A WHOLE stored tour. Passing it where a TourHoldInput is expected is the
 *  binding claim "a stored TourItem satisfies it" - checked by
 *  `npm run typecheck`, which compiles app/test. */
function storedTour(over: Partial<TourItem>): TourItem {
  const created = iso(NOW - 30 * 24 * HOUR);
  return {
    tourId: 'tour-1',
    tenantId: 'c-1',
    unitId: 'unit-1',
    _schedPartition: 'tours',
    tourType: 'self_guided',
    status: 'scheduled',
    createdAt: created,
    updatedAt: created,
    ...over,
  };
}

describe('blast audience rules - constants (D1, D2, D4)', () => {
  it('reads searching then onboarding; holds a request 336 hours; caps the list at 100; orders the hold kinds', () => {
    expect(BLAST_TENANT_STATUSES).toEqual(['searching', 'onboarding']);
    expect(TOUR_REQUEST_HOLD_MS).toBe(336 * HOUR);
    expect(MAX_FILTER_AUTHORITIES).toBe(100);
    expect(TOUR_HOLD_KIND_ORDER).toEqual([
      'needs_placement',
      'upcoming',
      'needs_outcome',
      'not_marked',
      'no_show',
      'requested',
    ]);
  });
});

describe('authoritiesOfFilter - the ONE reader of a stored filter authorities (D2)', () => {
  it('no filter, or a filter naming no authority, is the empty list', () => {
    expect(authoritiesOfFilter(undefined)).toEqual([]);
    expect(authoritiesOfFilter({})).toEqual([]);
  });

  it('a list is trimmed, blanks dropped and de-duplicated - first wins, order kept', () => {
    expect(
      authoritiesOfFilter({ housing_authorities: [' HA-B ', '', 'HA-A', 'HA-B', '   ', 'HA-A '] }),
    ).toEqual(['HA-B', 'HA-A']);
  });

  it('a stored non-string member is ignored', () => {
    const odd = ['HA-A', 7, null] as unknown as string[];
    expect(authoritiesOfFilter({ housing_authorities: odd })).toEqual(['HA-A']);
  });

  it('LEGACY: the one-string housing_authority is a one-member list (trimmed); a blank one is no filter', () => {
    expect(authoritiesOfFilter({ housing_authority: ' Atlanta Housing Authority ' })).toEqual([
      'Atlanta Housing Authority',
    ]);
    expect(authoritiesOfFilter({ housing_authority: '   ' })).toEqual([]);
  });

  it('a present list wins over a legacy string, even an empty list', () => {
    expect(authoritiesOfFilter({ housing_authorities: ['HA-A'], housing_authority: 'HA-OLD' })).toEqual(['HA-A']);
    expect(authoritiesOfFilter({ housing_authorities: [], housing_authority: 'HA-OLD' })).toEqual([]);
  });
});

// property-requirements (spec 2026-10-20) D12: the voucher size LIST. The
// dashboard mirror (dashboard/src/routes/broadcasts/broadcastFormat.ts) runs
// the SAME SIZE_CASES; keep the two tables identical.
const SIZE_CASES: Array<[string, { bedroomSizes?: unknown; bedroomSize?: unknown } | undefined, number[]]> = [
  ['no filter', undefined, []],
  ['a filter naming no size', {}, []],
  ['a list is de-duplicated and ascending', { bedroomSizes: [3, 2, 2, 0] }, [0, 2, 3]],
  ['4 and up clamp to the 4 chip, once', { bedroomSizes: [5, 12, 4, 1] }, [1, 4]],
  [
    'non-integers, negatives and non-numbers are dropped',
    { bedroomSizes: [2.5, '3', null, Number.NaN, Number.POSITIVE_INFINITY, -1, 2] },
    [2],
  ],
  ['an empty list is no size filter', { bedroomSizes: [] }, []],
  ['LEGACY: one number below 4 is a one-member list', { bedroomSize: 2 }, [2]],
  ['LEGACY: a studio (0) is a size', { bedroomSize: 0 }, [0]],
  ['LEGACY: 4 or more reads as the 4 chip', { bedroomSize: 7 }, [4]],
  ['LEGACY: a non-integer is no size', { bedroomSize: 2.5 }, []],
  ['LEGACY: a negative is no size', { bedroomSize: -1 }, []],
  ['a present list wins over the legacy number', { bedroomSizes: [1], bedroomSize: 3 }, [1]],
  ['a present EMPTY list wins too', { bedroomSizes: [], bedroomSize: 3 }, []],
  ['a list that is not an array is ignored: the legacy number is read', { bedroomSizes: 3, bedroomSize: 2 }, [2]],
];

describe('bedroomSizesOfFilter - the ONE reader of a filter voucher sizes (D12)', () => {
  it('the top chip is 4, meaning 4 or more', () => {
    expect(VOUCHER_CHIP_MAX).toBe(4);
  });

  it.each(SIZE_CASES)('%s', (_name, filter, expected) => {
    expect(bedroomSizesOfFilter(filter)).toEqual(expected);
  });

  it('reads a stored AudienceFilter of either shape (the type the resolver passes)', () => {
    const legacy: AudienceFilter = {
      contact_type: 'tenant',
      bedroomSize: 6,
      excludeOptedOut: true,
      excludeUnreachable: true,
    };
    const listed: AudienceFilter = {
      contact_type: 'tenant',
      bedroomSizes: [3, 2],
      excludeOptedOut: true,
      excludeUnreachable: true,
    };
    expect(bedroomSizesOfFilter(legacy)).toEqual([4]);
    expect(bedroomSizesOfFilter(listed)).toEqual([2, 3]);
  });
});

describe('voucherSizeMatches - any-of, the 4 chip is 4 or more (D12)', () => {
  const cases: Array<[number[], number | undefined, boolean]> = [
    [[], undefined, true],
    [[], 7, true],
    [[2], 2, true],
    [[2], 3, false],
    [[2], undefined, false],
    [[0], 0, true],
    [[0], 1, false],
    [[4], 3, false],
    [[4], 4, true],
    [[4], 5, true],
    [[4], 12, true],
    [[2, 4], 2, true],
    [[2, 4], 3, false],
    [[2, 4], 6, true],
    [[1, 3], 4, false],
  ];
  it.each(cases)('sizes %j, tenant voucher size %s -> %s', (sizes, tenantSize, expected) => {
    expect(voucherSizeMatches(sizes, tenantSize)).toBe(expected);
  });
});

describe('wireAudienceFilter - the filter shape every response carries (D2)', () => {
  it('a LEGACY row answers housing_authorities and never housing_authority; its one size reads as a list (D12); booleans pass through as stored', () => {
    const legacy: AudienceFilter = {
      contact_type: 'tenant',
      housing_authority: 'Atlanta Housing Authority',
      bedroomSize: 2,
      excludeOptedOut: true,
      excludeUnreachable: false,
    };
    const wire = wireAudienceFilter(legacy);
    expect(wire).toEqual({
      contact_type: 'tenant',
      housing_authorities: ['Atlanta Housing Authority'],
      bedroomSizes: [2],
      bedroomSize: 2,
      excludeOptedOut: true,
      excludeUnreachable: false,
    });
    expect(wire).not.toHaveProperty('housing_authority');
  });

  it('a list row answers its normalized list', () => {
    const listed: AudienceFilter = {
      contact_type: 'tenant',
      housing_authorities: ['DeKalb County Housing Authority', ' Decatur Housing Authority '],
      excludeOptedOut: true,
      excludeUnreachable: true,
    };
    expect(wireAudienceFilter(listed)).toEqual({
      contact_type: 'tenant',
      housing_authorities: ['DeKalb County Housing Authority', 'Decatur Housing Authority'],
      bedroomSizes: [],
      excludeOptedOut: true,
      excludeUnreachable: true,
    });
  });

  it('no authority (absent, or an empty list) and no size: no housing_authorities, bedroomSizes [] and no compat bedroomSize (D12)', () => {
    const filters: AudienceFilter[] = [
      { contact_type: 'tenant', excludeOptedOut: true, excludeUnreachable: true },
      { contact_type: 'tenant', housing_authorities: [], excludeOptedOut: true, excludeUnreachable: true },
    ];
    for (const filter of filters) {
      const wire = wireAudienceFilter(filter);
      expect(wire).toEqual({ contact_type: 'tenant', bedroomSizes: [], excludeOptedOut: true, excludeUnreachable: true });
      expect(wire).not.toHaveProperty('housing_authorities');
      expect(wire).not.toHaveProperty('bedroomSize');
    }
  });

  it('D12: a bedroomSizes row answers its normalized list and its FIRST size as the compat bedroomSize', () => {
    const listed: AudienceFilter = {
      contact_type: 'tenant',
      bedroomSizes: [3, 2, 6],
      excludeOptedOut: true,
      excludeUnreachable: true,
    };
    expect(wireAudienceFilter(listed)).toEqual({
      contact_type: 'tenant',
      bedroomSizes: [2, 3, 4],
      bedroomSize: 2,
      excludeOptedOut: true,
      excludeUnreachable: true,
    });
  });

  it('D12: a LEGACY size of 4 or more answers the 4 chip in both keys', () => {
    const legacy: AudienceFilter = {
      contact_type: 'tenant',
      bedroomSize: 7,
      excludeOptedOut: true,
      excludeUnreachable: true,
    };
    expect(wireAudienceFilter(legacy)).toEqual({
      contact_type: 'tenant',
      bedroomSizes: [4],
      bedroomSize: 4,
      excludeOptedOut: true,
      excludeUnreachable: true,
    });
  });
});

describe('tourHoldOf - the D4 table for ONE tour', () => {
  const cases: Array<[string, TourHoldInput, TourHold | undefined]> = [
    [
      'scheduled later than now -> upcoming, dated by scheduledAt',
      tour({ status: 'scheduled', scheduledAt: AT_FUTURE }),
      { kind: 'upcoming', tourId: 'tour-1', at: AT_FUTURE },
    ],
    [
      'scheduled 1 ms after now -> upcoming (boundary)',
      tour({ status: 'scheduled', scheduledAt: iso(NOW + 1) }),
      { kind: 'upcoming', tourId: 'tour-1', at: iso(NOW + 1) },
    ],
    [
      'scheduled at exactly now -> not_marked (boundary)',
      tour({ status: 'scheduled', scheduledAt: NOW_ISO }),
      { kind: 'not_marked', tourId: 'tour-1', at: NOW_ISO },
    ],
    [
      'scheduled in the past -> not_marked, dated',
      tour({ status: 'scheduled', scheduledAt: AT_PAST }),
      { kind: 'not_marked', tourId: 'tour-1', at: AT_PAST },
    ],
    [
      'scheduled with no scheduledAt -> not_marked, no date',
      tour({ status: 'scheduled' }),
      { kind: 'not_marked', tourId: 'tour-1' },
    ],
    [
      'scheduled with an unreadable scheduledAt -> not_marked, no date',
      tour({ status: 'scheduled', scheduledAt: 'not-a-date' }),
      { kind: 'not_marked', tourId: 'tour-1' },
    ],
    [
      'toured + convertible (Move forward, no placement yet) -> needs_placement',
      tour({ status: 'toured', scheduledAt: AT_PAST, outcome: 'move_forward', convertible: true }),
      { kind: 'needs_placement', tourId: 'tour-1', at: AT_PAST },
    ],
    [
      'toured + convertible with no date -> needs_placement, no date',
      tour({ status: 'toured', convertible: true }),
      { kind: 'needs_placement', tourId: 'tour-1' },
    ],
    [
      'toured with no outcome -> needs_outcome',
      tour({ status: 'toured', scheduledAt: AT_PAST }),
      { kind: 'needs_outcome', tourId: 'tour-1', at: AT_PAST },
    ],
    [
      'toured with no outcome and convertible false -> needs_outcome',
      tour({ status: 'toured', scheduledAt: AT_PAST, convertible: false }),
      { kind: 'needs_outcome', tourId: 'tour-1', at: AT_PAST },
    ],
    [
      'toured with a null outcome -> needs_outcome (null is no outcome)',
      tour({ status: 'toured', outcome: null }),
      { kind: 'needs_outcome', tourId: 'tour-1' },
    ],
    [
      'toured with an outcome, not convertible (Not a fit left toured) -> no hold',
      tour({ status: 'toured', scheduledAt: AT_PAST, outcome: 'not_a_fit', convertible: false }),
      undefined,
    ],
    [
      'toured with outcome no_outcome -> no hold',
      tour({ status: 'toured', scheduledAt: AT_PAST, outcome: 'no_outcome' }),
      undefined,
    ],
    [
      'no_show -> no_show, dated',
      tour({ status: 'no_show', scheduledAt: AT_PAST }),
      { kind: 'no_show', tourId: 'tour-1', at: AT_PAST },
    ],
    [
      'no_show with no date -> no_show, no date',
      tour({ status: 'no_show' }),
      { kind: 'no_show', tourId: 'tour-1' },
    ],
    [
      'requested 1 hour old -> requested, dated by createdAt',
      tour({ status: 'requested', createdAt: iso(NOW - HOUR) }),
      { kind: 'requested', tourId: 'tour-1', at: iso(NOW - HOUR) },
    ],
    [
      'requested 1 ms short of 336 hours old -> requested (boundary)',
      tour({ status: 'requested', createdAt: iso(NOW - TOUR_REQUEST_HOLD_MS + 1) }),
      { kind: 'requested', tourId: 'tour-1', at: iso(NOW - TOUR_REQUEST_HOLD_MS + 1) },
    ],
    [
      'requested exactly 336 hours old -> no hold (boundary)',
      tour({ status: 'requested', createdAt: iso(NOW - TOUR_REQUEST_HOLD_MS) }),
      undefined,
    ],
    [
      'requested 20 days old -> no hold',
      tour({ status: 'requested', createdAt: iso(NOW - 20 * 24 * HOUR) }),
      undefined,
    ],
    [
      'requested with an unreadable createdAt -> no hold',
      tour({ status: 'requested', createdAt: 'nope' }),
      undefined,
    ],
    ['requested with no createdAt -> no hold', tour({ status: 'requested' }), undefined],
    ['canceled -> no hold', tour({ status: 'canceled', scheduledAt: AT_FUTURE }), undefined],
    [
      'closed (Not a fit) -> no hold',
      tour({ status: 'closed', scheduledAt: AT_PAST, outcome: 'not_a_fit' }),
      undefined,
    ],
    [
      'closed after a conversion (convertible) -> no hold',
      tour({ status: 'closed', scheduledAt: AT_PAST, outcome: 'move_forward', convertible: true }),
      undefined,
    ],
    ['an unknown status -> no hold', tour({ status: 'confirmed', scheduledAt: AT_FUTURE }), undefined],
  ];

  it.each(cases)('%s', (_name, input, expected) => {
    const hold = tourHoldOf(input, NOW);
    expect(hold).toEqual(expected);
    if (expected !== undefined && expected.at === undefined) expect(hold).not.toHaveProperty('at');
  });

  it('a stored TourItem is a TourHoldInput: toured + convertible with a PENDING conversion claim is needs_placement', () => {
    const claimed = storedTour({
      status: 'toured',
      scheduledAt: AT_PAST,
      outcome: 'move_forward',
      moveForward: true,
      convertible: true,
      convertedPlacementId: 'pending:3f1c2b',
      conversionClaimedAt: iso(NOW - HOUR),
    });
    expect(tourHoldOf(claimed, NOW)).toEqual({ kind: 'needs_placement', tourId: 'tour-1', at: AT_PAST });
  });
});

describe('pickTourHold - the ONE hold shown (D4 tie-break)', () => {
  it('no holds -> undefined', () => {
    expect(pickTourHold([])).toBeUndefined();
  });

  it('the kind order decides first: needs_placement, upcoming, needs_outcome, not_marked, no_show, requested', () => {
    const all: TourHold[] = [
      { kind: 'requested', tourId: 't-6', at: iso(NOW - HOUR) },
      { kind: 'no_show', tourId: 't-5', at: AT_PAST },
      { kind: 'not_marked', tourId: 't-4', at: AT_PAST },
      { kind: 'needs_outcome', tourId: 't-3', at: AT_PAST },
      { kind: 'upcoming', tourId: 't-2', at: AT_FUTURE },
      { kind: 'needs_placement', tourId: 't-1' },
    ];
    TOUR_HOLD_KIND_ORDER.forEach((kind, i) => {
      const remaining = all.filter((h) => TOUR_HOLD_KIND_ORDER.indexOf(h.kind) >= i);
      expect(pickTourHold(remaining)?.kind).toBe(kind);
    });
  });

  it('within upcoming the EARLIEST date wins', () => {
    const pick = pickTourHold([
      { kind: 'upcoming', tourId: 't-a', at: '2026-10-20T15:00:00.000Z' },
      { kind: 'upcoming', tourId: 't-b', at: '2026-10-18T15:00:00.000Z' },
      { kind: 'upcoming', tourId: 't-c', at: '2026-10-25T15:00:00.000Z' },
    ]);
    expect(pick?.tourId).toBe('t-b');
  });

  it('within every other kind the LATEST date wins', () => {
    const kinds: TourHoldKind[] = ['needs_placement', 'needs_outcome', 'not_marked', 'no_show', 'requested'];
    for (const kind of kinds) {
      const pick = pickTourHold([
        { kind, tourId: 't-early', at: '2026-10-01T15:00:00.000Z' },
        { kind, tourId: 't-late', at: '2026-10-09T15:00:00.000Z' },
      ]);
      expect(pick?.tourId, kind).toBe('t-late');
    }
  });

  it('a hold with no date loses to a dated hold of the same kind, whichever comes first', () => {
    expect(
      pickTourHold([
        { kind: 'needs_placement', tourId: 't-a' },
        { kind: 'needs_placement', tourId: 't-b', at: '2026-10-01T15:00:00.000Z' },
      ])?.tourId,
    ).toBe('t-b');
    expect(
      pickTourHold([
        { kind: 'not_marked', tourId: 't-b', at: '2026-10-01T15:00:00.000Z' },
        { kind: 'not_marked', tourId: 't-a' },
      ])?.tourId,
    ).toBe('t-b');
  });

  it('dates compare as INSTANTS, not as strings', () => {
    // 2026-10-09T23:00-05:00 is 2026-10-10T04:00Z - LATER than 01:00Z, though
    // its string sorts first.
    const pick = pickTourHold([
      { kind: 'not_marked', tourId: 't-a', at: '2026-10-10T01:00:00.000Z' },
      { kind: 'not_marked', tourId: 't-b', at: '2026-10-09T23:00:00.000-05:00' },
    ]);
    expect(pick?.tourId).toBe('t-b');
  });

  it('a tie (same date, or both undated) goes to the lower tourId', () => {
    expect(
      pickTourHold([
        { kind: 'no_show', tourId: 't-b', at: AT_PAST },
        { kind: 'no_show', tourId: 't-a', at: AT_PAST },
      ])?.tourId,
    ).toBe('t-a');
    expect(
      pickTourHold([
        { kind: 'not_marked', tourId: 't-b' },
        { kind: 'not_marked', tourId: 't-a' },
      ])?.tourId,
    ).toBe('t-a');
    expect(
      pickTourHold([
        { kind: 'upcoming', tourId: 't-b', at: AT_FUTURE },
        { kind: 'upcoming', tourId: 't-a', at: AT_FUTURE },
      ])?.tourId,
    ).toBe('t-a');
  });
});

describe('tourHoldsByTenant - one picked hold per tenant (D4)', () => {
  it('groups by the tour tenantId and keeps ONE hold each; a tenant with only resolved tours is absent', () => {
    const tours: TourHoldInput[] = [
      tour({ tourId: 't-1', tenantId: 'c-ana', status: 'requested', createdAt: iso(NOW - HOUR) }),
      tour({ tourId: 't-2', tenantId: 'c-ana', status: 'scheduled', scheduledAt: AT_FUTURE }),
      tour({ tourId: 't-3', tenantId: 'c-bo', status: 'closed', outcome: 'not_a_fit' }),
      tour({ tourId: 't-4', tenantId: 'c-bo', status: 'requested', createdAt: iso(NOW - TOUR_REQUEST_HOLD_MS) }),
      tour({ tourId: 't-5', tenantId: 'c-cy', status: 'no_show', scheduledAt: AT_PAST }),
      tour({ tourId: 't-6', tenantId: '', status: 'no_show', scheduledAt: AT_PAST }),
    ];
    const holds = tourHoldsByTenant(tours, NOW);
    expect([...holds.keys()].sort()).toEqual(['c-ana', 'c-cy']);
    expect(holds.get('c-ana')).toEqual({ kind: 'upcoming', tourId: 't-2', at: AT_FUTURE });
    expect(holds.get('c-cy')).toEqual({ kind: 'no_show', tourId: 't-5', at: AT_PAST });
  });

  it('keys on the tour tenantId with no assumption about the contact type (an older tour may name a caseworker)', () => {
    const tours: TourItem[] = [
      storedTour({ tourId: 't-p', tenantId: 'contact-partner-7', status: 'scheduled', scheduledAt: AT_FUTURE }),
    ];
    expect(tourHoldsByTenant(tours, NOW).get('contact-partner-7')).toEqual({
      kind: 'upcoming',
      tourId: 't-p',
      at: AT_FUTURE,
    });
  });
});

describe('checkedByDefault - the ONE default-checked rule (D5)', () => {
  const NONE: DefaultCheckFlags = { hasConsent: true, seeded: false, alreadySent: false, declined: false, held: false };

  it('a consented filter row with no flag starts checked', () => {
    expect(checkedByDefault(NONE)).toBe(true);
  });

  it('already sent, declined and held each leave a filter row unchecked', () => {
    expect(checkedByDefault({ ...NONE, alreadySent: true })).toBe(false);
    expect(checkedByDefault({ ...NONE, declined: true })).toBe(false);
    expect(checkedByDefault({ ...NONE, held: true })).toBe(false);
  });

  it('a hand pick (seed) starts checked whatever its flags', () => {
    expect(checkedByDefault({ ...NONE, seeded: true, alreadySent: true, declined: true, held: true })).toBe(true);
  });

  it('a row without recorded consent is never checked, seed or not', () => {
    expect(checkedByDefault({ ...NONE, hasConsent: false })).toBe(false);
    expect(checkedByDefault({ ...NONE, hasConsent: false, seeded: true })).toBe(false);
  });

  it('all 32 flag combinations: checked exactly when consent and (seeded, or no flag at all)', () => {
    const bools = [false, true];
    for (const hasConsent of bools)
      for (const seeded of bools)
        for (const alreadySent of bools)
          for (const declined of bools)
            for (const held of bools) {
              const flags: DefaultCheckFlags = { hasConsent, seeded, alreadySent, declined, held };
              const expected = hasConsent && (seeded || (!alreadySent && !declined && !held));
              expect(checkedByDefault(flags), JSON.stringify(flags)).toBe(expected);
            }
  });
});
