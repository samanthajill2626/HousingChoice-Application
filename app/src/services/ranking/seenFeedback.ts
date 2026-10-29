// WP1 B2a (spec D2.3; charter 6.2 and item 8; Q1): THE ATTACH STEP, alone in
// this module so WP3 can delete it (docs/issues/wp3-property-feedback-redesign.md:
// pairing feedback with a property by its label in Notes text is a stopgap).
// It splits the Notes box into physical lines; a line that labelMatches the
// label of any property in the (unbounded) seen set goes under that property
// - under each it names - and leaves the card's notes; every other line stays
// and bears on every property. Whole lines move, staff-typed lines included
// (Q1). No other polish: no abbreviation folding, no date parsing of the
// `[Auto - <date>]` prefix (it has no year; age comes from stored dates).
// cards.ts decides which entries are LISTED and returns an unlisted entry's
// lines to the notes.
import { labelMatches } from '../../lib/propertyLabel.js';

export interface AttachedLine {
  /** The physical line, trimmed. */
  text: string;
  /** Every seen home whose label it names, in the order given; [] = a general line. */
  unitIds: string[];
}

/**
 * The physical lines of a Notes box: split on CR LF, CR, LF, U+2028 and
 * U+2029 (by character code, so no separator is typed into source), each
 * trimmed, blank lines dropped. A non-string box has none.
 */
export function noteLines(notes: unknown): string[] {
  if (typeof notes !== 'string') return [];
  const lines: string[] = [];
  let current = '';
  for (let i = 0; i < notes.length; i += 1) {
    const code = notes.charCodeAt(i);
    if (code === 0x0d || code === 0x0a || code === 0x2028 || code === 0x2029) {
      lines.push(current);
      current = '';
      if (code === 0x0d && notes.charCodeAt(i + 1) === 0x0a) i += 1;
      continue;
    }
    current += notes.charAt(i);
  }
  lines.push(current);
  return lines.map((line) => line.trim()).filter((line) => line.length > 0);
}

/** Spec D2.3: each line with the seen homes it names. A home with no label is never named. */
export function attachFeedback(
  notes: unknown,
  homes: readonly { unitId: string; label: string | undefined }[],
): AttachedLine[] {
  return noteLines(notes).map((text) => ({
    text,
    unitIds: homes
      .filter((home) => home.label !== undefined && labelMatches(text, home.label))
      .map((home) => home.unitId),
  }));
}
