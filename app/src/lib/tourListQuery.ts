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
