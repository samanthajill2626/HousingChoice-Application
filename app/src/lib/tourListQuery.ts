// tourListQuery - the PURE half of the Tours page's All tab read,
// GET /api/tours/list (spec docs/superpowers/specs/2026-10-06-tour-list-design.md
// section 5): parse and normalize the request, plan the phases a page reads,
// fingerprint the filters, and encode / decode / locate the opaque cursor.
// No AWS and no Express here: toursRepo.queryListPhase runs ONE phase batch
// and services/tourListPage.ts runs the paging loop.
// String.prototype.isWellFormed (the cursor key check) is ES2024 - in Node 20+,
// outside the ES2023 lib this workspace compiles against.
/// <reference lib="es2024.string" />
import { createHash } from 'node:crypto';
import {
  TOUR_STATUSES,
  TOUR_TYPES,
  isTourStatus,
  isTourType,
  type TourStatus,
  type TourType,
} from './toursModel.js';

export const TOUR_LIST_DEFAULT_LIMIT = 50;
export const TOUR_LIST_MAX_LIMIT = 100;

export const TOUR_LIST_WHENS = ['any', 'upcoming', 'past', 'range'] as const;
export type TourListWhen = (typeof TOUR_LIST_WHENS)[number];
export type TourListSort = 'latest' | 'earliest';

/** Phase U's status order (spec 5.3): every status except `scheduled`, which
 *  always has a date (spec 3.4). `requested` first - its partition is all
 *  undated, so it wastes no reads. */
export const U_ORDER = ['requested', 'toured', 'no_show', 'canceled', 'closed'] as const satisfies readonly TourStatus[];

/** The statuses that can carry a date (phase D's universe). */
export const DATED_STATUSES = ['scheduled', 'toured', 'no_show', 'canceled', 'closed'] as const satisfies readonly TourStatus[];

/** The normalized request. `statuses` is deduped, in TOUR_STATUSES order, and
 *  EMPTY means every status (all six also normalize to empty). `from` / `to`
 *  are canonical ISO (toISOString) and exist only for `when: 'range'`. */
export interface TourListFilters {
  when: TourListWhen;
  from?: string;
  to?: string;
  statuses: TourStatus[];
  type?: TourType;
  /** The effective sort (the When default applied). */
  sort: TourListSort;
}

export interface TourListRequest {
  filters: TourListFilters;
  limit: number;
  /** The raw cursor string, decoded by decodeTourListCursor. */
  cursor?: string;
}

export type TourListParse = { ok: true; value: TourListRequest } | { ok: false; error: string };

/** One raw query value: undefined when absent, null when it is not a single
 *  string (a repeated parameter or a nested object). */
function single(query: Record<string, unknown>, name: string): string | undefined | null {
  const raw = query[name];
  if (raw === undefined) return undefined;
  return typeof raw === 'string' ? raw : null;
}

/** An ISO 8601 instant -> its canonical toISOString(), or undefined. */
function canonicalInstant(raw: string): string | undefined {
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/** An ISO 8601 date-time WITH an explicit zone (spec 5.1: `from` / `to` are
 *  instants). Date.parse alone also takes zone-less and date-only forms, read
 *  in the server's own zone or as UTC midnight, so the same request would mean
 *  a different instant per host (code review r1 SC-2). Groups: year, month,
 *  day, hour, minute, the optional second and fraction (any length), then the
 *  offset's sign, hours and minutes (none of the three for `Z`). */
const ISO_ZONED_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/** Days in `month` (1-12) of `year`, by the proleptic Gregorian calendar Date
 *  itself uses. */
function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** A request bound -> its canonical instant, or undefined when it is not an
 *  ISO 8601 date-time with a zone naming a real calendar time. The instant is
 *  BUILT from the checked fields, the fraction truncated to milliseconds -
 *  never Date.parse, which rolls an impossible day or hour forward
 *  (2026-02-30 is March 2, T24:00 the next day; code review r2 R2-1). */
function boundInstant(raw: string): string | undefined {
  const m = ISO_ZONED_DATE_TIME.exec(raw);
  if (m === null) return undefined;
  const [, y, mo, d, h, mi, s, fraction, sign, oh, om] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s ?? '0');
  const offsetHours = Number(oh ?? '0');
  const offsetMinutes = Number(om ?? '0');
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return undefined;
  if (hour > 23 || minute > 59 || second > 59 || offsetHours > 23 || offsetMinutes > 59) return undefined;
  const ms = Number((fraction ?? '').slice(0, 3).padEnd(3, '0'));
  // The wall-clock fields read as UTC, then moved by the offset.
  // setUTCFullYear, not Date.UTC: Date.UTC reads a year 0-99 as 1900-1999.
  const wall = new Date(0);
  wall.setUTCFullYear(year, month - 1, day);
  wall.setUTCHours(hour, minute, second, ms);
  const offsetMs = (sign === '-' ? -1 : 1) * (offsetHours * 60 + offsetMinutes) * 60_000;
  return new Date(wall.getTime() - offsetMs).toISOString();
}

