// Group identity (spec 4.1): the ONE function that turns a carrier-group
// envelope into {roster, conversationId}.
//
// GOLDEN VECTORS are the point of this suite. Group thread ids are uuidv5 over
// the sorted roster, so ANY change to the derivation - the namespace constant, a
// file move, a different join, a normalization tweak - silently re-mints every
// id and orphans every existing thread. The pinned literals below make that a
// test failure instead of a production data split.
//
// A5 (binding): the input set is the SPIKE's `From + To + OtherRecipients`, not
// the spec's `From + OtherRecipients`. Identical output in the healthy case
// (`To` is the business number, which the exclusion set removes) - and it makes
// a MISCONFIGURED exclusion list observable, because the business number then
// survives into the roster where we can alarm on it.
import { describe, expect, it } from 'vitest';
import { contactIdForPhone, conversationIdForGroup } from '../src/lib/import/ids.js';
import { createLogger } from '../src/lib/logger.js';
import { groupIdentity } from '../src/services/groupIdentity.js';
import { createLogCapture } from './helpers/logCapture.js';

const BUSINESS = '+15550009999';
const A = '+15550001111';
const B = '+15550002222';
const C = '+15550003333';

/** A correctly-configured exclusion set: business number, no pool, no extras. */
const healthy = { businessPhoneNumber: BUSINESS, poolNumbers: [], configuredNumbers: [] };

function withCapture() {
  const capture = createLogCapture();
  return { capture, logger: createLogger({ destination: capture.stream }) };
}

describe('golden vectors - id derivation must never move silently', () => {
  it('pins conversationIdForGroup outputs for known rosters', () => {
    expect(conversationIdForGroup([A, B])).toBe('01ad7d96-f99f-526b-b492-0eb6c3db207f');
    // Order-independent: the same group is the same thread whichever member
    // happens to send first.
    expect(conversationIdForGroup([B, A])).toBe('01ad7d96-f99f-526b-b492-0eb6c3db207f');
    expect(conversationIdForGroup([A, B, C])).toBe('0986dc9f-9377-5261-8518-5572731a4495');
    expect(conversationIdForGroup([A])).toBe('80565b87-96a8-57ea-977d-1e90a8d22590');
  });

  it('pins contactIdForPhone outputs (group member stubs key on this)', () => {
    expect(contactIdForPhone(A)).toBe('9c5978c4-e734-59c7-ae3e-f3bd228c9547');
    expect(contactIdForPhone('+442079460958')).toBe('5b6e0c2a-0182-5abf-9c4d-788ac9b3bfee');
  });

  it('derives the SAME id the importer derives for the same roster', () => {
    const { conversationId } = groupIdentity(A, BUSINESS, [B], healthy);
    // Invariant 13.5: imported and detected identity share one function AND one
    // exclusion set - the same carrier roster never yields two threads.
    expect(conversationId).toBe(conversationIdForGroup([A, B]));
    expect(conversationId).toBe('01ad7d96-f99f-526b-b492-0eb6c3db207f');
  });
});

describe('roster construction (A5: From + To + OtherRecipients, then exclude)', () => {
  it('includes the sender and the other recipients, sorted, and excludes our number', () => {
    const result = groupIdentity(C, BUSINESS, [A, B], healthy);
    expect(result.roster).toEqual([A, B, C]);
    expect(result.conversationId).toBe(conversationIdForGroup([A, B, C]));
    expect(result.collapsed).toBe(false);
  });

  it('matches the spec formula (From + OtherRecipients) whenever exclusion is healthy', () => {
    const withTo = groupIdentity(A, BUSINESS, [B, C], healthy);
    const specShape = conversationIdForGroup([A, B, C]);
    expect(withTo.conversationId).toBe(specShape);
    expect(withTo.roster).not.toContain(BUSINESS);
  });

  it('dedupes a member repeated across envelope positions', () => {
    const result = groupIdentity(A, BUSINESS, [B, A, B], healthy);
    expect(result.roster).toEqual([A, B]);
  });

  it('flags a COLLAPSED roster (<2 outside members) rather than deciding for the caller', () => {
    const result = groupIdentity(A, BUSINESS, [], healthy);
    expect(result.roster).toEqual([A]);
    expect(result.collapsed).toBe(true);
  });
});

describe('normalization is part of the contract', () => {
  it('normalizes every envelope position with normalizeToE164 before deriving', () => {
    const formatted = groupIdentity('(555) 000-1111', ' +1 555 000 9999 ', [
      '1-555-000-2222',
      '5550003333',
    ], healthy);
    expect(formatted.roster).toEqual([A, B, C]);
    expect(formatted.conversationId).toBe(conversationIdForGroup([A, B, C]));
    expect(formatted.unparseable).toEqual([]);
  });

  it('reports unparseable addresses instead of silently dropping them', () => {
    // Silently dropping a bad number would make a 3-person group derive the same
    // id as a genuine 2-person one (spec 5.3(c) corrupt-shape branch).
    const result = groupIdentity(A, BUSINESS, [B, 'Anonymous'], healthy);
    expect(result.unparseable).toEqual(['Anonymous']);
    expect(result.roster).toEqual([A, B]);
  });
});

