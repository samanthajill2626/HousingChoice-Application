// filterNoteLines - the ONE place for Notes line value rules (B1 spec D4, PR4).
// Pure: the extraction job (through applyExtraction) and the never-written
// probe (spec D7) both call it, and the fake driver's bypass of
// parseExtractionText (adapters/extractionFake.ts, the marker merge; WI1) skips nothing,
// because nothing here trusts the parser. Order: clamp -> floor (counted) ->
// postal filter -> retry guard -> system lines -> five-line cap -> demotion.
import { describe, expect, it } from 'vitest';
import { filterNoteLines, type NoteLineFilterInput } from '../src/services/extraction/apply.js';

const PREFIX = '[Auto - Oct 26]';
const SYSTEM = 'Mentioned number +15550109999 which belongs to another contact';

function input(over: Partial<NoteLineFilterInput> = {}): NoteLineFilterInput {
  return { modelLines: [], systemLines: [], floor: 0.7, existingNotes: '', prefix: PREFIX, demoted: false, ...over };
}
const note = (text: string, confidence: unknown = 0.9): { text: string; confidence: unknown } => ({ text, confidence });

describe('filterNoteLines - the confidence floor', () => {
  it('keeps a line AT the floor and drops one below it, counting the drop', () => {
    expect(filterNoteLines(input({ modelLines: [note('at the floor', 0.7), note('below it', 0.69)] }))).toEqual({
      append: ['at the floor'], modelCount: 1, belowFloor: 1, demoted: 0,
    });
  });

  it('clamps confidence to 0..1 and reads a non-number as 0', () => {
    const out = filterNoteLines(input({
      modelLines: [note('over one', 7), note('a string', '0.9'), { text: 'missing' }, note('negative', -1)],
    }));
    expect(out.append).toEqual(['over one']);
    expect(out.belowFloor).toBe(3);
  });

  it('runs the floor BEFORE the five-line cap: seven lines, the first five below it -> the two passing lines land', () => {
    const seven = [1, 2, 3, 4, 5].map((n) => note(`low ${n}`, 0.1)).concat([note('high 6'), note('high 7')]);
    expect(filterNoteLines(input({ modelLines: seven }))).toEqual({
      append: ['high 6', 'high 7'], modelCount: 2, belowFloor: 5, demoted: 0,
    });
  });
});

describe('filterNoteLines - clamping and structure', () => {
  it('trims, clamps text to 200 characters, and drops a blank line without counting it', () => {
    const out = filterNoteLines(input({ modelLines: [note(`  ${'x'.repeat(250)}  `), note('   ')] }));
    expect(out.append).toEqual(['x'.repeat(200)]);
    expect(out.belowFloor).toBe(0);
  });

  it('drops an item that is not a { text } object, never throwing (the fake driver bypasses the parser, WI1)', () => {
    const out = filterNoteLines(input({ modelLines: ['a legacy string line', null, 42, { confidence: 0.9 }, [note('nested')]] }));
    expect(out).toEqual({ append: [], modelCount: 0, belowFloor: 0, demoted: 0 });
  });

  it('(PIN) passes a free-form line that names a property unchanged (a feedback line is a Notes line, spec D5.3)', () => {
    const line = '123 Main St, Decatur: on the fence - likes the yard, worried about the commute';
    expect(filterNoteLines(input({ modelLines: [note(line)] })).append).toEqual([line]);
  });

  it('drops a postal "current address" line but keeps a digit-free one', () => {
    const out = filterNoteLines(input({
      modelLines: [note('Current address: 535 Seal Pl NE, Atlanta'), note('Current address is unstable, couch-surfing')],
    }));
    expect(out.append).toEqual(['Current address is unstable, couch-surfing']);
  });
});

describe('filterNoteLines - the retry guard, system lines and the cap', () => {
  // Whole words, never single letters: written for the substring guard, under
  // which "d" matched inside "seed". FW2-1 compares whole lines; the words stay.
  it('runs the retry guard BEFORE the cap, so a line already present takes no slot (WI5)', () => {
    const out = filterNoteLines(input({
      existingNotes: `seed note\n${PREFIX} alpha`,
      modelLines: ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'].map((text) => note(text)),
    }));
    expect(out.append).toEqual(['bravo', 'charlie', 'delta', 'echo', 'foxtrot']);
    expect(out.modelCount).toBe(5);
  });

  it('the guard also covers system lines (spec D4 C1); a bare staff line no longer drops a model line', () => {
    // Was ['has a car']; FW3-1 (R3-adjudications): a model line is dropped only as this run writes it, `<prefix> <line>`.
    const out = filterNoteLines(input({
      existingNotes: `works nights downtown\n${PREFIX} ${SYSTEM}`,
      modelLines: [note('works nights downtown'), note('has a car')],
      systemLines: [SYSTEM],
    }));
    expect(out.append).toEqual(['works nights downtown', 'has a car']);
  });

  it('system lines carry no confidence and bypass the floor, AFTER the model lines', () => {
    expect(filterNoteLines(input({ floor: 1, modelLines: [note('nearly sure', 0.99)], systemLines: [SYSTEM] }))).toEqual({
      append: [SYSTEM], modelCount: 0, belowFloor: 1, demoted: 0,
    });
    expect(filterNoteLines(input({ modelLines: [note('first')], systemLines: [SYSTEM] })).append).toEqual(['first', SYSTEM]);
  });

  it('caps at five, model lines before system lines', () => {
    const out = filterNoteLines(input({ modelLines: ['1', '2', '3', '4', '5'].map((text) => note(text)), systemLines: [SYSTEM] }));
    expect(out.append).toEqual(['1', '2', '3', '4', '5']);
    expect(out.modelCount).toBe(5);
  });
});

