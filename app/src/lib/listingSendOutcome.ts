// Listing-send OUTCOME rules (last-heard-from spec 5.4, 5.6, D11; section 14).
//
// PURE - no I/O. One module owns every rule an outcome-serving surface needs,
// so the units recipients read, the contact listings-sent read, the outcome
// route and the follow-ups list can never disagree:
//   - effectiveDecline: a recorded `declined` counts until a later counted
//     share (the row's sentAt) or later tour ACTIVITY supersedes it;
//   - deriveListingSendOutcome: not_interested > interested > replied >
//     no_reply, and a non-tenant recipient never reads a tour;
//   - isEligibleRecipient: the follow-up eligibility half (one rule, B6);
//   - interestedModeFor: 'route' when the unit has a structured tour_type;
//   - isWaiting / waitingSince: the waiting-on-a-reply rule (5.6).
// NOT lib/sendOutcome.ts - that name is the Twilio send-failure vocabulary
// (spec 14.1).
//
// Every instant comparison goes through Date.parse (spec section 7): a stored
// value may lack milliseconds, and an unparseable one never wins.
import type { TourSignal } from './listingSendTour.js';

export type ListingSendOutcome = 'no_reply' | 'replied' | 'interested' | 'not_interested';
export type InterestedMode = 'route' | 'form';

/** A waiting row is listed once the pair has been quiet this long. */
export const FOLLOW_UP_QUIET_MS = 24 * 3600 * 1000;
/** A send older than this is no longer chased. */
export const FOLLOW_UP_LOOKBACK_MS = 14 * 86400 * 1000;

/** The stored decline (listing_sends.declined). `staffId` never reaches the wire. */
export interface DeclineRecord {
  at: string;
  by: 'staff' | 'engine';
  staffId?: string;
}

/** Epoch ms of a non-empty ISO string; undefined when absent or unparseable. */
function instantMs(iso: string | undefined): number | undefined {
  if (typeof iso !== 'string' || iso.length === 0) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * D11: a decline is effective unless something LATER supersedes it - a
 * counted share (the row's sentAt follows the latest counted share) or tour
 * activity (deriveTourActivityAt). Equal instants keep it effective.
 */
export function effectiveDecline(
  row: { declined?: DeclineRecord; sentAt?: string },
  tourActivityAt: string | undefined,
): boolean {
  if (row.declined === undefined) return false;
  const declinedMs = instantMs(row.declined.at);
  if (declinedMs === undefined) return false;
  const sentMs = instantMs(row.sentAt);
  if (sentMs !== undefined && declinedMs < sentMs) return false;
  const tourMs = instantMs(tourActivityAt);
  if (tourMs !== undefined && declinedMs < tourMs) return false;
  return true;
}

/**
 * The ONE outcome derivation (spec 5.4). A recipient whose type is not
 * 'tenant' never reads a tour: neither the signal nor its activity (the tours
 * API accepts any contactId, and a converted caseworker keeps tenant-era
 * tours).
 */
export function deriveListingSendOutcome(input: {
  row: { declined?: DeclineRecord; sentAt?: string };
  recipientType: string | undefined;
  lastHeardFromAt: string | undefined;
  tour: TourSignal | undefined;
  tourActivityAt: string | undefined;
}): ListingSendOutcome {
  const readsTours = input.recipientType === 'tenant';
  const tour = readsTours ? input.tour : undefined;
  const tourActivityAt = readsTours ? input.tourActivityAt : undefined;
  if (effectiveDecline(input.row, tourActivityAt)) return 'not_interested';
  if (tour !== undefined) return 'interested';
  const heardMs = instantMs(input.lastHeardFromAt);
  const sentMs = instantMs(input.row.sentAt);
  if (heardMs !== undefined && sentMs !== undefined && heardMs > sentMs) return 'replied';
  return 'no_reply';
}

/** The wire `declined` (spec 5.4): present ONLY while effective; never staffId. */
export function wireDecline(
  row: { declined?: DeclineRecord },
  outcome: ListingSendOutcome,
): { at: string; by: 'staff' | 'engine' } | undefined {
  if (outcome !== 'not_interested' || row.declined === undefined) return undefined;
  return { at: row.declined.at, by: row.declined.by };
}

/** Spec 5.6 / B6: can this recipient be chased by text at all? */
export function isEligibleRecipient(c: {
  type?: string;
  status?: string;
  deleted_at?: string;
  sms_opt_out?: boolean;
  sms_unreachable?: boolean;
  phone?: string;
}): boolean {
  if (typeof c.deleted_at === 'string' && c.deleted_at.length > 0) return false;
  if (c.sms_opt_out === true || c.sms_unreachable === true) return false;
  if (typeof c.phone !== 'string' || c.phone.length === 0) return false;
  if (c.type === 'tenant' && (c.status === 'inactive' || c.status === 'placed')) return false;
  return true;
}

/** D14: one click creates the tour only when the unit says how it tours. */
export function interestedModeFor(unit: { tour_type?: string }): InterestedMode {
  return typeof unit.tour_type === 'string' && unit.tour_type.length > 0 ? 'route' : 'form';
}

/** Spec 5.6: a send waiting on a reply (outcome, eligibility, lookback, quiet). */
export function isWaiting(input: {
  outcome: ListingSendOutcome;
  eligible: boolean;
  sentAt: string;
  lastHeardFromAt?: string;
  now: number;
}): boolean {
  if (input.outcome !== 'no_reply' && input.outcome !== 'replied') return false;
  if (!input.eligible) return false;
  const sentMs = instantMs(input.sentAt);
  if (sentMs === undefined) return false;
  if (input.now - sentMs > FOLLOW_UP_LOOKBACK_MS) return false;
  const heardMs = instantMs(input.lastHeardFromAt);
  const quietSince = heardMs !== undefined && heardMs > sentMs ? heardMs : sentMs;
  return input.now - quietSince >= FOLLOW_UP_QUIET_MS;
}

/** Spec 5.6: the instant a waiting row has been quiet since. */
export function waitingSince(sentAt: string, lastHeardFromAt?: string): string {
  const sentMs = instantMs(sentAt);
  const heardMs = instantMs(lastHeardFromAt);
  if (lastHeardFromAt !== undefined && heardMs !== undefined && (sentMs === undefined || heardMs > sentMs)) {
    return lastHeardFromAt;
  }
  return sentAt;
}
