// filterNoteLines - the ONE place for Notes line value rules (B1 spec D4, PR4).
// Pure: the extraction job (through applyExtraction) and the never-written
// probe (spec D7) both call it, and the fake driver's bypass of
// parseExtractionText (adapters/extractionFake.ts, the marker merge; WI1) skips nothing,
// because nothing here trusts the parser. Order: clamp (line breaks collapsed,
// WP1 B2a D14.1) -> floor (counted) -> postal filter -> retry guard (counted
// as `duplicate`, WP1 B2a D14.2) -> system lines -> five-line cap -> demotion.
import { describe, expect, it } from 'vitest';
import { filterNoteLines, type NoteLineFilterInput } from '../src/services/extraction/apply.js';

const PREFIX = '[Auto - Oct 26]';
const SYSTEM = 'Mentioned number +15550109999 which belongs to another contact';

function input(over: Partial<NoteLineFilterInput> = {}): NoteLineFilterInput {
  return { modelLines: [], systemLines: [], floor: 0.7, existingNotes: '', demoted: false, ...over };
}
const note = (text: string, confidence: unknown = 0.9): { text: string; confidence: unknown } => ({ text, confidence });

describe('filterNoteLines - the confidence floor', () => {
  it('keeps a line AT the floor and drops one below it, counting the drop', () => {
    expect(filterNoteLines(input({ modelLines: [note('at the floor', 0.7), note('below it', 0.69)] }))).toEqual({
      append: ['at the floor'], modelCount: 1, belowFloor: 1, demoted: 0, duplicate: 0,
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
      append: ['high 6', 'high 7'], modelCount: 2, belowFloor: 5, demoted: 0, duplicate: 0,
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
    expect(out).toEqual({ append: [], modelCount: 0, belowFloor: 0, demoted: 0, duplicate: 0 });
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
    expect(out.duplicate).toBe(1);
  });

  it('the guard also drops a bare line already in the notes - model or system (spec D4 C1)', () => {
    const out = filterNoteLines(input({
      existingNotes: `works nights downtown\n${PREFIX} ${SYSTEM}`,
      modelLines: [note('works nights downtown'), note('has a car')],
      systemLines: [SYSTEM],
    }));
    expect(out.append).toEqual(['has a car']);
    expect(out.duplicate).toBe(2);
  });

  it('system lines carry no confidence and bypass the floor, AFTER the model lines', () => {
    expect(filterNoteLines(input({ floor: 1, modelLines: [note('nearly sure', 0.99)], systemLines: [SYSTEM] }))).toEqual({
      append: [SYSTEM], modelCount: 0, belowFloor: 1, demoted: 0, duplicate: 0,
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
// mind is a new line). It compares against every line under ANY date (the
// describe below; Cameron's handback ruling, 2026-10-27).
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

  it('(PIN) drops a flip back to EXACTLY an earlier date\'s words, keeps a change worded as a change (R2-1 reproduction a, verbatim)', () => {
    // The accepted cost of the any-date guard: the prompt asks for a change back worded differently.
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
    expect(out.append).toEqual(['412 Oak Ave, Decatur: back on the fence']);
  });

  it('still drops a same-run retry (F1), a line holding a break and a system line included - all three counted', () => {
    // A complete() failure re-extracts the SAME transcript against notes that
    // already carry run 1's lines, each written as `<prefix> <line>`. Run 1
    // wrote the break collapsed (WP1 B2a D14.1) and the retry collapses it
    // the same way, so it matches.
    const runOne = ['stairs are a problem', 'toured on Monday\nliked the yard'];
    const first = filterNoteLines(input({ existingNotes: 'seed note', modelLines: runOne.map((text) => note(text)), systemLines: [SYSTEM] }));
    expect(first.append).toEqual(['stairs are a problem', 'toured on Monday / liked the yard', SYSTEM]);
    const existingNotes = ['seed note', ...first.append.map((l) => `${PREFIX} ${l}`)].join('\n');
    expect(filterNoteLines(input({ existingNotes, modelLines: runOne.map((text) => note(text)), systemLines: [SYSTEM] }))).toEqual({
      append: [], modelCount: 0, belowFloor: 0, demoted: 0, duplicate: 3,
    });
  });
});

// Cameron's handback ruling (2026-10-27) over FW3-1's same-day form: every
// run re-sends up to 30 days of ALREADY-EXTRACTED messages, so a model that
// misses the reconcile rule re-emits an old fact on a later day - often by
// copying its earlier line, prefix and all. The guard drops a line (model or
// system) equal to a whole stored line under ANY date, the `[Auto - <date>]`
// prefix removed on both sides. A copied prefix is also removed before the
// write: never a double prefix (R3-4).
describe('filterNoteLines - the retry guard drops a line already written under any date', () => {
  const HOME = '412 Oak Ave, Decatur';

  it('drops a fact re-extracted from an old message on a later day - bare, or copied with its old prefix - and counts each', () => {
    const out = filterNoteLines(input({
      existingNotes: ['[Auto - Oct 19] works nights downtown', '[Auto - Oct 19] toured on Monday', 'liked the yard'].join('\n'),
      modelLines: [
        note('works nights downtown'),
        note('[Auto - Oct 19] works nights downtown'),
        note('toured on Monday'),
        note('liked the yard'),
      ],
    }));
    expect(out).toEqual({ append: [], modelCount: 0, belowFloor: 0, demoted: 0, duplicate: 4 });
  });

  it('(PIN) drops a second oscillation back to the exact words of an earlier line (the accepted cost), keeps one worded differently', () => {
    const out = filterNoteLines(input({
      existingNotes: [
        `[Auto - Oct 20] ${HOME}: on the fence`,
        `[Auto - Oct 22] ${HOME}: now likes it`,
        `[Auto - Oct 27] ${HOME}: back on the fence`,
      ].join('\n'),
      modelLines: [note(`${HOME}: now likes it`, 0.95), note(`${HOME}: likes it again`, 0.95)],
    }));
    expect(out.append).toEqual([`${HOME}: likes it again`]);
  });

  it('drops a same-day re-emission of the same words, both sides trimmed', () => {
    const out = filterNoteLines(input({
      existingNotes: [`  ${PREFIX} ${HOME}: on the fence  `, `${PREFIX} ${HOME}: likes it`].join('\n'),
      modelLines: [note(`  ${HOME}: on the fence `, 0.95)],
    }));
    expect(out).toEqual({ append: [], modelCount: 0, belowFloor: 0, demoted: 0, duplicate: 1 });
  });

  it('(PIN) drops a system line repeated on a later date', () => {
    const out = filterNoteLines(input({ existingNotes: `[Auto - Oct 19] ${SYSTEM}`, systemLines: [SYSTEM] }));
    expect(out.append).toEqual([]);
  });

  it('writes a new model line that copied an old prefix with every copied prefix removed (R3-4)', () => {
    const out = filterNoteLines(input({
      existingNotes: '[Auto - Oct 19] works nights downtown',
      modelLines: [
        note('[Auto - Oct 19] [Auto - Oct 18] has a car'),
        // The postal filter, too, reads the text without the copied prefix.
        note('[Auto - Oct 19] Current address: 535 Seal Pl NE, Atlanta'),
      ],
    }));
    expect(out.append).toEqual(['has a car']);
  });
});

// WP1 B2a spec D14.1 (charter 20 item 14): a model or system line's breaks -
// every run of CR, LF, U+2028 and U+2029 - collapse to " / " BEFORE the
// clamp and the retry guard (lib/singleLine.ts toOneLine, the transcript's
// rule), so the [Auto - <date>] prefix covers the whole line and no
// continuation reads as staff text (issue
// extraction-note-line-break-unprefixed-continuation).
describe('filterNoteLines - line breaks collapse to " / " (WP1 B2a D14.1)', () => {
  it('collapses CR, LF and CRLF runs in a model line', () => {
    expect(filterNoteLines(input({ modelLines: [note('toured on Monday\r\n\r\nliked the yard\rwants a fence\nasked about pets')] })).append)
      .toEqual(['toured on Monday / liked the yard / wants a fence / asked about pets']);
  });

  it('collapses U+2028 and U+2029 the same way', () => {
    expect(filterNoteLines(input({ modelLines: [note('412 Oak Ave, Decatur: on the fence\u2028worried about the commute\u2029likes the yard')] })).append)
      .toEqual(['412 Oak Ave, Decatur: on the fence / worried about the commute / likes the yard']);
  });

  it('collapses a system line too', () => {
    expect(filterNoteLines(input({ systemLines: ['Mentioned number +15550109999\nwhich belongs to another contact'] })).append)
      .toEqual(['Mentioned number +15550109999 / which belongs to another contact']);
  });

  it('collapses BEFORE the clamp: the 200 characters count the " / "', () => {
    // 198 x, a break, zz (201 chars). Collapsed first it is 203 chars, the
    // cut keeps 198 x and " /", and the result is 200 chars. Cut first and
    // collapsed after, it would be 198 x, " / ", z: 204 chars, over the cap.
    // (Today's code keeps the raw break: 198 x, LF, z.)
    expect(filterNoteLines(input({ modelLines: [note(`${'x'.repeat(198)}\nzz`)] })).append).toEqual([`${'x'.repeat(198)} /`]);
  });

  // (PIN) withoutAutoPrefix already trims the ends (U+2028 / U+2029 too) and
  // strips a leading copied prefix today; this pins that the collapse runs
  // AFTER it (C3), so the case stays green through the change.
  it('(PIN) strips a copied prefix and the ends first, so a break never leaves a leading or trailing " / "', () => {
    expect(filterNoteLines(input({ modelLines: [note('\n[Auto - Oct 19]\nhas a car\n\n'), note('\u2028works nights\u2029')] })).append)
      .toEqual(['has a car', 'works nights']);
  });

  it('drops a line that is only breaks, uncounted, like any blank line', () => {
    expect(filterNoteLines(input({ modelLines: [note('\r\n\u2028\n')] }))).toEqual({
      append: [], modelCount: 0, belowFloor: 0, demoted: 0, duplicate: 0,
    });
  });

  it('the retry guard compares the COLLAPSED line: a stored "a / b" line drops its re-emission', () => {
    const out = filterNoteLines(input({
      existingNotes: `${PREFIX} toured on Monday / liked the yard\n${PREFIX} has a car`,
      modelLines: [note('toured on Monday\nliked the yard')],
    }));
    expect(out).toEqual({ append: [], modelCount: 0, belowFloor: 0, demoted: 0, duplicate: 1 });
  });

  it('a collapsed line merely CONTAINED in a longer stored line is still new (whole lines, FW2-1)', () => {
    expect(filterNoteLines(input({
      existingNotes: `${PREFIX} toured on Monday / liked the yard / asked about pets`,
      modelLines: [note('toured on Monday\nliked the yard')],
    })).append).toEqual(['toured on Monday / liked the yard']);
  });

  it('a multi-line line stored BEFORE B2a is not matched by its collapsed re-emission: appended once more (D14.1, accepted)', () => {
    const out = filterNoteLines(input({
      existingNotes: [`${PREFIX} toured on Monday`, 'liked the yard'].join('\n'),
      modelLines: [note('toured on Monday\nliked the yard')],
    }));
    expect(out).toEqual({ append: ['toured on Monday / liked the yard'], modelCount: 1, belowFloor: 0, demoted: 0, duplicate: 0 });
  });
});

// WP1 B2a spec D14.2: the lines the retry guard drops are counted -
// `duplicate`, model and system lines together - so the run record can show
// "N already in the notes" (part one of notes-guard-stale-reread-vs-flip-back).
describe('filterNoteLines - the retry guard counts what it drops (WP1 B2a D14.2)', () => {
  it('counts model and system lines together', () => {
    const out = filterNoteLines(input({
      existingNotes: `works nights downtown\n[Auto - Oct 19] ${SYSTEM}\n${PREFIX} has a car`,
      modelLines: [note('works nights downtown'), note('[Auto - Oct 19] has a car'), note('likes the yard')],
      systemLines: [SYSTEM],
    }));
    expect(out).toEqual({ append: ['likes the yard'], modelCount: 1, belowFloor: 0, demoted: 0, duplicate: 3 });
  });

  it('never counts a floor, blank or postal drop as a duplicate', () => {
    const out = filterNoteLines(input({
      existingNotes: 'low line\nCurrent address: 535 Seal Pl NE, Atlanta',
      modelLines: [note('low line', 0.1), note('   '), note('Current address: 535 Seal Pl NE, Atlanta')],
    }));
    expect(out).toEqual({ append: [], modelCount: 0, belowFloor: 1, demoted: 0, duplicate: 0 });
  });

  it('counts a duplicate the cap would have cut too: the guard runs before the cap', () => {
    const out = filterNoteLines(input({
      existingNotes: `${PREFIX} six`,
      modelLines: ['one', 'two', 'three', 'four', 'five', 'six'].map((text) => note(text)),
    }));
    expect(out.append).toEqual(['one', 'two', 'three', 'four', 'five']);
    expect(out.duplicate).toBe(1);
  });

  it('a demoted run still counts its duplicates, as it counts its floor drops', () => {
    expect(filterNoteLines(input({
      demoted: true, existingNotes: `${PREFIX} kept`, modelLines: [note('kept'), note('new'), note('low', 0.1)],
    }))).toEqual({ append: [], modelCount: 0, belowFloor: 1, demoted: 1, duplicate: 1 });
  });
});

describe('filterNoteLines - a demoted run (charter 6.4; spec Q1)', () => {
  it('appends NO line of either kind, still counts the floor, and counts what it withheld', () => {
    expect(filterNoteLines(input({
      demoted: true, modelLines: [note('kept'), note('low', 0.1)], systemLines: [SYSTEM],
    }))).toEqual({ append: [], modelCount: 0, belowFloor: 1, demoted: 2, duplicate: 0 });
  });
});