const fail = (error: string): TourListParse => ({ ok: false, error });

export function parseTourListQuery(query: Record<string, unknown>): TourListParse {
  const whenRaw = single(query, 'when');
  if (whenRaw === null) return fail('when must be one of: any, upcoming, past, range');
  const when = whenRaw === undefined || whenRaw === '' ? 'any' : whenRaw;
  if (!(TOUR_LIST_WHENS as readonly string[]).includes(when)) {
    return fail('when must be one of: any, upcoming, past, range');
  }
  const w = when as TourListWhen;

  const sortRaw = single(query, 'sort');
  if (sortRaw === null || (sortRaw !== undefined && sortRaw !== '' && sortRaw !== 'latest' && sortRaw !== 'earliest')) {
    return fail('sort must be one of: latest, earliest');
  }
  const sort: TourListSort =
    sortRaw === 'latest' || sortRaw === 'earliest' ? sortRaw : w === 'upcoming' ? 'earliest' : 'latest';

  const statusRaw = single(query, 'status');
  if (statusRaw === null) return fail(`status must be a comma list of: ${TOUR_STATUSES.join(', ')}`);
  const picked = new Set<TourStatus>();
  for (const part of (statusRaw ?? '').split(',')) {
    const s = part.trim();
    if (s === '') continue;
    if (!isTourStatus(s)) return fail(`status must be a comma list of: ${TOUR_STATUSES.join(', ')}`);
    picked.add(s);
  }
  const statuses = picked.size === TOUR_STATUSES.length ? [] : TOUR_STATUSES.filter((s) => picked.has(s));

  const typeRaw = single(query, 'type');
  if (typeRaw === null || (typeRaw !== undefined && typeRaw !== '' && !isTourType(typeRaw))) {
    return fail(`type must be one of: ${TOUR_TYPES.join(', ')}`);
  }
  const type = typeRaw !== undefined && typeRaw !== '' ? (typeRaw as TourType) : undefined;

  const fromRaw = single(query, 'from');
  const toRaw = single(query, 'to');
  if (fromRaw === null || toRaw === null) return fail('from and to must be valid ISO 8601 datetimes');
  const hasFrom = fromRaw !== undefined && fromRaw !== '';
  const hasTo = toRaw !== undefined && toRaw !== '';
  if ((hasFrom || hasTo) && w !== 'range') return fail('from and to are accepted only with when=range');
  const from = hasFrom ? boundInstant(fromRaw) : undefined;
  const to = hasTo ? boundInstant(toRaw) : undefined;
  if ((hasFrom && from === undefined) || (hasTo && to === undefined)) {
    return fail('from and to must be valid ISO 8601 datetimes');
  }
  if (from !== undefined && to !== undefined && from > to) return fail('from must be on or before to');

  const limitRaw = single(query, 'limit');
  let limit = TOUR_LIST_DEFAULT_LIMIT;
  if (limitRaw !== undefined) {
    const n = limitRaw === null ? NaN : Number(limitRaw);
    if (limitRaw === '' || !Number.isInteger(n) || n < 1 || n > TOUR_LIST_MAX_LIMIT) {
      return fail(`limit must be an integer 1..${TOUR_LIST_MAX_LIMIT}`);
    }
    limit = n;
  }

  const cursorRaw = single(query, 'cursor');
  if (cursorRaw === null || cursorRaw === '') return fail('invalid cursor');

  const filters: TourListFilters = {
    when: w,
    ...(from !== undefined && { from }),
    ...(to !== undefined && { to }),
    statuses,
    ...(type !== undefined && { type }),
    sort,
  };
  return { ok: true, value: { filters, limit, ...(cursorRaw !== undefined && { cursor: cursorRaw }) } };
}

