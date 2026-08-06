// Per-request tally for read-path reminder-body composition failures.
//
// WHY THIS EXISTS: the three preview surfaces (tour reminders list, contact
// timeline, group-thread scheduled) each MAP over a rung ladder, and each
// contains UncomposableReminderError per rung by returning an empty body. A
// naive warn inside that catch fires ONCE PER RUNG - and these endpoints are
// among the hottest reads in the app: they refetch on every SSE burst and on a
// self-anchoring timer. One four-rung ladder with an unusable scheduledAt would
// emit thousands of identical lines and bury everything else in the log.
//
// So the catch RECORDS, and the request FLUSHES once with a count.
//
// PII: ids and counts only - never a body, a phone, or a name.
import type { Logger } from './logger.js';

export interface ComposeFailTally {
  count: number;
  /** First offender only - enough to reproduce, without N ids in one line. */
  firstReminderId?: string;
  firstTourId?: string;
}

export function newComposeFailTally(): ComposeFailTally {
  return { count: 0 };
}

export function recordComposeFail(
  tally: ComposeFailTally,
  row: { reminderId: string; kind: string },
  tour: { tourId: string },
): void {
  tally.count += 1;
  if (tally.firstReminderId === undefined) {
    tally.firstReminderId = row.reminderId;
    tally.firstTourId = tour.tourId;
  }
}

/** Emit at most ONE warn for the request. No-op when nothing failed. */
export function flushComposeFailTally(tally: ComposeFailTally, log: Logger, surface: string): void {
  if (tally.count === 0) return;
  log.warn(
    {
      surface,
      count: tally.count,
      ...(tally.firstReminderId !== undefined && { reminderId: tally.firstReminderId }),
      ...(tally.firstTourId !== undefined && { tourId: tally.firstTourId }),
    },
    'tour reminder bodies uncomposable on a read path - empty bodies returned',
  );
}
