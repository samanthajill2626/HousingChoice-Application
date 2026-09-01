// "First Last - N Bed" name-convention parser (M1.2; doc §5: contact phones
// are auto-saved under this convention). This export is THE one true place
// the convention is parsed — M1.5 manual entry and M1.6 CSV import must use
// it rather than re-implementing the split.
//
// Pure function, no I/O, no logging.

/** Parsed components of a conforming "First Last - N Bed" string. */
export interface ParsedContactName {
  firstName: string;
  /** Everything after the first name token — multi-word and hyphenated last names survive intact. */
  lastName: string;
  /** Voucher bedroom count; 0 means studio/efficiency ("First Last - Studio"). */
  voucherSize: number;
}

// Anatomy: `<name> - <size>` where <size> is `N Bed`/`N Beds`/`N Bedroom(s)`
// or `Studio` (case-insensitive, whitespace slop tolerated throughout). The
// name capture is GREEDY so hyphens INSIDE names ("Anna Smith-Jones - 2 Bed")
// never split early — the LAST hyphen followed by a valid size token is the
// separator.
const CONVENTION_RE = /^\s*(.+)\s*-\s*(?:(\d{1,2})\s*bed(?:room)?s?|studio)\s*$/i;

/**
 * Parse a "First Last - N Bed" string. Returns undefined for anything
 * non-conforming (no size suffix, single-token names, garbage) — callers
 * treat that as "not the convention", never as an error.
 */
export function parseContactName(raw: string): ParsedContactName | undefined {
  const match = CONVENTION_RE.exec(raw);
  if (!match) return undefined;
  const namePart = match[1];
  const bedrooms = match[2];
  if (namePart === undefined) return undefined; // unreachable; type narrowing

  const tokens = namePart.trim().split(/\s+/);
  // The convention is FIRST LAST — a single token is non-conforming.
  if (tokens.length < 2) return undefined;
  const firstName = tokens[0];
  if (firstName === undefined) return undefined; // unreachable; type narrowing

  return {
    firstName,
    lastName: tokens.slice(1).join(' '),
    voucherSize: bedrooms === undefined ? 0 : Number(bedrooms),
  };
}

// contactDisplayName - THE trimmed "First Last" join for any surface that
// holds a contact, or the display projection of one.
//
// Accepts the MINIMAL shape both contact reads satisfy - a whole ContactItem
// (getById / getManyByIds) and the ContactDisplayItem projection
// (getDisplayById / getDisplaysByIds) - so a label-only batch read never has to
// widen to a whole-item read just to name someone. `contactId` is here only as
// the anchor that keeps TypeScript's weak-type check honest (the same trick as
// routes/units.ts displayNameOfContact); the name comes from the two optional
// fields.
//
// Consumers include the inbound-message and voice pushes and the participant
// name resolver in lib/participantNames.ts. Private copies of this derivation
// still exist in routes/inbox.ts and routes/today.ts and DIFFER from this one
// on purpose (an extra `contact.name` rung; outer-vs-part trimming); see
// docs/issues/consolidate-contact-display-name-helpers.md before re-pointing
// any of them.
//
// `firstName`/`lastName` are NOT declared string fields - they ride an index
// signature or are typed `unknown` - so both reads are defensive: a non-string
// value must never reach `.trim()`.

/** Trimmed first/last join, or undefined when the contact has no name. */
export function contactDisplayName(
  contact: { contactId: string; firstName?: unknown; lastName?: unknown } | undefined,
): string | undefined {
  if (contact === undefined) return undefined;
  const first = typeof contact.firstName === 'string' ? contact.firstName.trim() : '';
  const last = typeof contact.lastName === 'string' ? contact.lastName.trim() : '';
  const joined = [first, last].filter((p) => p.length > 0).join(' ');
  return joined.length > 0 ? joined : undefined;
}
