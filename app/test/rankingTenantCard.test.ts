// WP1 B2a S3.7 (spec D2.1-D2.3; charter 6.2, 9.1; plan WI4): the tenant card.
// Included attributes in registry order, the matching inputs keyed by their
// list label, last heard from as a bucket, and propertiesSeen: entries with an
// outcome (a decline, a tour or a feedback line) first, newest activity
// first; bare sends fill the rest of RANKING_SEEN_MAX, newest send first. A
// line under a LISTED entry leaves the notes; an unlisted entry's lines come
// back. Pure.
import { describe, expect, it } from 'vitest';
import { FLYER_SHARE_KEY } from '../src/lib/shareLedgerKeys.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { ListingSendItem } from '../src/repos/listingSendsRepo.js';
import type { TourItem } from '../src/repos/toursRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { listedHomeIds, recencyBucket, tenantCard, type PropertiesSeenEntry } from '../src/services/ranking/cards.js';
import { MISSING_UNIT_LABEL, buildSeenSet } from '../src/services/ranking/seenSet.js';
import { ATLANTA } from './helpers/orgFixtures.js';
import { NOW, daysAgo, sendRow, tenant, tourRow, unit } from './helpers/rankingFixtures.js';

const T: ContactItem = {
  contactId: 't1',
  type: 'tenant',
  status: 'searching',
  firstName: ' Dana ',
  lastName: 'Example',
  voucherSize: 2,
  housingAuthority: ATLANTA.name,
  voucher_expiration_date: '2027-01-31T00:00:00.000Z',
  rta_expiration_date: '2026-12-01',
  porting: false,
  address: { line1: '5 Elm St', line2: '  ', city: 'Atlanta', state: 'GA', zip: '30310' },
  tenure: '3 years',
  pets: 'One cat',
  evictions: 'None',
  preferences_notes: 'Near MARTA',
  customFields: [{ value: '9', label: 'Shoe size' }],
  created_at: '2026-05-02T09:00:00.000Z',
  staff_notes: ' Call after 5 ',
  notes: 'Works nights\r\nWants a yard',
  area_preference: ' Decatur ',
  max_tenant_portion: 400,
  accessibility_need: 'Ground floor',
  preferences_constraints: 'No apartments',
  // Never on a card:
  phone: '+14045550111',
  phones: [{ phone: '+14045550111', primary: true }],
  email: 'dana@example.com',
  lifEligible: true,
  relationships: [{ contactId: 'c2', relation: 'sister' }],
  agency: 'Step Up',
  voucher_program: 'Mainstream',
  caseworker: 'contact-cw-1',
  consent_method: 'verbal_phone',
  sms_opt_out: false,
  status_source: 'derived',
  notes_updated_at: daysAgo(1),
  staff_notes_updated_at: daysAgo(2),
  last_heard_from_at: daysAgo(3),
  last_reached_out_at: daysAgo(1),
  imported_from: 'quo-airtable-import',
  unit_of_interest: 'u9',
  housing_fair_welcomed: true,
  move_in_date: '2026-12-01',
  area_preference_source: 'ai',
  zz_unclassified: 'never read',
};

const T_CARD = {
  firstName: 'Dana',
  lastName: 'Example',
  status: 'searching',
  voucherSize: 2,
  voucher_expiration_date: '2027-01-31T00:00:00.000Z',
  rta_expiration_date: '2026-12-01',
  porting: false,
  address: { line1: '5 Elm St', city: 'Atlanta', state: 'GA', zip: '30310' },
  tenure: '3 years',
  pets: 'One cat',
  evictions: 'None',
  preferences_notes: 'Near MARTA',
  customFields: [{ label: 'Shoe size', value: '9' }],
  created_at: '2026-05-02',
  staff_notes: 'Call after 5',
  notes: 'Works nights\r\nWants a yard',
  'Area preference': 'Decatur',
  'Maximum tenant portion': 400,
  'Accessibility need': 'Ground floor',
  'Preferences and constraints': 'No apartments',
  lastHeardFrom: 'this week',
  propertiesSeen: [],
};

