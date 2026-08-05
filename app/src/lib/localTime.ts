// Org-local date/time rendering for user-facing copy.
//
// Pure, structural inputs, no clock reads, no repo imports - the lib/quietHours.ts
// discipline, including its cached-formatter idiom (constructing an
// Intl.DateTimeFormat is the expensive part; formatToParts on a cached instance
// is cheap).
//
// ASCII NORMALIZATION IS LOAD-BEARING, not cosmetic. ICU 72 shipped U+202F
// NARROW NO-BREAK SPACE between the time and the meridiem. A single one of those
// inside an SMS body flips the whole message from GSM-7 to UCS-2, collapsing the
// budget from 160 characters to 70. This repo's Node 24 (ICU 78) emits a plain
// space, but a Node bump must never be able to double the SMS bill silently.
// app/test/localTime.test.ts is the tripwire.

const dateCache = new Map<string, Intl.DateTimeFormat>();
const timeCache = new Map<string, Intl.DateTimeFormat>();

function dateFormatterFor(timezone: string): Intl.DateTimeFormat {
  let f = dateCache.get(timezone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
    dateCache.set(timezone, f);
  }
  return f;
}

function timeFormatterFor(timezone: string): Intl.DateTimeFormat {
  let f = timeCache.get(timezone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
    timeCache.set(timezone, f);
  }
  return f;
}

/** U+00A0 NO-BREAK SPACE and U+202F NARROW NO-BREAK SPACE -> plain space. */
function toAscii(s: string): string {
  return s.replace(/[\u00A0\u202F]/g, ' ');
}

/** "Thu, Jul 23" in `timezone`. Throws RangeError on an unparseable instant. */
export function formatLocalDate(iso: string, timezone: string): string {
  return toAscii(dateFormatterFor(timezone).format(new Date(iso)));
}

/** "3:00 PM" in `timezone`. Throws RangeError on an unparseable instant. */
export function formatLocalTime(iso: string, timezone: string): string {
  return toAscii(timeFormatterFor(timezone).format(new Date(iso)));
}
