// tourReopen - which state a closed tour reopens INTO, mirrored from the
// server's reopenTargetFor (app/src/lib/toursModel.ts, spec 7.2) so the tour
// page offers Reopen exactly when POST /reopen would accept it. App and
// dashboard share no code; keep the two in step.
import type { Tour } from '../../api/index.js';

export type ReopenTarget = 'scheduled' | 'toured' | 'no_show';

const REOPEN_TARGETS: ReadonlySet<string> = new Set(['scheduled', 'toured', 'no_show']);

/** The state a reopen returns this tour to, or null when it cannot reopen. */
export function reopenTargetOf(tour: Tour): ReopenTarget | null {
  if (tour.status !== 'closed') return null;
  if (typeof tour.convertedPlacementId === 'string') return null;
  if (typeof tour.autoClosedFrom === 'string' && REOPEN_TARGETS.has(tour.autoClosedFrom)) {
    return tour.autoClosedFrom;
  }
  if (tour.outcome === 'not_a_fit' || tour.outcome === 'move_forward') return 'toured';
  return null;
}

/** The confirm dialog's body, by target (spec 9.2). */
export const REOPEN_BODY: Readonly<Record<ReopenTarget, string>> = {
  toured: 'This tour goes back to Toured so you can record a different outcome. Nothing is sent.',
  no_show: 'This tour goes back to No show so you can reschedule it. Nothing is sent.',
  scheduled:
    'This tour goes back to Not marked so you can mark it toured or a no-show, or reschedule it. Nothing is sent.',
};
