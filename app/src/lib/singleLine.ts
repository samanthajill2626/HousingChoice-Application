// WP1 B2a spec D14.1 (plan PR10): the ONE rule that puts text on one line.
// Two callers share it so they can never disagree:
// - the extraction transcript line (services/extraction/prompt.ts
//   renderUtteranceLine): the one-line fence that keeps a client body from
//   forging a speaker turn (prompt-injection, adversarial F2);
// - the Notes lines extraction appends (services/extraction/apply.ts
//   filterNoteLines): so the `[Auto - <date>]` prefix covers the whole line
//   and no continuation reads as staff text.
//
// LEAF: this file imports nothing.
//
// A break is CR, LF, U+2028 (LINE SEPARATOR) or U+2029 (PARAGRAPH
// SEPARATOR) - JavaScript's line terminators. A RUN of them (CRLF, a blank
// line, a mix) becomes ONE " / ". Nothing else changes: the spaces beside a
// break, tabs and both ends stay as given, so each caller trims as its own
// rule says. The two Unicode separators are written as escapes, so this
// file stays ASCII.

/** Every run of CR, LF, U+2028 and U+2029 in `text`, replaced by " / ". */
export function toOneLine(text: string): string {
  return text.replace(/[\r\n\u2028\u2029]+/g, ' / ');
}