/** Phase D's key range on byScheduledAt (range key `scheduledAt`). */
export type TourListRange =
  | { op: 'all' }
  | { op: 'gte'; value: string }
  | { op: 'lt'; value: string }
  | { op: 'lte'; value: string }
  | { op: 'between'; from: string; to: string };

/** One phase a page may read. D: the dated tours on byScheduledAt. U: the
 *  undated tours of ONE status on byStatus (`index` = its U_ORDER position;
 *  `notExists` = filter `attribute_not_exists(scheduledAt)`). */
export type TourListPhase =
  | { kind: 'd'; range: TourListRange; statusFilter?: TourStatus[]; type?: TourType }
  | { kind: 'u'; index: number; status: TourStatus; notExists: boolean; type?: TourType };

function rangeFor(f: TourListFilters, pinnedNow: string): TourListRange {
  switch (f.when) {
    case 'upcoming':
      return { op: 'gte', value: pinnedNow };
    case 'past':
      return { op: 'lt', value: pinnedNow };
    case 'range':
      if (f.from !== undefined && f.to !== undefined) return { op: 'between', from: f.from, to: f.to };
      if (f.from !== undefined) return { op: 'gte', value: f.from };
      if (f.to !== undefined) return { op: 'lte', value: f.to };
      return { op: 'all' };
    default:
      return { op: 'all' };
  }
}

/** The ordered phases one list reads (spec 5.3). Phase D is skipped when no
 *  picked status can carry a date; its status filter is omitted when every
 *  dated status is picked (it could exclude nothing). Phase U exists only for
 *  `when: 'any'`, one entry per picked U_ORDER status. */
export function planTourListPhases(f: TourListFilters, pinnedNow: string): TourListPhase[] {
  const every = f.statuses.length === 0;
  const has = (s: TourStatus): boolean => every || f.statuses.includes(s);
  const typePart = f.type !== undefined ? { type: f.type } : {};
  const phases: TourListPhase[] = [];
  const dated = DATED_STATUSES.filter(has);
  if (dated.length > 0) {
    phases.push({
      kind: 'd',
      range: rangeFor(f, pinnedNow),
      ...(dated.length < DATED_STATUSES.length && { statusFilter: [...dated] }),
      ...typePart,
    });
  }
  if (f.when === 'any') {
    U_ORDER.forEach((status, index) => {
      if (has(status)) phases.push({ kind: 'u', index, status, notExists: status !== 'requested', ...typePart });
    });
  }
  return phases;
}

/** A phase is UNFILTERED when its Query carries no FilterExpression - it then
 *  asks for exactly the rows it still needs plus one peek row (spec 5.4). */
export function isUnfilteredPhase(p: TourListPhase): boolean {
  return p.kind === 'd' ? p.statusFilter === undefined && p.type === undefined : !p.notExists && p.type === undefined;
}

const HEX16 = /^[0-9a-f]{16}$/;
const D_KEY_ATTRS = ['_schedPartition', 'scheduledAt', 'tourId'] as const;
const U_KEY_ATTRS = ['createdAt', 'status', 'tourId'] as const;

/** The opaque cursor (spec 5.5). `k` is absent ONLY on a `u` cursor, meaning
 *  "start of U_ORDER[i]". */
