// WP1 B1 spec D5.1 / D5.3 (plan ruling PR5): the ONE way to name a property (a
// `unit`; "property" to staff, "home" to a tenant) by its address, and the ONE
// way to tell whether a line of text names it.
//
// LEAF: this file imports nothing, so the extraction job (the PROPERTIES SENT
// block, services/extraction/sentPropertiesBlock.ts), the extraction probe and
// B2's tenant card share it without an import cycle - the block and the card
// can never disagree on a property's name.
//
// - propertyLabel: `<line 1>[ <line 2>], <city>` on ONE line, or undefined when
//   line 1 or the city is empty after trimming (a degenerate label such as
//   ", Decatur" would match half the Notes box). Line 2 is kept: units in one
//   building share line 1 and differ only in line 2. Every control character
//   and whitespace run becomes ONE space - spec D5.1's "toSingleLine defense"
//   (B1 plan PR45), done here, not by lib/singleLine.ts toOneLine (WP1 B2a
//   PR10): toOneLine writes " / ", and this leaf imports nothing.
// - labelMatches: does a line name that label? Both sides are folded the same
//   way (lowercase; the characters . , # removed; whitespace runs collapsed;
//   trimmed), then the folded label must occur in the folded line at a
//   BOUNDARY (start of line or after a non letter/digit; end of line or before
//   a non letter/digit). Abbreviations are NOT folded: "St" and "Street", "#2"
//   and "Apt 2" differ - the model is told to copy the label.
// - hasStreetAddress: the spec D5.3 pattern behind the run record's
//   unlabeledAddressLines count - a house number, one to four words, then a
//   street suffix, case-insensitive. A COUNT only: nothing is dropped or
//   rewritten on it. A heuristic: it also counts address-shaped phrases such
//   as "a 3 bedroom place".

/** The address parts propertyLabel reads. `unknown`, so a stored oddity (a
 *  number, a null) reads as empty instead of throwing. */
export interface PropertyLabelAddress {
  line1?: unknown;
  line2?: unknown;
  city?: unknown;
}

/** Anything carrying a unit's address: a UnitItem, a UnitDisplayItem, a probe
 *  fixture. A legacy plain-string address (dev data) has no city, so no label. */
export interface PropertyLabelSource {
  address?: PropertyLabelAddress | string | null;
}

/**
 * One line: C0 and C1 control characters (newlines and tabs included), DEL and
 * the Unicode line/paragraph separators become spaces; whitespace runs collapse
 * to one space; the ends are trimmed. Character codes, so no control character
 * is typed into source (the orgListBlock.ts oneLine rule).
 */
function oneLine(value: unknown): string {
  if (typeof value !== 'string') return '';
  let out = '';
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
    out += control ? ' ' : ch;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** `<line 1>[ <line 2>], <city>`, or undefined when line 1 or the city is empty. */
export function propertyLabel(unit: PropertyLabelSource): string | undefined {
  const address = unit.address;
  if (typeof address !== 'object' || address === null) return undefined;
  const line1 = oneLine(address.line1);
  const city = oneLine(address.city);
  if (line1.length === 0 || city.length === 0) return undefined;
  const line2 = oneLine(address.line2);
  return line2.length > 0 ? `${line1} ${line2}, ${city}` : `${line1}, ${city}`;
}

/** The fold both sides of labelMatches share. */
function fold(text: string): string {
  return text.toLowerCase().replace(/[.,#]/g, '').replace(/\s+/g, ' ').trim();
}

function isLetterOrDigit(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}

/** True when `line` names `label` (folded, at a boundary). An empty label matches nothing. */
export function labelMatches(line: string, label: string): boolean {
  const needle = fold(label);
  if (needle.length === 0) return false;
  const haystack = fold(line);
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    if (!isLetterOrDigit(haystack[at - 1]) && !isLetterOrDigit(haystack[at + needle.length])) return true;
  }
  return false;
}

/** Spec D5.3: the street suffixes the unlabeled-address count recognizes. */
export const STREET_SUFFIXES = [
  'st', 'street', 'ave', 'avenue', 'rd', 'road', 'dr', 'drive', 'ln', 'lane',
  'ct', 'court', 'blvd', 'boulevard', 'way', 'pl', 'place', 'cir', 'circle',
  'pkwy', 'parkway', 'hwy', 'highway', 'ter', 'terrace', 'trl', 'trail',
] as const;

const STREET_ADDRESS = new RegExp(
  `(?:^|[^\\p{L}\\p{N}])\\d+(?:\\s+[\\p{L}\\p{N}'.-]+){1,4}?\\s+(?:${STREET_SUFFIXES.join('|')})(?![\\p{L}\\p{N}])`,
  'iu',
);

/** Spec D5.3: a house number, one to four words, then a street suffix. */
export function hasStreetAddress(line: string): boolean {
  return STREET_ADDRESS.test(line);
}
