// WP1 B2a S3.9 (spec D13; charter 10.3): sha256 over a STABLE serialization
// (object keys sorted at every depth, array order kept, undefined dropped).
// unitCard covers the property card as sent. pairHistory covers the declined
// record and the tours, never the sends or the days since. tenantCard covers
// the card's own fields WITHOUT notes and propertiesSeen, the Notes box text
// as stored, and - for each seen home with a STORED outcome (a decline or a
// tour), sorted by unitId - its unitId, label, card fingerprint, decline and
// tours. Pure.
import { describe, expect, it } from 'vitest';
import {
  pairHistoryFingerprint,
  sha256Hex,
  stableStringify,
  tenantCardFingerprint,
  unitCardFingerprint,
} from '../src/services/ranking/fingerprints.js';
import type { SeenHome } from '../src/services/ranking/seenSet.js';
import { daysAgo } from './helpers/rankingFixtures.js';

function home(unitId: string, extra: Partial<SeenHome> = {}): SeenHome {
  return {
    unitId,
    unit: null,
    label: `${unitId} Main St, Decatur`,
    attachLabel: `${unitId} Main St, Decatur`,
    sends: [{ at: daysAgo(3), kind: 'sent' }],
    lastSendAt: daysAgo(3),
    declined: null,
    tours: [],
    activityAt: daysAgo(3),
    ...extra,
  };
}

const CARD = { firstName: 'Pat', voucherSize: 2, notes: 'arranged lines', propertiesSeen: [{ home: 'u1' }], lastHeardFrom: 'this week' };
const HOME_FP = (unitId: string): string => `fp-${unitId}`;

describe('stableStringify and sha256Hex', () => {
  it('sorts object keys at every depth, keeps array order, drops undefined', () => {
    expect(stableStringify({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: undefined } })).toBe('{"a":{"d":[2,{"x":2,"y":1}]},"b":1}');
    expect(stableStringify([undefined, 'x', null])).toBe('[null,"x",null]');
    expect(stableStringify(null)).toBe('null');
  });

  it('hashes to 64 hex characters', () => {
    expect(sha256Hex('abc')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('unitCardFingerprint - the property card as sent', () => {
  it('is the same for the same card in any key order and changes with any value', () => {
    expect(unitCardFingerprint({ rent_min: 1400, beds: 2 })).toBe(unitCardFingerprint({ beds: 2, rent_min: 1400 }));
    expect(unitCardFingerprint({ rent_min: 1400, beds: 2 })).not.toBe(unitCardFingerprint({ rent_min: 1450, beds: 2 }));
  });
});

describe('pairHistoryFingerprint - the decline and the tours, never the sends', () => {
  it('ignores sends and days since the last send', () => {
    const base = { sends: [], declined: null, tours: [], daysSinceLastSend: null };
    const sent = { sends: [{ at: daysAgo(1), kind: 'sent' as const }], declined: null, tours: [], daysSinceLastSend: 1 };
    expect(pairHistoryFingerprint(sent)).toBe(pairHistoryFingerprint(base));
  });

  it('changes with a decline or a tour', () => {
    const base = pairHistoryFingerprint({ declined: null, tours: [] });
    expect(pairHistoryFingerprint({ declined: { by: 'staff', at: daysAgo(1) }, tours: [] })).not.toBe(base);
    expect(pairHistoryFingerprint({ declined: null, tours: [{ status: 'requested', outcome: null, scheduledAt: null }] })).not.toBe(base);
  });
});

describe('tenantCardFingerprint (spec D13)', () => {
  const fp = (input: Partial<Parameters<typeof tenantCardFingerprint>[0]> = {}): string =>
    tenantCardFingerprint({ card: CARD, notesText: 'raw box', seen: [], homeCardFingerprint: HOME_FP, ...input });

  it("ignores the card's arranged notes and propertiesSeen", () => {
    expect(fp({ card: { ...CARD, notes: 'other arrangement', propertiesSeen: [] } })).toBe(fp());
  });

  it('covers the card fields and the Notes box text as stored', () => {
    expect(fp({ card: { ...CARD, voucherSize: 3 } })).not.toBe(fp());
    expect(fp({ notesText: 'raw box plus a line' })).not.toBe(fp());
    expect(fp({ notesText: undefined })).toBe(fp({ notesText: '' }));
  });

  it('covers only seen homes with a stored outcome, consulting only their card fingerprints', () => {
    const asked: string[] = [];
    const spy = (unitId: string): string => {
      asked.push(unitId);
      return HOME_FP(unitId);
    };
    const withBare = fp({ seen: [home('u1')], homeCardFingerprint: spy });
    expect(withBare).toBe(fp());
    expect(asked).toEqual([]);
    const withDecline = fp({ seen: [home('u1'), home('u2', { declined: { by: 'staff', at: daysAgo(2) } })], homeCardFingerprint: spy });
    expect(withDecline).not.toBe(fp());
    expect(asked).toEqual(['u2']);
  });

  it('a seen home with a tour counts; its card fingerprint and label count; the input order does not', () => {
    const toured = home('u3', { tours: [{ status: 'toured', outcome: null, scheduledAt: daysAgo(1) }] });
    const declined = home('u2', { declined: { by: 'staff', at: daysAgo(2) } });
    const a = fp({ seen: [toured, declined] });
    expect(fp({ seen: [declined, toured] })).toBe(a);
    expect(a).not.toBe(fp({ seen: [declined] }));
    expect(fp({ seen: [toured, declined], homeCardFingerprint: (unitId) => (unitId === 'u3' ? 'edited' : HOME_FP(unitId)) })).not.toBe(a);
    expect(fp({ seen: [{ ...toured, label: 'renamed' }, declined] })).not.toBe(a);
  });

  it('ignores sends and activity of an outcome home', () => {
    const declined = home('u2', { declined: { by: 'staff', at: daysAgo(2) } });
    const resent = { ...declined, sends: [...declined.sends, { at: daysAgo(0), kind: 'sent' as const }], lastSendAt: daysAgo(0), activityAt: daysAgo(0) };
    expect(fp({ seen: [resent] })).toBe(fp({ seen: [declined] }));
  });
});
