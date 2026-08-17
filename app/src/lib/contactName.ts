// "First Last - N Bed" name-convention parser (M1.2; doc §5: contact phones
// are auto-saved under this convention). This export is THE one true place
// the convention is parsed — M1.5 manual entry and M1.6 CSV import must use
// it rather than re-implementing the split.
//
// Pure function, no I/O, no logging.
import type { ContactItem } from '../repos/contactsRepo.js';

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

// contactDisplayName - the trimmed "First Last" join for push copy.
//
// SCOPE GUARD: five PRIVATE copies of this derivation already exist
// (routes/contacts.ts, routes/units.ts, lib/rosterResolution.ts,
// services/groupMembers.ts, services/inboundEmail.ts). This export is
// consumed by the inbound-message PUSH sites only; consolidating the
// older copies is tracked in
// docs/issues/consolidate-contact-display-name-helpers.md - do not
// re-point them here as a drive-by.
//
// `firstName`/`lastName` are NOT declared fields on ContactItem - they ride
// its index signature, so both reads are defensive: a non-string value must
// never reach `.trim()`.

/** Trimmed first/last join, or undefined when the contact has no name. */
export function contactDisplayName(contact: ContactItem | undefined): string | undefined {
  if (contact === undefined) return undefined;
  const first = typeof contact['firstName'] === 'string' ? contact['firstName'].trim() : '';
  const last = typeof contact['lastName'] === 'string' ? contact['lastName'].trim() : '';
  const joined = [first, last].filter((p) => p.length > 0).join(' ');
  return joined.length > 0 ? joined : undefined;
}
