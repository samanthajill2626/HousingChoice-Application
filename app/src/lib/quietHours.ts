// Quiet-hours core (spec: docs/superpowers/specs/2026-08-03-quiet-hours-design.md).
// Pure functions, structural inputs, no repo imports, no inline clock reads -
// callers pass ISO instants in. Timezone math via Intl.DateTimeFormat only.
//
// Window semantics: start-inclusive, end-exclusive ([21:00, 08:00) local).
// A wrapping window (start > end) wraps LOCAL midnight, never UTC midnight.
// DST: instantAtLocalTime converges via a two-pass offset correction; the
// pollers' pre-claim backstop (jobs/*) is the guarantee that even a wrong
// clamp on a DST night can never SEND inside the window.

export interface QuietHoursWindow {
  enabled: boolean;
  start: string;    // "HH:MM" 24h
  end: string;      // "HH:MM" 24h
  timezone: string; // IANA zone id
}

export function quietHoursWindowOf(settings: {
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  timezone: string;
}): QuietHoursWindow {
  return {
    enabled: settings.quietHoursEnabled,
    start: settings.quietHoursStart,
    end: settings.quietHoursEnd,
    timezone: settings.timezone,
  };
}

/**
 * The per-recipient timezone seam (spec section 4). Today every recipient uses
 * the org timezone; when the org scales beyond one timezone, a contact-level
 * (or client-org-level) timezone field overrides HERE and every call site
 * becomes recipient-local without further change. `_contact` is accepted and
 * ignored on purpose - call sites already thread it where they have one.
 */
export function resolveQuietHoursTimezone(
  settings: { timezone: string },
  _contact?: unknown,
): string {
  return settings.timezone;
}

const HH_MM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidHhMm(v: string): boolean {
  return HH_MM_RE.test(v);
}

export function isValidIanaTimezone(v: string): boolean {
  if (v.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: v });
    return true;
  } catch {
    return false;
  }
}

interface LocalParts { y: number; m: number; d: number; hh: number; mm: number }

// One cached formatter per zone - Intl.DateTimeFormat construction is the
// expensive part; formatToParts on a cached instance is cheap.
const formatterCache = new Map<string, Intl.DateTimeFormat>();
function formatterFor(timezone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timezone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
    formatterCache.set(timezone, f);
  }
  return f;
}

function localPartsOf(ms: number, timezone: string): LocalParts {
  const parts = formatterFor(timezone).formatToParts(new Date(ms));
  const num = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    return part === undefined ? 0 : Number(part.value);
  };
  // Some ICU builds render midnight as "24" even with h23 - normalize.
  const hh = num('hour') === 24 ? 0 : num('hour');
  return { y: num('year'), m: num('month'), d: num('day'), hh, mm: num('minute') };
}

function minutesOfDay(p: LocalParts): number {
  return p.hh * 60 + p.mm;
}

function parseHhMm(v: string): number {
  const hh = Number(v.slice(0, 2));
  const mm = Number(v.slice(3, 5));
  return hh * 60 + mm;
}

/**
 * Materialize local wall-clock (y, m, d, hh, mm) in `timezone` as a UTC ms
 * timestamp. Two-pass offset correction: guess the instant as if the wall time
 * were UTC, read back what wall time that instant actually is in the zone, and
 * shift by the difference; a second pass converges across DST boundaries.
 * (Date.UTC handles day overflow, so callers may pass d+1 freely.)
 */
function utcMsForLocal(
  y: number, m: number, d: number, hh: number, mm: number, timezone: string,
): number {
  const target = Date.UTC(y, m - 1, d, hh, mm);
  let ts = target;
  for (let i = 0; i < 2; i += 1) {
    const p = localPartsOf(ts, timezone);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
    ts += target - asUtc;
  }
  return ts;
}

export function localDateOf(iso: string, timezone: string): string {
  const p = localPartsOf(Date.parse(iso), timezone);
  const mm = String(p.m).padStart(2, '0');
  const dd = String(p.d).padStart(2, '0');
  return `${p.y}-${mm}-${dd}`;
}

export function instantAtLocalTime(localDate: string, hhmm: string, timezone: string): string {
  const y = Number(localDate.slice(0, 4));
  const m = Number(localDate.slice(5, 7));
  const d = Number(localDate.slice(8, 10));
  const t = parseHhMm(hhmm);
  return new Date(utcMsForLocal(y, m, d, Math.floor(t / 60), t % 60, timezone)).toISOString();
}

export function isQuietTime(nowIso: string, window: QuietHoursWindow): boolean {
  if (!window.enabled) return false;
  const start = parseHhMm(window.start);
  const end = parseHhMm(window.end);
  if (start === end) return false; // zero-length window - validation rejects it, but be safe
  const now = minutesOfDay(localPartsOf(Date.parse(nowIso), window.timezone));
  return start > end
    ? now >= start || now < end // wraps local midnight (21:00 -> 08:00)
    : now >= start && now < end; // same-day window (01:00 -> 05:00)
}

/**
 * Identity outside the window; inside it, the END of the window containing
 * `due` (e.g. 08:00 local that morning - or the NEXT morning for an
 * evening-side instant of a wrapping window).
 */
export function clampOutOfQuietHours(dueIso: string, window: QuietHoursWindow): string {
  if (!isQuietTime(dueIso, window)) return dueIso;
  const p = localPartsOf(Date.parse(dueIso), window.timezone);
  const start = parseHhMm(window.start);
  const end = parseHhMm(window.end);
  const now = minutesOfDay(p);
  // Wrapping window, evening side: the window ends TOMORROW local.
  const bumpDay = start > end && now >= start ? 1 : 0;
  return new Date(
    utcMsForLocal(p.y, p.m, p.d + bumpDay, Math.floor(end / 60), end % 60, window.timezone),
  ).toISOString();
}
