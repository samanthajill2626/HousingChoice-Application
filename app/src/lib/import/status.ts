// Derived import status (spec §3.4).
//
// Every imported contact needs a status, and the two obvious answers are both
// wrong: putting all 543 in `needs_review` hands the founder a triage queue
// instead of a working pipeline, and putting all 478 tenants in `searching`
// asserts that people who went quiet in April are actively hunting.
//
// So status is DERIVED from last contact and stamped `status_source: 'import'`,
// which outranks `derived` in SOURCE_PRECEDENCE — anything the founder or the
// automation does later cleanly overrides it.
//
// The threshold is a placeholder until the founder gives us her number: "how long
// before you stop considering someone an active client" is a question she can
// answer instantly and we can only guess at. It is one constant, so re-planning
// against a different value costs seconds.

import type { ContactType } from '../../repos/contactsRepo.js';

/** Days since last contact before an imported tenant is parked on `on_hold`. */
export const DEFAULT_ACTIVE_WINDOW_DAYS = 30;

export interface StatusInput {
  type: ContactType;
  /** ISO 8601 of the most recent message or call, if any. */
  lastContactAt?: string;
  /** The clock — the export's newest timestamp, NOT wall-clock now (see below). */
  asOf: string;
  activeWindowDays?: number;
}

/**
 * Derive the import status for one contact.
 *
 * `asOf` is the export's own newest timestamp rather than the current time on
 * purpose: it makes the plan a pure function of the export files, so re-running
 * the same export next week produces a byte-identical workbook. Anchoring to
 * wall-clock would silently reclassify people as the clock advanced and make the
 * founder's review diff full of phantom changes.
 */
export function deriveStatus(input: StatusInput): string {
  const { type, lastContactAt, asOf } = input;
  const windowDays = input.activeWindowDays ?? DEFAULT_ACTIVE_WINDOW_DAYS;

  // No traffic at all — we know nothing about this person beyond a saved name.
  if (!lastContactAt) return 'needs_review';

  if (type === 'tenant') {
    return daysBetween(lastContactAt, asOf) <= windowDays ? 'searching' : 'on_hold';
  }

  // A handshake in her book means she is working with them (spec §3.4).
  if (type === 'landlord') return 'active';

  // partner (incl. caseworkers) and team_member have no lifecycle: needs_review | active.
  if (type === 'partner' || type === 'team_member') return 'active';

  // `unknown` never claims more than it knows — this IS the triage queue.
  return 'needs_review';
}

/** Whole days between two ISO timestamps. Negative differences clamp to 0. */
export function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor((to - from) / 86_400_000));
}
