// tourListQuery - the PURE half of the Tours page's All tab read,
// GET /api/tours/list (spec docs/superpowers/specs/2026-10-06-tour-list-design.md
// section 5): parse and normalize the request, plan the phases a page reads,
// fingerprint the filters, and encode / decode / locate the opaque cursor.
// No AWS and no Express here: toursRepo.queryListPhase runs ONE phase batch
// and services/tourListPage.ts runs the paging loop.
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
  const from = hasFrom ? canonicalInstant(fromRaw) : undefined;
  const to = hasTo ? canonicalInstant(toRaw) : undefined;
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
