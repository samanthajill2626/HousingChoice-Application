// tourTime — the submit-time sanity check both tour datetime dialogs share
// (ScheduleTourForm + the Book/Reschedule modals). An odd-looking time is a
// WARNING the operator confirms past (press the "... anyway" button again),
// never a hard block: back-dating a tour that already happened is legitimate,
// and so is a genuinely far-out booking — but both are usually typos (wrong
// month, wrong year), so the first submit stops to ask.
//
// Also the list rows' date/time display (the Tours page's rows and the Today
// page's past-tours rows), so both pages print a tour's time the same way.

/** A booking further out than this asks the operator to confirm. */
export const FAR_FUTURE_DAYS = 14;

/**
 * The datetime-local value for "today at the current hour, minutes 00" — the
 * datetime pickers' starting value (Cameron, 2026-07-14: anchor the picker on
 * the whole hour, never the live minute). Local time, minute precision, no
 * seconds — exactly the format datetime-local inputs round-trip.
 */
export function currentHourLocal(now: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}T${p(now.getHours())}:00`;
}

/**
 * The confirmable warning for a datetime-local value, or null when the time
 * needs no confirmation. Empty (a timeless tour) and unparseable values return
 * null — required/native input validation owns those, not this check.
 */
/**
 * The confirmable warning for an ALREADY-HAPPENED tour's datetime-local value -
 * the mirror image of tourTimeWarning. A past time is the NORMAL case here, so
 * only a FUTURE one asks for confirmation (usually a mistyped month or year on
 * a tour being recorded after the fact). Empty (the field is optional) and
 * unparseable values return null.
 */
export function pastTourTimeWarning(local: string, now: number = Date.now()): string | null {
  if (local === '') return null;
  const ts = new Date(local).getTime();
  if (Number.isNaN(ts)) return null;
  if (ts > now) return 'This date and time is in the future.';
  return null;
}

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

// ---------------------------------------------------------------------------
// Row display
// ---------------------------------------------------------------------------

/** Format just the time part of a scheduledAt ISO string for display, e.g.
 *  "2:30 PM". Returns '' when absent or unparseable. */
export function formatTime(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/** Format the DATE of a scheduledAt ISO string, e.g. "Jul 14, 2026" - the
 *  Closed section's lead column (a months-old tour's time-of-day is noise).
 *  Returns '' when absent or unparseable. */
export function formatDate(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** U+202F / U+00A0: the en-US formatters emit one before AM/PM on ICU 72+
 *  hosts (the repo convention, inbox/inboxTime.ts, maps them to U+0020). */
const NBSP_LIKE = /[\u202f\u00a0]/g;

/** A past-tour row's "Sep 24, 2026, 2:30 PM" string (also the suffix of every
 *  label), with plain spaces only, so the text and every accessible name read
 *  the same on every host. '' for an undated tour. */
export function whenLabel(iso: string | undefined): string {
  return [formatDate(iso), formatTime(iso)]
    .filter((s) => s.length > 0)
    .join(', ')
    .replace(NBSP_LIKE, ' ');
}
