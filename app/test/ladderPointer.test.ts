// The generation-pointer comparison, all four cells (supersession 2026-09-01).
//
// Pure and tiny on purpose: four call sites share it (the poll, and the three
// preview surfaces in S6), and the whole feature's safety rests on them
// agreeing about ONE row. The interesting half is the PRE-MIGRATION exemption,
// which is the difference between "quiet upgrade" and "every reminder armed
// before today is refused".
import { describe, expect, it } from 'vitest';
import { isSupersededRung } from '../src/lib/ladderPointer.js';

describe('isSupersededRung', () => {
  it('CURRENT: the row carries the ladder the tour points at', () => {
    expect(isSupersededRung({ ladderId: 'ladder-a' }, { currentLadderId: 'ladder-a' })).toBe(false);
  });

  it('SUPERSEDED: the row carries an older ladder than the tour points at', () => {
    expect(isSupersededRung({ ladderId: 'ladder-a' }, { currentLadderId: 'ladder-b' })).toBe(true);
  });

  it('SUPERSEDED: a stamped row on a tour with NO pointer (the interruption case)', () => {
    // The armer stamped the rows and the pointer write never landed (route
    // logged 'the new ladder is unpointed', S3). Refusing is the deliberate
    // choice: the alternative reads a stamped row as pre-migration, which would
    // make every failed pointer write a silent send from an unknown generation.
    expect(isSupersededRung({ ladderId: 'ladder-a' }, {})).toBe(true);
    expect(isSupersededRung({ ladderId: 'ladder-a' }, { currentLadderId: undefined })).toBe(true);
  });

  it('EXEMPT: a bare row on a bare tour is pre-migration, not superseded', () => {
    // Both halves absent = the pair predates the feature. Refusing here would
    // retire every rung armed before the migration on its first poll.
    expect(isSupersededRung({}, {})).toBe(false);
    expect(isSupersededRung({ ladderId: undefined }, { currentLadderId: undefined })).toBe(false);
  });

  it('SUPERSEDED: a bare row on a POINTED tour (armed before, rearmed after)', () => {
    // The other asymmetric cell: the tour has been rearmed since the migration,
    // so its pre-migration rungs belong to a generation it no longer names.
    expect(isSupersededRung({}, { currentLadderId: 'ladder-b' })).toBe(true);
  });
});
