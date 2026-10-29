// WP1 B2a S3.10 (spec D13; charter 10.3, 13.5; plan WI11, WI12): every
// fingerprint invariant as a named test, through the REAL pipeline
// (buildTenantSide: the seen set, the attach step, the bound, tenantCard,
// propertyCard for each seen home, the fingerprint) from raw rows. A bare
// send, a re-send that re-orders, a ninth send that pushes an entry off the
// listed ones, the first send of a home a Notes line already names, a tour
// reminder or roster change, and an edit to a home with feedback only change
// NO fingerprint; a decline, a tour, a feedback line on any property, and an
// edit to any card field of a seen home with a decline or tour change the
// tenant fingerprint. Pure.
import { describe, expect, it } from 'vitest';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { ListingSendItem } from '../src/repos/listingSendsRepo.js';
import type { TourItem } from '../src/repos/toursRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { buildPropertySide, buildTenantSide, type SideCtx, type TenantReads } from '../src/services/ranking/assemble.js';
import { listedHomeIds, propertyCard, propertyFacts, tenantCard } from '../src/services/ranking/cards.js';
import { propertyMissing, tenantMissing } from '../src/services/ranking/completeness.js';
import { pairHistoryFingerprint, unitCardFingerprint } from '../src/services/ranking/fingerprints.js';
import { pairHistoryOf } from '../src/services/ranking/pairHistory.js';
import { NOW, ORG_ENTRIES, daysAgo, sendRow, tenant, tourRow, unit } from './helpers/rankingFixtures.js';

const CTX: SideCtx = { now: NOW, seenMax: 8, orgEntries: ORG_ENTRIES, landlordCard: false };
const UNITS: UnitItem[] = Array.from({ length: 10 }, (_, i) => unit(`u${i + 1}`));
const T = tenant('t1', { notes: 'Works nights' });

// The base world: u1 sent (bare), u2 sent and declined, u3 toured.
const BASE_SENDS: ListingSendItem[] = [
  sendRow('u1', 't1', [{ at: daysAgo(10) }]),
  sendRow('u2', 't1', [{ at: daysAgo(12) }], { declined: { at: daysAgo(11), by: 'staff' } }),
];
const BASE_TOURS: TourItem[] = [tourRow('tour-3', 't1', 'u3', { createdAt: daysAgo(6), scheduledAt: daysAgo(2), status: 'toured' })];

function reads(over: { sends?: ListingSendItem[]; tours?: TourItem[]; units?: UnitItem[] } = {}): TenantReads {
  const units = over.units ?? UNITS;
  return {
    sends: over.sends ?? BASE_SENDS,
    tours: over.tours ?? BASE_TOURS,
    units: new Map(units.map((u) => [u.unitId, u])),
    landlords: new Map(),
  };
}

function side(r: TenantReads, contact: ContactItem = T) {
  return buildTenantSide(contact, r, CTX);
}

function pairFp(r: TenantReads, unitId: string, contact: ContactItem = T): string {
  return pairHistoryFingerprint(pairHistoryOf(side(r, contact).seen.find((home) => home.unitId === unitId), NOW));
}

function withUnit(id: string, extra: Partial<UnitItem>): UnitItem[] {
  return UNITS.map((u) => (u.unitId === id ? { ...u, ...extra } : u));
}

describe('the sides (WI12: tenantCard and propertyCard are the only card builders)', () => {
  it('buildPropertySide is propertyCard, propertyMissing, propertyFacts and the card fingerprint', () => {
    const ctx = { orgEntries: ORG_ENTRIES, landlordCard: false };
    const u1 = UNITS[0] as UnitItem;
    expect(buildPropertySide(u1, ctx)).toEqual({
      card: propertyCard(u1, ctx),
      missing: propertyMissing(u1, ctx),
      facts: propertyFacts(u1, ctx),
      fingerprint: unitCardFingerprint(propertyCard(u1, ctx)),
    });
  });

  it('buildTenantSide is tenantCard over the seen set, the tenant gaps, and each LISTED home with its full card', () => {
    const s = side(reads());
    expect(s.card).toEqual(tenantCard(T, { now: NOW, seenMax: 8, seen: s.seen }));
    expect(s.missing).toEqual(tenantMissing(T));
    expect([...s.homes.keys()]).toEqual(listedHomeIds(s.card));
    expect(s.homes.get('u2')).toEqual({ label: 'u2 Main St, Decatur', card: propertyCard(UNITS[1] as UnitItem, CTX) });
  });
});