function seenOf(sends: ListingSendItem[], tours: TourItem[], units: UnitItem[]) {
  return buildSeenSet({ sends, tours, units: new Map(units.map((u) => [u.unitId, u])) });
}

function entries(card: Record<string, unknown>): PropertiesSeenEntry[] {
  return card['propertiesSeen'] as PropertiesSeenEntry[];
}

describe('tenantCard - the attributes (spec D2.1)', () => {
  it('copies the included attributes in registry order, the matching inputs under their labels, nothing else (WI4)', () => {
    const card = tenantCard(T, { now: NOW, seenMax: 8, seen: [] });
    expect(card).toEqual(T_CARD);
    expect(Object.keys(card)).toEqual(Object.keys(T_CARD));
    // Charter section 20 item 18: the record holds an authority; the card never does.
    expect(T['housingAuthority']).toBe(ATLANTA.name);
    expect(card).not.toHaveProperty('housingAuthority');
    expect(card).not.toHaveProperty('notes_updated_at');
  });

  it('leaves off notes the box does not hold', () => {
    expect(tenantCard(tenant('t2'), { now: NOW, seenMax: 8, seen: [] })).not.toHaveProperty('notes');
  });

  it('keeps unmoved Notes text as stored, trimmed - line breaks and blank lines included (FB21)', () => {
    const card = tenantCard(tenant('t2', { notes: '  Works nights\r\n\r\nWants a yard  ' }), { now: NOW, seenMax: 8, seen: [] });
    expect(card['notes']).toBe('Works nights\r\n\r\nWants a yard');
  });
});

describe('recencyBucket - last heard from enters only as its bucket (charter 9.1)', () => {
  it('this week under 7 days, this month under 30, one to three months under 90, then older; never', () => {
    expect(recencyBucket(daysAgo(0), NOW)).toBe('this week');
    expect(recencyBucket(daysAgo(6.9), NOW)).toBe('this week');
    expect(recencyBucket(daysAgo(7), NOW)).toBe('this month');
    expect(recencyBucket(daysAgo(29.9), NOW)).toBe('this month');
    expect(recencyBucket(daysAgo(30), NOW)).toBe('one to three months');
    expect(recencyBucket(daysAgo(89.9), NOW)).toBe('one to three months');
    expect(recencyBucket(daysAgo(90), NOW)).toBe('older');
    expect(recencyBucket(undefined, NOW)).toBe('never');
    expect(recencyBucket('not a date', NOW)).toBe('never');
  });
});

