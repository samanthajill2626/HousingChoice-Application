// SMS encoding analysis - which alphabet a body lands in and what it costs.
//
// A single character outside GSM-7 flips the WHOLE message to UCS-2, collapsing
// the budget from 160 characters to 70 (and from 153 to 67 per part once it
// splits). This module is the single authority on that pricing; a naive
// body.length check gets it wrong in both directions.
//
// Pure: data + arithmetic only, no I/O (the messages/catalog.ts discipline).
export type SmsEncoding = 'GSM-7' | 'UCS-2';

export interface SmsAnalysis {
  encoding: SmsEncoding;
  /** Septets for GSM-7, UTF-16 code units for UCS-2. */
  units: number;
  segments: number;
  /** Distinct characters that forced UCS-2 - for a failure message, never a log. */
  nonGsm7Chars: string[];
}

// EVERY non-ASCII character below is written as a \u ESCAPE, deliberately. Two
// reasons: the repo's ASCII-only rule applies to source, and a file carrying raw
// U+00A0 / U+202F / accented literals is exactly the file a careless editor or a
// PowerShell rewrite turns into mojibake (a documented footgun here). Escapes are
// also self-documenting - \u202F says which space it is, a raw one does not.

/** GSM 03.38 basic alphabet. Order is irrelevant; membership is what matters. */
const GSM7_BASIC =
  '@\u00A3$\u00A5\u00E8\u00E9\u00F9\u00EC\u00F2\u00C7\n\u00D8\u00F8\r\u00C5\u00E5' +
  '\u0394_\u03A6\u0393\u039B\u03A9\u03A0\u03A8\u03A3\u0398\u039E\u00C6\u00E6\u00DF\u00C9' +
  ' !"#\u00A4%&\'()*+,-./0123456789:;<=>?' +
  '\u00A1ABCDEFGHIJKLMNOPQRSTUVWXYZ\u00C4\u00D6\u00D1\u00DC\u00A7' +
  '\u00BFabcdefghijklmnopqrstuvwxyz\u00E4\u00F6\u00F1\u00FC\u00E0';

/** GSM 03.38 extension table - each costs TWO septets (escape + character). */
const GSM7_EXTENSION = '\f^{}\\[~]|\u20AC';

const GSM7_SINGLE = 160;
const GSM7_CONCAT = 153;
const UCS2_SINGLE = 70;
const UCS2_CONCAT = 67;

export function analyzeSms(body: string): SmsAnalysis {
  const chars = [...body];
  const nonGsm7 = [
    ...new Set(chars.filter((c) => !GSM7_BASIC.includes(c) && !GSM7_EXTENSION.includes(c))),
  ];

  if (nonGsm7.length > 0) {
    // UCS-2 counts UTF-16 code units, so an astral character costs 2.
    const units = chars.reduce((n, c) => n + ((c.codePointAt(0) ?? 0) > 0xffff ? 2 : 1), 0);
    return {
      encoding: 'UCS-2',
      units,
      segments: units <= UCS2_SINGLE ? 1 : Math.ceil(units / UCS2_CONCAT),
      nonGsm7Chars: nonGsm7,
    };
  }

  const units = chars.reduce((n, c) => n + (GSM7_EXTENSION.includes(c) ? 2 : 1), 0);
  return {
    encoding: 'GSM-7',
    units,
    segments: units <= GSM7_SINGLE ? 1 : Math.ceil(units / GSM7_CONCAT),
    nonGsm7Chars: [],
  };
}