// FW2-1 (code review R2-1): the retry guard compares WHOLE lines, so a line
// merely CONTAINED in a longer one is new feedback (spec D5.2: a change of
// mind is a new line). WHICH lines it compares against is FW3-1's (the
// describe below): a model line as this run writes it, the same date only.
describe('filterNoteLines - the retry guard compares WHOLE lines (FW2-1)', () => {
  it('appends feedback on 12 Oak St although an earlier line names 112 Oak St (R2-1 reproduction b)', () => {
    const out = filterNoteLines(input({
      existingNotes: '[Auto - Oct 20] 112 Oak St, Decatur: likes it',
      modelLines: [note('12 Oak St, Decatur: likes it', 0.95)],
    }));
    expect(out.append).toEqual(['12 Oak St, Decatur: likes it']);
  });

  it('appends a change of mind whose words are CONTAINED in an earlier line (R2-1 reproduction a, contained form)', () => {
    const out = filterNoteLines(input({
      existingNotes: [
        '[Auto - Oct 20] 412 Oak Ave, Decatur: likes it, worried about the commute',
        '[Auto - Oct 22] 412 Oak Ave, Decatur: on the fence',
      ].join('\n'),
      modelLines: [note('412 Oak Ave, Decatur: likes it', 0.95)],
    }));
    expect(out.append).toEqual(['412 Oak Ave, Decatur: likes it']);
  });

  it('appends a line contained in a longer staff line - the accepted trade-off', () => {
    const out = filterNoteLines(input({
      existingNotes: 'Client works nights downtown and takes the bus',
      modelLines: [note('works nights downtown')],
    }));
    expect(out.append).toEqual(['works nights downtown']);
  });

  it('appends a flip back to EXACTLY an earlier date\'s words (R2-1 reproduction a, verbatim), beside a worded change', () => {
    // Was a PIN that dropped it; FW3-1 (R3-adjudications): a model line equal to one from an EARLIER date is written again.
    const out = filterNoteLines(input({
      existingNotes: [
        '[Auto - Oct 20] 412 Oak Ave, Decatur: on the fence',
        '[Auto - Oct 22] 412 Oak Ave, Decatur: likes it',
      ].join('\n'),
      modelLines: [
        note('412 Oak Ave, Decatur: on the fence', 0.95),
        note('412 Oak Ave, Decatur: back on the fence', 0.95),
      ],
    }));
    expect(out.append).toEqual(['412 Oak Ave, Decatur: on the fence', '412 Oak Ave, Decatur: back on the fence']);
  });

  it('(PIN) still drops a same-run retry (F1), a candidate holding a line break and a system line included', () => {
    // A complete() failure re-extracts the SAME transcript against notes that
    // already carry run 1's lines, each written as `<prefix> <line>`.
    const runOne = ['stairs are a problem', 'toured on Monday\nliked the yard'];
    const existingNotes = ['seed note', ...runOne.map((l) => `${PREFIX} ${l}`), `${PREFIX} ${SYSTEM}`].join('\n');
    expect(filterNoteLines(input({ existingNotes, modelLines: runOne.map((text) => note(text)), systemLines: [SYSTEM] }))).toEqual({
      append: [], modelCount: 0, belowFloor: 0, demoted: 0,
    });
  });
});