describe('propertiesSeen - the bound and the order (spec D2.3)', () => {
  const UNITS = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'].map((id) => unit(id));
  const SENDS = [
    sendRow('u1', 't1', [{ at: daysAgo(1) }]),
    sendRow('u2', 't1', [{ at: daysAgo(5) }]),
    sendRow('u3', 't1', [{ at: daysAgo(9) }]),
    sendRow('u4', 't1', [{ at: daysAgo(30) }], { declined: { at: daysAgo(20), by: 'staff' } }),
    sendRow('u6', 't1', [{ at: daysAgo(40) }]),
  ];
  const TOURS = [tourRow('tour-5', 't1', 'u5', { createdAt: daysAgo(4), scheduledAt: daysAgo(2), status: 'toured' })];
  const LINE = '[Auto - Oct 1] u6 Main St, Decatur: kitchen too small';
  const CONTACT = tenant('t1', { notes: `Works nights\n${LINE}` });
  const SEEN = seenOf(SENDS, TOURS, UNITS);

  it('outcome entries first, newest activity first; a feedback line moves under its listed home', () => {
    const card = tenantCard(CONTACT, { now: NOW, seenMax: 3, seen: SEEN });
    expect(listedHomeIds(card)).toEqual(['u5', 'u4', 'u6']);
    expect(card['notes']).toBe('Works nights');
    expect(entries(card)).toEqual([
      {
        home: 'u5',
        label: 'u5 Main St, Decatur',
        sends: [],
        daysSinceLastSend: null,
        declined: null,
        tours: [{ status: 'toured', outcome: null, scheduledAt: daysAgo(2) }],
        feedback: [],
      },
      {
        home: 'u4',
        label: 'u4 Main St, Decatur',
        sends: [{ at: daysAgo(30), kind: 'sent' }],
        daysSinceLastSend: 30,
        declined: { by: 'staff', at: daysAgo(20) },
        tours: [],
        feedback: [],
      },
      {
        home: 'u6',
        label: 'u6 Main St, Decatur',
        sends: [{ at: daysAgo(40), kind: 'sent' }],
        daysSinceLastSend: 40,
        declined: null,
        tours: [],
        feedback: [LINE],
      },
    ]);
  });

  it('an outcome entry past the bound is not listed and its feedback goes back into the notes', () => {
    const card = tenantCard(CONTACT, { now: NOW, seenMax: 2, seen: SEEN });
    expect(listedHomeIds(card)).toEqual(['u5', 'u4']);
    expect(card['notes']).toBe(`Works nights\n${LINE}`);
  });

  it('bare sends fill the remaining slots, newest send first', () => {
    expect(listedHomeIds(tenantCard(CONTACT, { now: NOW, seenMax: 5, seen: SEEN }))).toEqual(['u5', 'u4', 'u6', 'u1', 'u2']);
  });

  it('a line naming an unlisted bare property still attaches, and lists it', () => {
    const seen = seenOf([sendRow('u1', 't1', [{ at: daysAgo(1) }]), sendRow('u3', 't1', [{ at: daysAgo(9) }])], [], UNITS);
    expect(listedHomeIds(tenantCard(tenant('t1'), { now: NOW, seenMax: 1, seen }))).toEqual(['u1']);
    const named = tenant('t1', { notes: 'u3 Main St, Decatur: wants to see it again' });
    const card = tenantCard(named, { now: NOW, seenMax: 1, seen });
    expect(listedHomeIds(card)).toEqual(['u3']);
    expect(entries(card)[0]?.feedback).toEqual(['u3 Main St, Decatur: wants to see it again']);
    expect(card).not.toHaveProperty('notes');
  });

  it('tells a flyer sign-up from a send', () => {
    const seen = seenOf([sendRow('u7', 't1', [{ at: daysAgo(6) }, { at: daysAgo(2), key: FLYER_SHARE_KEY }])], [], [unit('u7')]);
    expect(entries(tenantCard(tenant('t1'), { now: NOW, seenMax: 8, seen }))[0]?.sends).toEqual([
      { at: daysAgo(6), kind: 'sent' },
      { at: daysAgo(2), kind: 'signed_up' },
    ]);
  });

  it('lists a soft-deleted home with its label; a home a complete read did not find under the placeholder, its lines left in the notes', () => {
    const seen = seenOf(
      [sendRow('u1', 't1', [{ at: daysAgo(3) }]), sendRow('u8', 't1', [{ at: daysAgo(4) }])],
      [],
      [unit('u1', { deleted_at: daysAgo(1) })],
    );
    const card = tenantCard(tenant('t1', { notes: 'u8 Main St, Decatur: liked it' }), { now: NOW, seenMax: 8, seen });
    expect(entries(card).map((entry) => [entry.home, entry.label])).toEqual([
      ['u1', 'u1 Main St, Decatur'],
      ['u8', MISSING_UNIT_LABEL],
    ]);
    expect(entries(card)[1]?.sends).toEqual([{ at: daysAgo(4), kind: 'sent' }]);
    expect(card['notes']).toBe('u8 Main St, Decatur: liked it');
  });
});
