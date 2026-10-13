// Listing-send tour chip derivation (listing-response-tour-chip, spec section 5).
//
// PURE - no I/O. Given ALL tours for ONE (unit, tenant) pairing, collapse them
// into the single most-progressed qualifying chip signal the rosters render
// ("Sent to" on the property page, "Properties sent" on the contact
// page). This is the single source of truth for the chip; both GET projections
// call it after grouping their tours strictly by the pairing.
//
// PRECEDENCE (most progressed wins):
//   toured  - any tour with status 'toured', OR a 'closed' tour that carries a
//             convertedPlacementId (a converted tour necessarily happened, so
//             "Toured" is the honest floor), OR a 'closed' tour the auto-close
//             sweep closed FROM 'toured' (autoClosedFrom, Sam #18: the visit
//             happened - only the decision is missing - the same honest
//             floor). Beats scheduled/requested outright.
//   scheduled - any 'scheduled' tour (booking IS the confirmation; the removed
//             'confirmed' status folded into 'scheduled' back in 2026-07-08, so
//             there is no separate 'confirmed' bucket to map).
//   requested - any 'requested' (timeless) tour.
// Disqualifying: 'canceled', 'no_show', and any other 'closed' - neither
// converted nor auto-closed from 'toured' (a person's not-a-fit, a tour
// auto-closed from 'scheduled' or 'no_show') - yield no signal (undefined) -
// the chip is simply absent on that row.
//
// TIES within the winning state: the most recently created qualifying tour wins
// (compare createdAt, ISO 8601 - lexical order is chronological); its tourId is
// returned so the chip links to that tour.
// deriveTourActivityAt (below) is the sibling the send OUTCOME reads (D11).
import type { TourItem } from '../repos/toursRepo.js';

/** The tour states a listing-send chip can show. */
export type TourSignalState = 'requested' | 'scheduled' | 'toured';

/** The derived chip signal: which tour to link to, and the state to render. */
export interface TourSignal {
  tourId: string;
  state: TourSignalState;
}

/** Higher rank = more progressed; used for precedence comparisons. */
const STATE_RANK: Readonly<Record<TourSignalState, number>> = {
  requested: 1,
  scheduled: 2,
  toured: 3,
};

/** True when `x` is a non-empty string (a real convertedPlacementId). */
function isNonEmptyString(x: unknown): x is string {
  return typeof x === 'string' && x.length > 0;
}

/**
 * Classify one tour into a qualifying chip state, or undefined when it does not
 * qualify ('canceled' / 'no_show' / a 'closed' tour that is neither converted
 * nor auto-closed from 'toured').
 */
function qualifyingState(tour: TourItem): TourSignalState | undefined {
  const status = tour.status;
  if (status === 'toured') return 'toured';
  if (status === 'closed' && isNonEmptyString(tour['convertedPlacementId'])) return 'toured';
  // Auto-closed from toured (Sam #18): the visit happened - only the decision
  // is missing - so "Toured" is the honest floor, as for a converted tour.
  if (status === 'closed' && tour['autoClosedFrom'] === 'toured') return 'toured';
  if (status === 'scheduled') return 'scheduled';
  if (status === 'requested') return 'requested';
  return undefined;
}

/**
 * Collapse all tours for one (unit, tenant) pairing into the single chip signal,
 * or undefined when none qualifies. See the module header for precedence + ties.
 */
export function deriveTourSignal(tours: TourItem[]): TourSignal | undefined {
  let best: { state: TourSignalState; tourId: string; createdAt: string } | undefined;
  for (const tour of tours) {
    const state = qualifyingState(tour);
    if (state === undefined) continue;
    const createdAt = typeof tour.createdAt === 'string' ? tour.createdAt : '';
    if (
      best === undefined ||
      STATE_RANK[state] > STATE_RANK[best.state] ||
      (STATE_RANK[state] === STATE_RANK[best.state] && createdAt > best.createdAt)
    ) {
      best = { state, tourId: tour.tourId, createdAt };
    }
  }
  return best === undefined ? undefined : { tourId: best.tourId, state: best.state };
}

/**
 * The pair's latest tour ACTIVITY instant (last-heard-from spec 5.4, D11):
 * the max over EVERY qualifying tour (the chip's set - requested, scheduled,
 * toured, converted, auto-closed from toured) of max(createdAt, lastMarkedAt).
 * `lastMarkedAt` is the model's "a person marked / rescheduled / reopened it"
 * (toursModel.ts; stamped by PATCH on any status change or new time in
 * routes/tours.ts, and by reopenIf) and is absent until a person acts, so
 * createdAt carries a fresh tour. NEVER updatedAt - that is
 * last-touched-by-anything (toursRepo.ts) and would let an automated write
 * undo a decline. A SEPARATE function, not a field on deriveTourSignal's
 * result: that result IS the wire `tour` field (route tests pin it with
 * toEqual({ tourId, state })). Not the chip winner's own time either: the
 * winner is the most PROGRESSED tour, so an old toured tour would hide a
 * request made after a decline. Returns the stored string of the latest
 * parseable instant, or undefined when no qualifying tour has one.
 */
export function deriveTourActivityAt(tours: TourItem[]): string | undefined {
  let best: { at: string; ms: number } | undefined;
  for (const tour of tours) {
    if (qualifyingState(tour) === undefined) continue;
    for (const candidate of [tour.createdAt, tour.lastMarkedAt]) {
      if (typeof candidate !== 'string' || candidate.length === 0) continue;
      const ms = Date.parse(candidate);
      if (!Number.isFinite(ms)) continue;
      if (best === undefined || ms > best.ms) best = { at: candidate, ms };
    }
  }
  return best?.at;
}
