// tourTime — the submit-time sanity check both tour datetime dialogs share
// (ScheduleTourForm + the Book/Reschedule modals). An odd-looking time is a
// WARNING the operator confirms past (press the "... anyway" button again),
// never a hard block: back-dating a tour that already happened is legitimate,
// and so is a genuinely far-out booking — but both are usually typos (wrong
// month, wrong year), so the first submit stops to ask.

/** A booking further out than this asks the operator to confirm. */
export const FAR_FUTURE_DAYS = 14;

/**
 * The confirmable warning for a datetime-local value, or null when the time
 * needs no confirmation. Empty (a timeless tour) and unparseable values return
 * null — required/native input validation owns those, not this check.
 */
export function tourTimeWarning(local: string, now: number = Date.now()): string | null {
  if (local === '') return null;
  const ts = new Date(local).getTime();
  if (Number.isNaN(ts)) return null;
  if (ts <= now) return 'This date and time is in the past.';
  if (ts - now > FAR_FUTURE_DAYS * 24 * 3_600_000) {
    return `This date and time is more than ${FAR_FUTURE_DAYS} days from now.`;
  }
  return null;
}
