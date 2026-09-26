// inboxTime - the last-activity label on an inbox row (spec 5.3). Four tiers
// by LOCAL calendar day: today -> "2:14 PM", the previous day -> "Yesterday",
// earlier this year -> "Sep 12", other years -> "Sep 12, 2025". An
// unparseable instant answers '' (the formatTime contract in contact/format.ts)
// and the row renders no <time> at all.
//
// The en-US formatters may emit U+202F (narrow no-break space) before AM/PM on
// ICU 72+ hosts; app/src/lib/localTime.ts normalizes the same thing on the
// server. Every label here carries a plain U+0020 so tests, e2e regexes and
// copy-paste behave the same on every host.
import { isoOf } from '../../lib/time.js';

const NBSP_LIKE = /[\u202f\u00a0]/g;

// Built ONCE, at module load (AD-1). A Date.prototype.toLocale*String call
// with an options bag constructs a fresh DateTimeFormat every time, and each
// row formats twice per Inbox render; reusing four formatters keeps a render
// of hundreds of rows cheap. Same locale and options, so the same strings.
const TIME_FMT = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
const MONTH_DAY_FMT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const MONTH_DAY_YEAR_FMT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});
const FULL_FMT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function parse(iso: string): Date | undefined {
  const d = new Date(isoOf(iso));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function plainSpaces(s: string): string {
  return s.replace(NBSP_LIKE, ' ');
}

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** The tier label for a row's lastActivityAt, relative to `now` (local days). */
export function formatInboxTime(iso: string, now: Date): string {
  const d = parse(iso);
  if (d === undefined) return '';
  if (sameLocalDay(d, now)) return plainSpaces(TIME_FMT.format(d));
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameLocalDay(d, yesterday)) return 'Yesterday';
  if (d.getFullYear() === now.getFullYear()) return plainSpaces(MONTH_DAY_FMT.format(d));
  return plainSpaces(MONTH_DAY_YEAR_FMT.format(d));
}

/** The full stamp for the row's hover title, e.g. "Sep 12, 2026, 2:14 PM". */
export function formatInboxTimeFull(iso: string): string {
  const d = parse(iso);
  if (d === undefined) return '';
  return plainSpaces(FULL_FMT.format(d));
}