// FW3-1 (R3-adjudications, "The retry guard, decided"; code review R2-1, R3-3,
// R3-4): the guard exists for ONE thing - a complete() failure re-arms the
// SAME due row and the retry re-extracts the same transcript minutes later
// (adversarial F1). So a MODEL line is dropped only when, AS THIS RUN WRITES
// IT (`<prefix> <line>`, the prefix carrying the run's date), it equals a run
// of whole lines already in the notes; a SYSTEM line is dropped when it equals
// a line of any date, the prefix removed on both sides. A leading
// `[Auto - <date>]` the model copied into its text is removed before the
// comparison and before the write: never a double prefix.
describe('filterNoteLines - the retry guard drops a model line only as this run writes it (FW3-1)', () => {
  const HOME = '412 Oak Ave, Decatur';
  const NOV_2 = '[Auto - Nov 2]';

  it('appends a second oscillation back to "now likes it" (R3-3 case a)', () => {
    const out = filterNoteLines(input({
      prefix: NOV_2,
      existingNotes: [
        `[Auto - Oct 20] ${HOME}: on the fence`,
        `[Auto - Oct 22] ${HOME}: now likes it`,
        `[Auto - Oct 27] ${HOME}: back on the fence`,
      ].join('\n'),
      modelLines: [note(`${HOME}: now likes it`, 0.95)],
    }));
    expect(out.append).toEqual([`${HOME}: now likes it`]);
  });

  it('appends a second oscillation back to "back on the fence" (R3-3 case b, the mirror)', () => {
    const out = filterNoteLines(input({
      prefix: NOV_2,
      existingNotes: [
        `[Auto - Oct 20] ${HOME}: likes it`,
        `[Auto - Oct 22] ${HOME}: back on the fence`,
        `[Auto - Oct 27] ${HOME}: now likes it`,
      ].join('\n'),
      modelLines: [note(`${HOME}: back on the fence`, 0.95)],
    }));
    expect(out.append).toEqual([`${HOME}: back on the fence`]);
  });

  it('appends a model line repeated verbatim from an EARLIER date, one holding a line break too (the documented cost)', () => {
    const out = filterNoteLines(input({
      existingNotes: ['[Auto - Oct 19] works nights downtown', '[Auto - Oct 19] toured on Monday', 'liked the yard'].join('\n'),
      modelLines: [note('works nights downtown'), note('toured on Monday\nliked the yard')],
    }));
    expect(out.append).toEqual(['works nights downtown', 'toured on Monday\nliked the yard']);
  });

  it('(PIN) drops a same-day re-emission of the same words, both sides trimmed (the documented cost: a same-day flip back)', () => {
    // A second run the SAME day - a new transcript, not a retry - flipping back to words this day already wrote.
    const out = filterNoteLines(input({
      existingNotes: [`  ${PREFIX} ${HOME}: on the fence  `, `${PREFIX} ${HOME}: likes it`].join('\n'),
      modelLines: [note(`  ${HOME}: on the fence `, 0.95)],
    }));
    expect(out).toEqual({ append: [], modelCount: 0, belowFloor: 0, demoted: 0 });
  });

  it('(PIN) a candidate holding a line break matches a RUN of whole lines as this run writes it, not lines scattered apart', () => {
    const scattered = [`${PREFIX} toured on Monday`, `${PREFIX} has a car`, 'liked the yard'].join('\n');
    expect(filterNoteLines(input({ existingNotes: scattered, modelLines: [note('toured on Monday\nliked the yard')] })).append)
      .toEqual(['toured on Monday\nliked the yard']);
    const asWritten = [`${PREFIX} toured on Monday`, 'liked the yard', `${PREFIX} has a car`].join('\n');
    expect(filterNoteLines(input({ existingNotes: asWritten, modelLines: [note('toured on Monday\nliked the yard')] })).append)
      .toEqual([]);
  });

  it('(PIN) drops a system line repeated on a later date - it carries no meaning change', () => {
    const out = filterNoteLines(input({ existingNotes: `[Auto - Oct 19] ${SYSTEM}`, systemLines: [SYSTEM] }));
    expect(out.append).toEqual([]);
  });

  it('writes a model line that copied an old prefix under ONE prefix - every copied prefix removed (R3-4)', () => {
    const out = filterNoteLines(input({
      existingNotes: '[Auto - Oct 19] works nights downtown',
      modelLines: [
        note('[Auto - Oct 19] works nights downtown'),
        note('[Auto - Oct 19] [Auto - Oct 18] has a car'),
        // The postal filter, too, reads the text without the copied prefix.
        note('[Auto - Oct 19] Current address: 535 Seal Pl NE, Atlanta'),
      ],
    }));
    expect(out.append).toEqual(['works nights downtown', 'has a car']);
  });

  it('drops a same-day echo of a line the model copied with its prefix (R3-4)', () => {
    const out = filterNoteLines(input({
      existingNotes: `seed note\n${PREFIX} works nights downtown`,
      modelLines: [note(`${PREFIX} works nights downtown`)],
    }));
    expect(out.append).toEqual([]);
  });
});

describe('filterNoteLines - a demoted run (charter 6.4; spec Q1)', () => {
  it('appends NO line of either kind, still counts the floor, and counts what it withheld', () => {
    expect(filterNoteLines(input({
      demoted: true, modelLines: [note('kept'), note('low', 0.1)], systemLines: [SYSTEM],
    }))).toEqual({ append: [], modelCount: 0, belowFloor: 1, demoted: 2 });
  });
});
