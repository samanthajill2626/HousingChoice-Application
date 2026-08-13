// Mine property addresses out of the message corpus (spec §3.3, units tab).
//
// The Airtable properties table has 10 rows and 26 of its 38 columns are empty,
// which does not look like the whole book. Meanwhile the founder texts addresses
// constantly — the same address bodies repeat 49, 40, 26 and 23 times in her
// outbound messages, usually as a bare location share:
//
//   "1234 Ruth St NW\nAtlanta, GA 30318\nUnited States"
//   "2018 Ruth St 30318"
//   "1425 Joseph E Boone Blvd NW, Unit 104, Atlanta, GA 30314"
//
// So we mine candidates and rank them by how often she sent each, and the
// workbook carries a `source` column (airtable | found-in-texts) plus the send
// count. She confirms or deletes; nothing mined is imported unconfirmed.
//
// This is deliberately a RECALL-oriented extractor with a human gate, not a
// precision-oriented one. A false positive costs her one keystroke; a missed
// property costs a listing she has to retype.

import type { Address } from '../address.js';
import type { QuoMessage } from './quoSource.js';

/**
 * US street-address head: a house number followed by 1-5 words ending in a
 * street-type token. Requiring the street type is what keeps "3 bedroom 2 bath"
 * and "$1830 rent" out of the results.
 */
const STREET_TYPES = [
  'st', 'street', 'rd', 'road', 'dr', 'drive', 'ave', 'avenue', 'ln', 'lane',
  'blvd', 'boulevard', 'ct', 'court', 'cir', 'circle', 'pl', 'place', 'ter',
  'terrace', 'way', 'trl', 'trail', 'pkwy', 'parkway', 'hwy', 'highway', 'run',
  'path', 'pt', 'point', 'sq', 'square', 'xing', 'crossing', 'cv', 'cove',
];

/**
 * Metro-Atlanta municipalities the founder actually writes. ONE list, used by
 * the mining regex below AND by `parseUnitAddress` - a city this list misses is
 * simply left in the street line, never guessed at.
 */
const METRO_CITIES = [
  'Atlanta', 'Decatur', 'Marietta', 'College Park', 'East Point', 'Jonesboro',
  'Riverdale', 'Union City', 'Forest Park', 'Smyrna', 'Austell', 'Mableton',
  'Lithonia', 'Stone Mountain', 'Conyers', 'Douglasville', 'Fairburn',
  'Hapeville', 'Morrow', 'Stockbridge', 'Ellenwood', 'Rex', 'Tucker',
  'Clarkston', 'Norcross', 'Duluth', 'Lawrenceville',
];

const ADDRESS_RE = new RegExp(
  String.raw`\b(\d{1,6})\s+` + // house number
    String.raw`((?:[A-Za-z0-9'.-]+\s+){0,4}?` + // up to 4 name words (lazy)
    `(?:${STREET_TYPES.join('|')})\\b\\.?)` + // street type
    String.raw`(\s*(?:N|S|E|W|NE|NW|SE|SW)\b\.?)?` + // optional quadrant
    String.raw`([^\n,]{0,40}?)?` + // optional unit/suffix on the same line
    String.raw`(?:\s*,?\s*(?:Apt|Unit|Ste|Suite)\.?\s*([A-Za-z0-9-]+))?` +
    `(?:\\s*,?\\s*(${METRO_CITIES.join('|')})\\b)?` +
    String.raw`(?:\s*,?\s*(?:GA|Georgia)\b)?` +
    String.raw`(?:\s*(\d{5})(?:-\d{4})?\b)?`,
  'gi',
);

export interface AddressCandidate {
  /** The normalized form used as the dedupe key and the unitId seed. */
  normalized: string;
  /** The most complete raw form seen, for display in the workbook. */
  display: string;
  /** How many messages contained this address. */
  sendCount: number;
  /** How many DISTINCT threads it appeared in — a better relevance signal. */
  threadCount: number;
  zip?: string;
  city?: string;
  /** ISO 8601 of the most recent message mentioning it. */
  lastSeenAt: string;
}

/**
 * Canonical form for dedupe: lowercase, collapse whitespace, strip punctuation,
 * expand nothing. "2018 Ruth St 30318" and "2018 Ruth St NW, Atlanta, GA 30318"
 * normalize to different keys on purpose — merging them would silently assert
 * they are the same property, and the founder is the one who knows.
 *
 * What this DOES fix is formatting noise: trailing "United States", double
 * spaces, a trailing period, and inconsistent comma placement.
 */