export interface TourListCursor {
  v: 1;
  /** tourListFingerprint of the filters that produced it. */
  f: string;
  /** The pinned instant (canonical ISO): Upcoming / Past split here on every
   *  page of one list. */
  n: string;
  ph: 'd' | 'u';
  i?: number;
  k?: Record<string, string>;
}

export function tourListFingerprint(f: TourListFilters): string {
  const canonical = JSON.stringify([f.when, f.from ?? '', f.to ?? '', f.statuses.join(','), f.type ?? '', f.sort]);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

export function encodeTourListCursor(c: TourListCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

/** A cursor key value's UTF-8 cap. DynamoDB limits a range key to 1,024 bytes
 *  (a partition key to 2,048) and requires valid UTF-8; AWS may refuse a larger
 *  or ill-formed crafted key with an error that is not a ValidationException,
 *  a 500. Refused here, such a key is a 400 whatever AWS answers (code review
 *  r1 AD-4). Every real key value - an id, an ISO instant, a status, the
 *  partition name - is far below it. */
const MAX_KEY_VALUE_BYTES = 1024;

function isKeyValue(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.isWellFormed() &&
    Buffer.byteLength(value, 'utf8') <= MAX_KEY_VALUE_BYTES
  );
}

function isKey(k: unknown, attrs: readonly string[]): k is Record<string, string> {
  if (typeof k !== 'object' || k === null || Array.isArray(k)) return false;
  const entries = Object.entries(k);
  if (entries.length !== attrs.length) return false;
  return entries.every(([name, value]) => attrs.includes(name) && isKeyValue(value));
}

/** SHAPE validation only; locateTourListCursor checks it against the plan. */
export function decodeTourListCursor(raw: string): TourListCursor | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const c = parsed as Record<string, unknown>;
  const allowed = new Set(['v', 'f', 'n', 'ph', 'i', 'k']);
  if (Object.keys(c).some((key) => !allowed.has(key))) return undefined;
  if (c['v'] !== 1) return undefined;
  const f = c['f'];
  const n = c['n'];
  if (typeof f !== 'string' || !HEX16.test(f)) return undefined;
  if (typeof n !== 'string' || canonicalInstant(n) !== n) return undefined;
  if (c['ph'] === 'd') {
    const k = c['k'];
    if (c['i'] !== undefined || !isKey(k, D_KEY_ATTRS)) return undefined;
    return { v: 1, f, n, ph: 'd', k };
  }
  if (c['ph'] === 'u') {
    const i = c['i'];
    const k = c['k'];
    if (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i >= U_ORDER.length) return undefined;
    if (k !== undefined && !isKey(k, U_KEY_ATTRS)) return undefined;
    return { v: 1, f, n, ph: 'u', i, ...(k !== undefined && { k }) };
  }
  return undefined;
}

/** Where a decoded cursor resumes in THIS plan, or undefined when it does not
 *  fit it (a skipped phase, a status outside the set, a wrong-partition key). */
export function locateTourListCursor(
  c: TourListCursor,
  phases: TourListPhase[],
): { phaseIndex: number; startKey?: Record<string, string> } | undefined {
  const phaseIndex = phases.findIndex((p) => p.kind === c.ph && (p.kind === 'd' || p.index === c.i));
  const phase = phases[phaseIndex];
  if (phaseIndex < 0 || phase === undefined) return undefined;
  if (phase.kind === 'd') {
    if (c.k === undefined || c.k['_schedPartition'] !== 'tours') return undefined;
  } else if (c.k !== undefined && c.k['status'] !== phase.status) {
    return undefined;
  }
  return { phaseIndex, ...(c.k !== undefined && { startKey: c.k }) };
}

/** The ExclusiveStartKey that resumes right AFTER `item` in `phase`'s index. */
export function tourListKeyOf(item: Record<string, unknown>, phase: TourListPhase): Record<string, string> {
  const attrs = phase.kind === 'd' ? D_KEY_ATTRS : U_KEY_ATTRS;
  const key: Record<string, string> = {};
  for (const name of attrs) key[name] = String(item[name]);
  return key;
}
