// Decoding the founder's naming conventions (spec §2.3).
//
// Sam encodes her data model in Quo contact names. Measured over the real
// 2026-08-05 export (828 rows):
//
//   -Nbed suffix   voucher bedroom size. 724 rows (88%). Spelling varies:
//                  "-3bed", "- 2 Bed", "-3 Bed", "-1bed".
//   handshake      landlord marker. 19 rows in Quo, and independently the same
//                  convention in the Airtable landlord table (13 rows) — which
//                  is what raises it from "a guess" to "her convention".
//   *              18 rows. MEANING UNKNOWN — an open founder question. We
//                  strip it from the display name and surface it as a flag; we
//                  never invent a meaning for it.
//
// Everything here is a pure function over a raw name string.

/** The handshake emoji (U+1F91D) Sam prefixes onto landlord contacts. */
const HANDSHAKE = '\u{1F91D}';

/**
 * Bedroom-size suffix. Anchored to the END of the string so a name that merely
 * contains a digit ("Apt 2 Mike") cannot match, and tolerant of the separator
 * and spacing variants seen in the real data.
 *
 * Matches: "Jermelle Daniel-5bed", "Ms. Cooper- 2 Bed", "Maliko Hawkins-3 Bed".
 */
const BED_SUFFIX_RE = /[\s–-]*\s*(\d)\s*bed(?:room)?s?\s*$/i;

/** Caseworker marker, seen as a free-text suffix ("Muhammad Khateeb caseworker"). */
const CASEWORKER_RE = /\bcase\s*worker\b/i;

/** Names that are obviously test/system rows rather than real people. */
const NON_PERSON_RE = /^(quo team|quo|test\b|saman test)/i;

export interface ParsedName {
  /** Display name with markers and the bed suffix removed. May be ''. */
  clean: string;
  /** Voucher bedroom size parsed from the name, when present. */
  voucherBeds?: number;
  /** The handshake landlord marker was present. */
  isLandlordMarked: boolean;
  /** The `*` marker was present. Meaning unknown — surfaced, never interpreted. */
  hasStarMarker: boolean;
  /** The name says "caseworker". */
  isCaseworkerMarked: boolean;
  /** Looks like a Quo system contact or an explicit test row. */
  isNonPerson: boolean;
}

/**
 * Decode one raw name.
 *
 * Order matters: markers are stripped BEFORE the bed suffix, because the star
 * sits between the name and the suffix ("Jasmine Maddox*-3bed") and would
 * otherwise block the anchored suffix match.
 */
export function parseName(raw: string): ParsedName {
  const original = (raw ?? '').trim();

  const isLandlordMarked = original.includes(HANDSHAKE);
  const hasStarMarker = original.includes('*');
  const isCaseworkerMarked = CASEWORKER_RE.test(original);

  // Strip markers first so the anchored bed suffix can match.
  let working = original
    .replace(new RegExp(HANDSHAKE, 'gu'), ' ')
    .replace(/\*/g, ' ')
    .replace(CASEWORKER_RE, ' ');

  let voucherBeds: number | undefined;
  const bed = working.match(BED_SUFFIX_RE);
  if (bed) {
    const n = Number(bed[1]);
    // Guard the range: a voucher is 0-5+ bedrooms; anything else is not a size.
    if (Number.isInteger(n) && n >= 0 && n <= 9) voucherBeds = n;
    working = working.slice(0, bed.index);
  }

  const clean = tidy(working);
  return {
    clean,
    ...(voucherBeds !== undefined && { voucherBeds }),
    isLandlordMarked,
    hasStarMarker,
    isCaseworkerMarked,
    isNonPerson: NON_PERSON_RE.test(clean) || NON_PERSON_RE.test(original),
  };
}

/**
 * Collapse whitespace and trim separator debris left behind by marker removal
 * ("Robert Esther- " -> "Robert Esther", "- 3bed" -> "").
 */
function tidy(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/^[\s–,;:-]+/, '')
    .replace(/[\s–,;:-]+$/, '')
    .trim();
}

/**
 * Choose the best display name across every raw variant seen for one person.
 *
 * After merging on phone, one person may carry several Quo rows with different
 * names ("Jacqueline Wallace" / "" / "Jacqueline Wallace-2bed"). Preference:
 * the longest cleaned name wins, because the longer variant is nearly always the
 * more complete one (full name over first name, "Catina Brown" over "Catina").
 * Ties break toward the first occurrence for determinism across runs.
 */
export function bestDisplayName(rawNames: readonly string[]): string {
  let best = '';
  for (const raw of rawNames) {
    const { clean } = parseName(raw);
    if (clean.length > best.length) best = clean;
  }
  return best;
}

/**
 * Every distinct voucher size seen across a person's raw names.
 *
 * Returns a sorted array so a caller can detect a conflict (length > 1) and
 * surface it for human resolution. Four of 478 tenants in the real export have
 * one; the spec is explicit that we never auto-resolve these.
 */
export function voucherSizesSeen(rawNames: readonly string[]): number[] {
  const sizes = new Set<number>();
  for (const raw of rawNames) {
    const { voucherBeds } = parseName(raw);
    if (voucherBeds !== undefined) sizes.add(voucherBeds);
  }
  return [...sizes].sort((a, b) => a - b);
}
