// Tour reminder GENERATION POINTER comparison (supersession, 2026-09-01).
//
// A tour's `currentLadderId` names the armTourReminders call whose rows are the
// live ladder; every row carries the `ladderId` of the call that wrote it. This
// module holds the ONE comparison, because four call sites depend on agreeing
// about a single row - the poll (jobs/tourReminders.ts), and the three preview
// surfaces that each render a pending rung as a promise it will send
// (routes/tourReminders.ts, routes/contactTimeline.ts, routes/relayGroups.ts).
// A surface that decided this for itself could show "sends in 6 days" for a
// rung the poll refuses, which is the exact lie the feature exists to end.
//
// Pure, clock-free and repo-free: the caller brings both halves.
import type { TourReminderItem } from '../repos/tourRemindersRepo.js';
import type { TourItem } from '../repos/toursRepo.js';

/**
 * Does this rung belong to a ladder its tour has already replaced?
 *
 * The four cells, and why the two asymmetric ones answer the way they do:
 *
 * | tour pointer | row ladderId | answer |
 * | --- | --- | --- |
 * | set | equal      | false - the current generation |
 * | set | different  | TRUE  - a later arm replaced it |
 * | set | ABSENT     | TRUE  - the tour has been armed since the migration, so
 * |     |            |         its pre-migration rows name a generation it no
 * |     |            |         longer points at |
 * | ABSENT | ABSENT  | false - PRE-MIGRATION PAIR, exempt. Refusing here would
 * |        |         |         retire every rung armed before this feature on
 * |        |         |         its first poll. |
 * | ABSENT | set     | TRUE  - the INTERRUPTION case: the armer stamped the
 * |        |         |         rows and the pointer write never landed (the
 * |        |         |         route logs that LOUDLY). Refused deliberately -
 * |        |         |         reading a stamped row as pre-migration would
 * |        |         |         turn every failed pointer write into a silent
 * |        |         |         send from a generation nothing can name.
 *
 * Takes the narrowest shapes that can answer, so callers holding a projection
 * (or a test holding a literal) can use it without building whole items.
 */
export function isSupersededRung(
  row: Pick<TourReminderItem, 'ladderId'>,
  tour: Pick<TourItem, 'currentLadderId'>,
): boolean {
  if (tour.currentLadderId !== undefined) return row.ladderId !== tour.currentLadderId;
  return row.ladderId !== undefined;
}