describe('the exclusion set', () => {
  it('removes the configured org numbers (GROUP_IDENTITY_EXCLUDED_NUMBERS)', () => {
    const result = groupIdentity(A, BUSINESS, [B, C], {
      businessPhoneNumber: BUSINESS,
      poolNumbers: [],
      configuredNumbers: [C],
    });
    expect(result.roster).toEqual([A, B]);
  });

  it('normalizes the exclusion entries too (a formatted config value still excludes)', () => {
    const result = groupIdentity(A, '(555) 000-9999', [B, C], {
      businessPhoneNumber: BUSINESS,
      poolNumbers: [],
      configuredNumbers: ['555-000-3333'],
    });
    expect(result.roster).toEqual([A, B]);
  });

  it('removes pool numbers AND warns - a pool number in the outside-roster position is anomalous', () => {
    const { capture, logger } = withCapture();
    const pool = '+15550007777';
    const result = groupIdentity(A, BUSINESS, [B, pool], {
      businessPhoneNumber: BUSINESS,
      poolNumbers: [pool],
      configuredNumbers: [],
    }, { logger });

    expect(result.roster).toEqual([A, B]);
    expect(result.poolNumbersInEnvelope).toEqual([pool]);
    expect(capture.atLevel(40).some((l) => String(l['msg']).includes('pool number'))).toBe(true);
  });

  it('does NOT warn when a correctly-excluded org number appears (the steady state)', () => {
    const { capture, logger } = withCapture();
    groupIdentity(A, BUSINESS, [B, C], {
      businessPhoneNumber: BUSINESS,
      poolNumbers: [],
      configuredNumbers: [C],
    }, { logger });
    expect(capture.atLevel(40)).toEqual([]);
  });
});

describe('misconfigured exclusion is OBSERVABLE (A5)', () => {
  it('ERRORs when the business number survives exclusion, and says so in the result', () => {
    const { capture, logger } = withCapture();
    // The failure mode: config lost/renamed the business number, so nothing
    // subtracts it and every derived id silently gains a phantom member.
    const result = groupIdentity(A, BUSINESS, [B], {
      businessPhoneNumber: undefined,
      poolNumbers: [],
      configuredNumbers: [],
    }, { logger });

    expect(result.businessNumberSurvived).toBe(true);
    expect(result.roster).toContain(BUSINESS);
    const errors = capture.atLevel(50);
    expect(
      errors.some((l) => String(l['msg']).includes('business number survived group exclusion')),
    ).toBe(true);
  });

  it('is false and silent on a healthy exclusion set', () => {
    const { capture, logger } = withCapture();
    const result = groupIdentity(A, BUSINESS, [B], healthy, { logger });
    expect(result.businessNumberSurvived).toBe(false);
    expect(capture.atLevel(50)).toEqual([]);
  });

  it('never logs a phone number (doc 9)', () => {
    const { capture, logger } = withCapture();
    groupIdentity(A, BUSINESS, [B, '+15550007777'], {
      businessPhoneNumber: undefined,
      poolNumbers: ['+15550007777'],
      configuredNumbers: [],
    }, { logger });
    const serialized = JSON.stringify(capture.lines);
    for (const phone of [A, B, BUSINESS, '+15550007777']) {
      expect(serialized).not.toContain(phone);
    }
  });
});

describe('senderExcluded - the correctly-configured steady state (spec 4.1, r3 finding 9)', () => {
  const OFFICE_LINE = '+15550004444';

  it('is TRUE when the sender is one of the org numbers the exclusion set removes', () => {
    // The founder or staff texting one of their own groups from a second org
    // line. The roster is CORRECT - it is the two real members - and the sender
    // is correctly absent from it. The webhook's sender-not-on-roster ERROR
    // reads this flag so it does not alarm on a designed-for workflow.
    const result = groupIdentity(OFFICE_LINE, BUSINESS, [A, B], {
      businessPhoneNumber: BUSINESS,
      poolNumbers: [],
      configuredNumbers: [OFFICE_LINE],
    });

    expect(result.senderExcluded).toBe(true);
    expect(result.roster).toEqual([A, B].sort());
    expect(result.conversationId).toBe(conversationIdForGroup([A, B]));
  });

  it('is TRUE for a pool number in the sender position (also excluded)', () => {
    const POOL = '+15550005555';
    const result = groupIdentity(POOL, BUSINESS, [A, B], {
      businessPhoneNumber: BUSINESS,
      poolNumbers: [POOL],
      configuredNumbers: [],
    });
    expect(result.senderExcluded).toBe(true);
  });

  it('is FALSE for an ordinary member sender', () => {
    const result = groupIdentity(A, BUSINESS, [B, C], healthy);
    expect(result.senderExcluded).toBe(false);
    expect(result.roster).toContain(A);
  });
});
