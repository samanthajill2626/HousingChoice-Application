// tourListSelection - the All tab's filter model (spec docs/superpowers/specs/
// 2026-10-06-tour-list-design.md sections 4.3 and 4.7). PURE: the local
// selection, its URL form, the pruning invariant (a selection the user can
// neither see nor clear never filters), the local-day conversion for the date
// range, and the GET /api/tours/list parameters. The search text `q` is
// client-only: it is persisted in the URL but never sent to the server.
// Also the return-restore record (spec 4.9) the row links and the tour page's
// back arrow carry in history state.
import type { TourListParams, TourStatus, TourType } from '../../api/index.js';

export type TourListWhen = 'any' | 'upcoming' | 'past' | 'range';
export type TourListSort = 'latest' | 'earliest';

export interface TourListSelection {
  when: TourListWhen;
  /** Local calendar day 'YYYY-MM-DD' or '' - meaningful only under 'range'. */
  from: string;
  to: string;
  /** Empty = every status. */
  statuses: ReadonlySet<TourStatus>;
  type: TourType | '';
  /** '' = not picked: the When default applies (effectiveTourListSort). */
  sort: TourListSort | '';
  q: string;
}

export const DEFAULT_TOUR_LIST_SELECTION: TourListSelection = Object.freeze({
  when: 'any',
  from: '',
  to: '',
  statuses: new Set<TourStatus>(),
  type: '',
  sort: '',
  q: '',
}) as TourListSelection;

export const TOUR_LIST_WHEN_OPTIONS: ReadonlyArray<{ value: TourListWhen; label: string }> = [
  { value: 'any', label: 'Any time' },
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'past', label: 'Past' },
  { value: 'range', label: 'Date range' },
];

/** The Status chips, in order. The `requested` chip reads "Needs booking"
 *  (Cameron, 2026-10-06); the URL and the API carry the VALUE. */
export const TOUR_LIST_STATUS_CHIPS: ReadonlyArray<{ value: TourStatus; label: string }> = [
  { value: 'requested', label: 'Needs booking' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'toured', label: 'Toured' },
  { value: 'no_show', label: 'No show' },
  { value: 'canceled', label: 'Canceled' },
  { value: 'closed', label: 'Closed' },
];

export const TOUR_LIST_TYPE_OPTIONS: ReadonlyArray<{ value: TourType | ''; label: string }> = [
  { value: '', label: 'All types' },
  { value: 'self_guided', label: 'Self-guided' },
  { value: 'landlord_led', label: 'Landlord-led' },
  { value: 'pm_team', label: 'PM team' },
];

export const TOUR_LIST_SORT_OPTIONS: ReadonlyArray<{ value: TourListSort; label: string }> = [
  { value: 'latest', label: 'Latest first' },
  { value: 'earliest', label: 'Earliest first' },
];

const WHENS = new Set<string>(TOUR_LIST_WHEN_OPTIONS.map((o) => o.value));
const STATUS_ORDER = TOUR_LIST_STATUS_CHIPS.map((c) => c.value);
const STATUSES = new Set<string>(STATUS_ORDER);
const TYPES = new Set<string>(['self_guided', 'landlord_led', 'pm_team']);
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 'YYYY-MM-DD' -> its parts when it names a real calendar day. */
function ymdParts(s: string): { y: number; m: number; d: number } | undefined {
  const match = YMD.exec(s);
  if (match === null) return undefined;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const probe = new Date(y, m - 1, d);
  if (probe.getFullYear() !== y || probe.getMonth() !== m - 1 || probe.getDate() !== d) return undefined;
  return { y, m, d };
}

/** The start of a LOCAL calendar day as an ISO instant. Never
 *  `new Date('YYYY-MM-DD')` - that is UTC midnight (the previous evening in
 *  Atlanta). */
export function localDayStartIso(ymd: string): string | undefined {
  const p = ymdParts(ymd);
  return p === undefined ? undefined : new Date(p.y, p.m - 1, p.d, 0, 0, 0, 0).toISOString();
}

/** The END of a local calendar day (the next local midnight minus 1 ms) - the
 *  calendar arithmetic pastToursDateRange uses across DST (useTours.ts). West
 *  of UTC the end of 9999-12-31 is already year 10000 in UTC, whose ISO form
 *  ('+010000-...') the server refuses, so it is clamped to the last instant of
 *  year 9999 (code review r3 R3-1). */
export function localDayEndIso(ymd: string): string | undefined {
  const p = ymdParts(ymd);
  if (p === undefined) return undefined;
  const end = new Date(new Date(p.y, p.m - 1, p.d + 1, 0, 0, 0, 0).getTime() - 1).toISOString();
  return end.startsWith('+') ? '9999-12-31T23:59:59.999Z' : end;
}