describe('WI11: what changes NO fingerprint', () => {
  it('WI11: a bare send changes no fingerprint', () => {
    const before = reads();
    const after = reads({ sends: [...BASE_SENDS, sendRow('u4', 't1', [{ at: daysAgo(1) }])] });
    expect(side(after).fingerprint).toBe(side(before).fingerprint);
    for (const unitId of ['u1', 'u2', 'u3', 'u4']) expect(pairFp(after, unitId)).toBe(pairFp(before, unitId));
  });

  it('WI11: a re-send that re-orders the listed entries changes no fingerprint', () => {
    const bare5 = sendRow('u5', 't1', [{ at: daysAgo(5) }]);
    const before = reads({ sends: [...BASE_SENDS, bare5] });
    const resentU1 = sendRow('u1', 't1', [{ at: daysAgo(10) }, { at: daysAgo(0.5) }]);
    const after = reads({ sends: [resentU1, ...BASE_SENDS.slice(1), bare5] });
    expect(listedHomeIds(side(before).card)).toEqual(['u3', 'u2', 'u5', 'u1']);
    expect(listedHomeIds(side(after).card)).toEqual(['u3', 'u2', 'u1', 'u5']);
    expect(side(after).fingerprint).toBe(side(before).fingerprint);
    expect(pairFp(after, 'u1')).toBe(pairFp(before, 'u1'));
  });

  it('WI11: a ninth send that pushes an entry off the listed ones changes no fingerprint', () => {
    const eight = [...BASE_SENDS, ...[4, 5, 6, 7, 8].map((n) => sendRow(`u${n}`, 't1', [{ at: daysAgo(13 - n) }]))];
    const before = reads({ sends: eight });
    const after = reads({ sends: [...eight, sendRow('u9', 't1', [{ at: daysAgo(0.1) }])] });
    expect(listedHomeIds(side(before).card)).toContain('u1');
    expect(listedHomeIds(side(after).card)).not.toContain('u1');
    expect(listedHomeIds(side(after).card)).toHaveLength(8);
    expect(side(after).fingerprint).toBe(side(before).fingerprint);
  });

  it('WI11: the first send of a home a Notes line already names changes no fingerprint', () => {
    const line = '[Auto - Oct 20] u6 Main St, Decatur: liked the porch';
    const named = tenant('t1', { notes: `Works nights\n${line}` });
    const before = reads();
    const after = reads({ sends: [...BASE_SENDS, sendRow('u6', 't1', [{ at: daysAgo(1) }])] });
    expect(side(before, named).card['notes']).toBe(`Works nights\n${line}`);
    expect(side(after, named).card['notes']).toBe('Works nights');
    expect(side(after, named).fingerprint).toBe(side(before, named).fingerprint);
    expect(pairFp(after, 'u6', named)).toBe(pairFp(before, 'u6', named));
  });

  it('WI11: a tour reminder or roster change changes no fingerprint', () => {
    const changed = BASE_TOURS.map((tour) => ({
      ...tour,
      roster: [],
      rosterVersion: 2,
      currentLadderId: 'ladder-2',
      groupThreadId: 'conv-9',
      lastMarkedAt: daysAgo(0),
      updatedAt: daysAgo(0),
    }));
    const after = reads({ tours: changed });
    expect(side(after).fingerprint).toBe(side(reads()).fingerprint);
    expect(pairFp(after, 'u3')).toBe(pairFp(reads(), 'u3'));
  });

  it('WI11: an edit to a home with feedback only changes no fingerprint', () => {
    const named = tenant('t1', { notes: 'Works nights\nu1 Main St, Decatur: too far from the bus' });
    const edited = withUnit('u1', { rent_min: 1900 });
    expect(unitCardFingerprint(propertyCard(edited[0] as UnitItem, CTX))).not.toBe(unitCardFingerprint(propertyCard(UNITS[0] as UnitItem, CTX)));
    expect(side(reads({ units: edited }), named).fingerprint).toBe(side(reads(), named).fingerprint);
  });

  it('recency enters only as its bucket', () => {
    const inBucket = tenant('t1', { notes: 'Works nights', last_heard_from_at: daysAgo(5) });
    const nextBucket = tenant('t1', { notes: 'Works nights', last_heard_from_at: daysAgo(10) });
    expect(side(reads(), inBucket).fingerprint).toBe(side(reads()).fingerprint);
    expect(side(reads(), nextBucket).fingerprint).not.toBe(side(reads()).fingerprint);
  });
});

describe('WI11: what changes the tenant fingerprint', () => {
  it('WI11: a decline changes the tenant fingerprint (and that pair only)', () => {
    const after = reads({ sends: [sendRow('u1', 't1', [{ at: daysAgo(10) }], { declined: { at: daysAgo(1), by: 'staff' } }), ...BASE_SENDS.slice(1)] });
    expect(side(after).fingerprint).not.toBe(side(reads()).fingerprint);
    expect(pairFp(after, 'u1')).not.toBe(pairFp(reads(), 'u1'));
    expect(pairFp(after, 'u2')).toBe(pairFp(reads(), 'u2'));
  });

  it('WI11: a tour changes the tenant fingerprint', () => {
    const after = reads({ tours: [...BASE_TOURS, tourRow('tour-1', 't1', 'u1', { status: 'requested', scheduledAt: undefined })] });
    expect(side(after).fingerprint).not.toBe(side(reads()).fingerprint);
    expect(pairFp(after, 'u1')).not.toBe(pairFp(reads(), 'u1'));
  });

  it('WI11: a feedback line on any property changes the tenant fingerprint', () => {
    const named = tenant('t1', { notes: 'Works nights\nu1 Main St, Decatur: too far from the bus' });
    expect(side(reads(), named).fingerprint).not.toBe(side(reads()).fingerprint);
  });

  it('WI11: an edit to any card field of a seen home with a decline or tour changes the tenant fingerprint', () => {
    expect(side(reads({ units: withUnit('u2', { notes: 'New roof' }) })).fingerprint).not.toBe(side(reads()).fingerprint);
    expect(side(reads({ units: withUnit('u3', { rent_max: 1999 }) })).fingerprint).not.toBe(side(reads()).fingerprint);
  });

  it("a change to the tenant's own card changes it", () => {
    expect(side(reads(), tenant('t1', { notes: 'Works nights', voucherSize: 3 })).fingerprint).not.toBe(side(reads()).fingerprint);
  });
});
