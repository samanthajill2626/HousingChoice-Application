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

  it('the guard also drops a bare line already in the notes - model or system (spec D4 C1)', () => {
    const out = filterNoteLines(input({
      existingNotes: `works nights downtown\n${PREFIX} ${SYSTEM}`,
      modelLines: [note('works nights downtown'), note('has a car')],
      systemLines: [SYSTEM],
    }));
    expect(out.append).toEqual(['has a car']);
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

// FW2-1 (code review R2-1): the retry guard compares WHOLE lines. A candidate
// is dropped only when an existing Notes line - its leading `[Auto - <Mon D>]`
// prefix removed, both sides trimmed - EQUALS it. A line merely CONTAINED in a
// longer one is new feedback (spec D5.2: a change of mind is a new line).
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

  it('(PIN) still drops a line identical to an earlier one under any date prefix, or a bare staff line, both sides trimmed', () => {
    // R2-1 reproduction a VERBATIM: the Oct 27 line repeats the Oct 20 words
    // exactly, so it stays dropped (R2 adjudications, For Cameron); the prompt
    // asks the model to word a change of mind AS a change ("back on the fence").
    const out = filterNoteLines(input({
      existingNotes: [
        '[Auto - Oct 20] 412 Oak Ave, Decatur: on the fence',
        '[Auto - Oct 22] 412 Oak Ave, Decatur: likes it',
        '  staff typed this line  ',
      ].join('\n'),
      modelLines: [
        note('412 Oak Ave, Decatur: on the fence', 0.95),
        note('staff typed this line'),
        note('412 Oak Ave, Decatur: back on the fence', 0.95),
      ],
    }));
    expect(out.append).toEqual(['412 Oak Ave, Decatur: back on the fence']);
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

describe('filterNoteLines - a demoted run (charter 6.4; spec Q1)', () => {
  it('appends NO line of either kind, still counts the floor, and counts what it withheld', () => {
    expect(filterNoteLines(input({
      demoted: true, modelLines: [note('kept'), note('low', 0.1)], systemLines: [SYSTEM],
    }))).toEqual({ append: [], modelCount: 0, belowFloor: 1, demoted: 2 });
  });
});