export function normalizeAddress(raw: string): string {
  return raw
    .replace(/\bunited states\b/gi, ' ')
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Extract address candidates from message bodies.
 *
 * Only OUTBOUND messages are mined by default: an address the founder sent is a
 * property she is marketing, whereas an address a tenant sent is usually where
 * they currently live — importing those as available units would be wrong.
 */
export function mineAddresses(
  messages: readonly QuoMessage[],
  options: { includeInbound?: boolean; minSendCount?: number } = {},
): AddressCandidate[] {
  const includeInbound = options.includeInbound ?? false;
  const minSendCount = options.minSendCount ?? 1;

  const byKey = new Map<
    string,
    { display: string; count: number; threads: Set<string>; zip?: string; city?: string; last: string }
  >();

  for (const msg of messages) {
    if (!includeInbound && msg.direction !== 'outgoing') continue;
    if (!msg.body.trim()) continue;

    // A single body can hold several addresses (she sends lists).
    const seenInThisMessage = new Set<string>();
    for (const m of msg.body.matchAll(ADDRESS_RE)) {
      const whole = m[0]!.trim();
      const zip = m[7];
      const city = m[6];
      const normalized = normalizeAddress(whole);
      // Guard against the regex latching onto a bare number + noise.
      if (normalized.length < 8) continue;
      if (seenInThisMessage.has(normalized)) continue;
      seenInThisMessage.add(normalized);

      let entry = byKey.get(normalized);
      if (!entry) {
        entry = { display: tidyDisplay(whole), count: 0, threads: new Set(), last: '' };
        byKey.set(normalized, entry);
      }
      entry.count += 1;
      entry.threads.add(msg.conversationId);
      if (msg.createdAt > entry.last) entry.last = msg.createdAt;
      // Keep the most complete display form we have seen.
      const candidate = tidyDisplay(whole);
      if (candidate.length > entry.display.length) entry.display = candidate;
      if (zip && !entry.zip) entry.zip = zip;
      if (city && !entry.city) entry.city = city;
    }
  }

  const out: AddressCandidate[] = [];
  for (const [normalized, e] of byKey) {
    if (e.count < minSendCount) continue;
    out.push({
      normalized,
      display: e.display,
      sendCount: e.count,
      threadCount: e.threads.size,
      ...(e.zip && { zip: e.zip }),
      ...(e.city && { city: e.city }),
      lastSeenAt: e.last,
    });
  }

  // Most-sent first — the top of this list is her active inventory.
  out.sort((a, b) => {
    if (a.sendCount !== b.sendCount) return b.sendCount - a.sendCount;
    if (a.threadCount !== b.threadCount) return b.threadCount - a.threadCount;
    return a.normalized.localeCompare(b.normalized);
  });
  return out;
}

/**
 * A property key for folding together the SAME address written several ways.
 *
 * The founder writes one property up to four ways — "470 Bolton Rd",
 * "470 Bolton Rd NW", "470 Bolton Rd NW, Atlanta, GA", "470 Bolton Rd NW
 * Atlanta, GA 30331" — so keying on the full normalized string produced 32
 * duplicate-looking rows out of 86. Keying on house number + first street word
 * folds those into one.
 *
 * THE UNIT DESIGNATOR IS PART OF THE KEY. "846 Durant Pl NE Unit 2" and
 * "846 Durant Pl NE Unit 5" are genuinely different dwellings in one building,
 * and collapsing them would silently merge two properties — the one error here
 * that would survive review unnoticed, because the merged row looks perfectly
 * reasonable.
 */
export function looseAddressKey(raw: string): string {
  const norm = normalizeAddress(raw);
  const head = norm.match(/^(\d{1,6})\s+([a-z0-9'-]+)/);
  if (!head) return norm;
  const unit = norm.match(/\b(?:apt|unit|ste|suite)\s*([a-z0-9-]+)/);
  return unit ? `${head[1]} ${head[2]} #${unit[1]}` : `${head[1]} ${head[2]}`;
}

/** The base (building) part of a property key, with any `#unit` suffix removed. */
export function baseAddressKey(propertyKey: string): string {
  return propertyKey.replace(/\s+#.*$/, '');
}

/**
 * Property keys whose BARE form coexists with unit-bearing siblings — e.g.
 * "846 durant" alongside "846 durant #2" and "846 durant #5".
 *
 * This is the one genuinely ambiguous case in her address data: the bare
 * spelling might be the building, or shorthand for one of the units. It cannot
 * be detected within a single key (the unit designator is part of the key), only
 * across siblings — so it is computed over the whole key set and the bare key is
 * flagged for her.
 */
export function findUnitAmbiguousKeys(propertyKeys: Iterable<string>): Set<string> {
  const keys = [...propertyKeys];
  const basesWithUnits = new Set<string>();
  for (const k of keys) if (k.includes('#')) basesWithUnits.add(baseAddressKey(k));
  const out = new Set<string>();
  for (const k of keys) if (!k.includes('#') && basesWithUnits.has(k)) out.add(k);
  return out;
}

/** Pick the most informative spelling: the longest one that carries a ZIP, else the longest. */
export function bestSpelling(spellings: readonly string[]): string {
  const withZip = spellings.filter((s) => /\b\d{5}\b/.test(s));
  const pool = withZip.length > 0 ? withZip : spellings;
  return [...pool].sort((a, b) => b.length - a.length || a.localeCompare(b))[0] ?? '';
}

/** Collapse whitespace/newlines and drop the "United States" line Quo appends. */
function tidyDisplay(raw: string): string {
  return raw
    .replace(/\bunited states\b/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/[,\s]+$/, '')
    .trim();
}

/** Strip dangling separators left behind when a span is cut out of the middle. */
function tidyRemainder(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/(?:\s*,)+\s*,/g, ',')
    .replace(/^[,\s]+/, '')
    .replace(/[,\s]+$/, '')
    .trim();
}

/** Remove `[start, start+length)` from `text` and tidy what closes over the gap. */
function cut(text: string, start: number, length: number): string {
  return tidyRemainder(text.slice(0, start) + ' ' + text.slice(start + length));
}

/**
 * `Apt 4` / `Unit 104` / `Suite 2295` / `#5` - the second address line.
 *
 * The `\b` AFTER the keyword is load-bearing: without it "Overlook Apartments"
 * parses as line1 "Overlook" + line2 "Apartments", because `apartment` matches
 * inside the plural and swallows the "s" as its designator token. Two of the
 * founder's properties are named "<Something> Apartments".
 */
const UNIT_DESIGNATOR_RE =
  /\b(?:apt|apartment|unit|ste|suite|bldg|building)\b\.?\s*[A-Za-z0-9-]+\b|#\s*[A-Za-z0-9-]+\b/i;

const STATE_TAIL_RE = /[,\s]+(?:GA|Georgia)\.?$/i;

const CITY_TAIL_RE = new RegExp(String.raw`[,\s]+(${METRO_CITIES.join('|')})\.?$`, 'i');

/**
 * Parse ONE reviewed workbook address cell into the app's structured `Address`
 * (lib/address.ts) - the shape every consumer already expects.
 *
 * WHY THIS EXISTS. The workbook gives the founder a single free-text address
 * column (that is the review format she signed off on), but a plain string
 * stored in `unit.address` is not the contract: `toUnitFlyer` re-validates
 * through `validateAddress` and substitutes `{}`, so a public flyer shows NO
 * address at all, and `formatStreet` prints a legacy string VERBATIM, so tour
 * reminder SMS copy carries the postal tail instead of just the street.
 *
 * WHAT IT WILL NOT DO. It never invents a field. A cell with no ZIP gets no
 * ZIP; a city outside METRO_CITIES stays in the street line; the state is set
 * only where she actually wrote GA/Georgia. Anything it cannot classify -
 * including the handful of cells that still carry chat text around the address -
 * is left VERBATIM in `line1` rather than silently trimmed away, because a
 * wrong-but-tidy address is worse than an honest messy one.
 *
 * Extraction runs tail-first (ZIP, then state, then city, then the unit
 * designator) and each part must sit where a postal tail sits: the city is only
 * taken when it TRAILS the remaining text, so "1234 College Park Dr" keeps its
 * street name while "404 Corvair Dr Atlanta" yields city Atlanta.
 *
 * NOTE the caller keeps seeding `unitId` from the raw normalized string
 * (`unitIdForAddress(normalizeAddress(raw))`). Deriving identity from the parsed
 * parts instead would re-mint every unitId and duplicate the whole book.
 */
export function parseUnitAddress(raw: string): Address {
  let rest = tidyDisplay(raw);
  if (rest === '') return {};
  const out: Address = {};

  // ZIP: a standalone 5-digit token that is NOT the leading house number
  // ("30318" in "672 Cameron Alexander Blvd NW, 30318 Unit A"; never the "0058"
  // that opens a street line). The LAST such token wins - the postal tail sits
  // at the end even when a unit designator follows it.
  const zips = [...rest.matchAll(/\b\d{5}(?:-\d{4})?\b/g)].filter((m) => (m.index ?? 0) > 0);
  const zip = zips[zips.length - 1];
  if (zip !== undefined) {
    out.zip = zip[0].slice(0, 5);
    rest = cut(rest, zip.index ?? 0, zip[0].length);
  }

  // STATE: trailing GA/Georgia only, normalized to the 2-letter code.
  const state = rest.match(STATE_TAIL_RE);
  if (state !== undefined && state !== null) {
    out.state = 'GA';
    rest = tidyRemainder(rest.slice(0, state.index));
  }

  // CITY: trailing known municipality only (see the doc comment).
  const city = rest.match(CITY_TAIL_RE);
  if (city !== null && city.index !== undefined) {
    const remainder = tidyRemainder(rest.slice(0, city.index));
    // A cell that is ONLY a city name keeps it as the street line instead:
    // dropping it would leave a unit with no line1 at all.
    if (remainder !== '') {
      out.city = city[1]!;
      rest = remainder;
    }
  }

  // LINE2: the unit/apt designator, kept verbatim ("Unit 104", not "104").
  const designator = rest.match(UNIT_DESIGNATOR_RE);
  if (designator !== null && designator.index !== undefined) {
    const remainder = cut(rest, designator.index, designator[0].length);
    // Same guard: "Unit 2" alone is all the street line we have.
    if (remainder !== '') {
      out.line2 = designator[0].replace(/\s+/g, ' ').trim();
      rest = remainder;
    }
  }

  if (rest !== '') out.line1 = rest;
  return out;
}
