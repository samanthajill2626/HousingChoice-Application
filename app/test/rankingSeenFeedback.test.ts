// WP1 B2a S3.3 (spec D2.3; charter 6.2, item 8; Q1): the attach step. The
// Notes box is split into physical lines; a line that labelMatches a seen
// home's label goes under that home (under each it names) and leaves the
// card's notes; every other line stays. Whole lines move, staff-typed lines
// included. No other polish: no abbreviation folding, no date parsing.
// U+2028 / U+2029 are built from their char codes (plan section 0: the
// Edit/Write tools decode \u escapes). Pure.
import { describe, expect, it } from 'vitest';
import { attachFeedback, noteLines } from '../src/services/ranking/seenFeedback.js';

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

const HOMES = [
  { unitId: 'u1', label: '12 Oak St, Decatur' },
  { unitId: 'u2', label: '40 Pine Ave Apt 2, Tucker' },
  { unitId: 'u3', label: undefined },
];

describe('noteLines - the physical lines of the Notes box', () => {
  it('splits on CR LF, CR, LF and the two Unicode separators, trims, drops blank lines', () => {
    expect(noteLines(`a\r\nb\rc\nd${LS}e${PS}f\n\n   g  \n`)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  });

  it('reads nothing from a missing or non-string box', () => {
    expect(noteLines(undefined)).toEqual([]);
    expect(noteLines(42)).toEqual([]);
    expect(noteLines('   ')).toEqual([]);
  });
});

describe('attachFeedback - a line naming a seen home goes under it (spec D2.3)', () => {
  it('matches the label with case and spacing folded; an unmatched line names no home', () => {
    expect(attachFeedback('[Auto - Oct 12] 12 oak st,  decatur: liked the yard\nNeeds a ground floor', HOMES)).toEqual([
      { text: '[Auto - Oct 12] 12 oak st,  decatur: liked the yard', unitIds: ['u1'] },
      { text: 'Needs a ground floor', unitIds: [] },
    ]);
  });

  it('a line naming two seen homes goes under each', () => {
    expect(attachFeedback('Compared 12 Oak St, Decatur with 40 Pine Ave Apt 2, Tucker - prefers the second', HOMES)).toEqual([
      { text: 'Compared 12 Oak St, Decatur with 40 Pine Ave Apt 2, Tucker - prefers the second', unitIds: ['u1', 'u2'] },
    ]);
  });

  it('a staff-typed line moves too (Q1)', () => {
    expect(attachFeedback('Sam: 40 Pine Ave Apt 2, Tucker is too far from her job', HOMES)).toEqual([
      { text: 'Sam: 40 Pine Ave Apt 2, Tucker is too far from her job', unitIds: ['u2'] },
    ]);
  });

  it('a home with no real label attaches nothing', () => {
    expect(attachFeedback('a property no longer on file: liked it', HOMES)).toEqual([
      { text: 'a property no longer on file: liked it', unitIds: [] },
    ]);
  });

  it('no polish: a longer house number and an unfolded abbreviation do not match', () => {
    expect(attachFeedback('112 Oak St, Decatur is nice\n12 Oak Street, Decatur is nice', HOMES)).toEqual([
      { text: '112 Oak St, Decatur is nice', unitIds: [] },
      { text: '12 Oak Street, Decatur is nice', unitIds: [] },
    ]);
  });
});