export function parseTourListSelection(params: URLSearchParams): TourListSelection {
  const when = params.get('when') ?? '';
  const statuses = new Set<TourStatus>();
  for (const part of (params.get('status') ?? '').split(',')) {
    const s = part.trim();
    if (STATUSES.has(s)) statuses.add(s as TourStatus);
  }
  const type = params.get('type') ?? '';
  const sort = params.get('sort') ?? '';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  return {
    when: WHENS.has(when) ? (when as TourListWhen) : 'any',
    from: ymdParts(from) !== undefined ? from : '',
    to: ymdParts(to) !== undefined ? to : '',
    statuses,
    type: TYPES.has(type) ? (type as TourType) : '',
    sort: sort === 'latest' || sort === 'earliest' ? sort : '',
    q: params.get('q') ?? '',
  };
}

/** The selection minus everything the user can neither see nor clear
 *  (spec 4.3's invariant). Never mutates its input. */
export function pruneTourListSelection(sel: TourListSelection): TourListSelection {
  const statuses = new Set(sel.statuses);
  if (sel.when !== 'any') statuses.delete('requested');
  return {
    ...sel,
    statuses,
    from: sel.when === 'range' ? sel.from : '',
    to: sel.when === 'range' ? sel.to : '',
  };
}

export function effectiveTourListSort(sel: TourListSelection): TourListSort {
  if (sel.sort !== '') return sel.sort;
  return sel.when === 'upcoming' ? 'earliest' : 'latest';
}

/** Write `sel` (pruned) into `params`, deleting every default. Other params
 *  in `params` are left alone. */
export function applyTourListSelection(params: URLSearchParams, sel: TourListSelection): void {
  const p = pruneTourListSelection(sel);
  const set = (name: string, value: string): void => {
    if (value === '') params.delete(name);
    else params.set(name, value);
  };
  set('when', p.when === 'any' ? '' : p.when);
  set('status', STATUS_ORDER.filter((s) => p.statuses.has(s)).join(','));
  set('type', p.type);
  set('sort', p.sort);
  set('from', p.from);
  set('to', p.to);
  set('q', p.q);
}

export function tourListRangeError(sel: TourListSelection): string | null {
  if (sel.when !== 'range' || sel.from === '' || sel.to === '') return null;
  return sel.from > sel.to ? 'From must be on or before To.' : null;
}

/** ONE client shape for the API parameters - the endpoint's own type. */
export type TourListApiParams = TourListParams;

/** The GET /api/tours/list parameters for `sel`, or null while the date range
 *  is invalid (the view sends nothing). `q` is never sent. */
export function tourListApiParams(sel: TourListSelection): TourListApiParams | null {
  if (tourListRangeError(sel) !== null) return null;
  const p = pruneTourListSelection(sel);
  const from = p.from !== '' ? localDayStartIso(p.from) : undefined;
  const to = p.to !== '' ? localDayEndIso(p.to) : undefined;
  const status = STATUS_ORDER.filter((s) => p.statuses.has(s)).join(',');
  return {
    when: p.when,
    ...(from !== undefined && { from }),
    ...(to !== undefined && { to }),
    ...(status !== '' && { status }),
    ...(p.type !== '' && { type: p.type }),
    sort: effectiveTourListSort(p),
  };
}

/** A stable key of the server-visible selection: a change means a NEW list. */
export function tourListApiKey(sel: TourListSelection): string {
  return JSON.stringify(tourListApiParams(sel));
}

export function isDefaultTourListSelection(sel: TourListSelection): boolean {
  return (
    sel.when === 'any' &&
    sel.from === '' &&
    sel.to === '' &&
    sel.statuses.size === 0 &&
    sel.type === '' &&
    sel.sort === '' &&
    sel.q === ''
  );
}

/** Where the user was in the All list when they opened a row (spec 4.9). */
export interface TourListRestore {
  depth: number;
  openedTourId: string;
  openedIndex: number;
}

export function parseTourListRestore(state: unknown): TourListRestore | null {
  if (typeof state !== 'object' || state === null) return null;
  const r = (state as Record<string, unknown>)['restore'];
  if (typeof r !== 'object' || r === null) return null;
  const { depth, openedTourId, openedIndex } = r as Record<string, unknown>;
  if (typeof depth !== 'number' || !Number.isInteger(depth) || depth < 0) return null;
  if (typeof openedIndex !== 'number' || !Number.isInteger(openedIndex) || openedIndex < 0) return null;
  if (typeof openedTourId !== 'string' || openedTourId === '') return null;
  return { depth, openedTourId, openedIndex };
}
