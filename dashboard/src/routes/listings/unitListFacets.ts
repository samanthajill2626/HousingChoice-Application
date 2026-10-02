// unitListFacets - the PURE engine behind the Properties list's filters and its
// by-housing-authority summary (docs/superpowers/specs/
// 2026-10-01-properties-available-view-design.md). No React, no hooks:
// ListingsList owns the state and the URL and renders what this returns. Code
// says `unit` (documentation/GLOSSARY.md); staff-facing copy says "property".
//
// The facet RULES that already exist for the Tenants list are REUSED from
// tenantFacets rather than restated - the normalized authority key, the
// most-frequent display spelling, the voucher buckets and their labels, and the
// Not-recorded sentinel and label - so the two lists cannot drift apart on
// them. The chip UI is deliberately simpler here (no per-chip counts: the
// summary carries the counts).
import { LISTING_STATUSES, type UnitItem, type UnitStatus } from '../../api/index.js';
import {
  displaySpelling,
  NONE_KEY,
  normalizeAuthorityKey,
  VOUCHER_BUCKETS,
  voucherBucketOfSize,
  type VoucherBucketKey,
} from '../contacts/tenantFacets.js';
import { authoritiesOf, shortAddress, voucherSizesOf } from '../listing/listingFormat.js';

/** Which property list is showing: the Active tab or the Deleted tab. */
export type UnitListView = 'active' | 'deleted';

/** The status dropdown's value: one listing status, or every status. */
export type StatusFilter = UnitStatus | 'all';

/** "Coming soon" is the existing Setup status, not a status of its own (tracker
 *  #1, decided 2026-09-30). Setup also holds brand-new properties still being
 *  set up; only the summary calls the column "Coming soon". */
export const COMING_SOON_STATUS: UnitStatus = 'setup';

/** The summary's label for properties that list no housing authority. */
export const NO_AUTHORITY_LABEL = 'No authority recorded';

/** The Active tab opens on Available (Sam's default); the Deleted tab keeps
 *  every status, since a deleted property can hold any of them. */
export function defaultStatus(view: UnitListView): StatusFilter {
  return view === 'active' ? 'available' : 'all';
}

/** The list's filter state - parsed from, and written back to, the URL. */
export interface UnitListSelection {
  status: StatusFilter;
  /** NORMALIZED authority keys, or NONE_KEY for "no authority recorded". */
  ha: ReadonlySet<string>;
  /** Voucher bucket keys ('0'..'3', '4plus') or NONE_KEY. */
  voucher: ReadonlySet<string>;
  /** The raw search text, exactly as typed. */
  q: string;
}

const STATUS_VALUES: ReadonlySet<string> = new Set<string>([...LISTING_STATUSES, 'all']);

const VOUCHER_KEYS: ReadonlySet<string> = new Set<string>([
  ...VOUCHER_BUCKETS.map((b) => b.key),
  NONE_KEY,
]);

/** The four params this module owns; any other param is left untouched. */
const OWNED_PARAMS = ['status', 'voucher', 'ha', 'q'] as const;

/**
 * Read the selection out of the URL. Absent or unknown `status` reads as the
 * view's default. Facets are repeated params (never comma-joined: a stored
 * authority can itself contain a comma); unknown voucher values drop one by
 * one; empty values are ignored. An `ha` key no loaded unit carries is pruned
 * later (pruneSelection), never here - parsing does not know the data.
 */
export function parseUnitListSelection(params: URLSearchParams, view: UnitListView): UnitListSelection {
  const rawStatus = params.get('status');
  const status =
    rawStatus !== null && STATUS_VALUES.has(rawStatus) ? (rawStatus as StatusFilter) : defaultStatus(view);
  const voucher = new Set<string>();
  for (const raw of params.getAll('voucher')) if (VOUCHER_KEYS.has(raw)) voucher.add(raw);
  const ha = new Set<string>();
  for (const raw of params.getAll('ha')) if (raw.length > 0) ha.add(raw);
  return { status, ha, voucher, q: params.get('q') ?? '' };
}

/**
 * Write the selection onto `params` IN PLACE. Only the four owned params are
 * deleted and re-added; the view's default status, empty facets and an empty
 * search are omitted, so the default view has a bare URL.
 */
export function applyUnitListSelection(
  params: URLSearchParams,
  sel: UnitListSelection,
  view: UnitListView,
): void {
  for (const name of OWNED_PARAMS) params.delete(name);
  if (sel.status !== defaultStatus(view)) params.set('status', sel.status);
  for (const key of sel.voucher) params.append('voucher', key);
  for (const key of sel.ha) params.append('ha', key);
  if (sel.q.length > 0) params.set('q', sel.q);
}

/**
 * A unit's DISTINCT non-empty authority keys, in first-seen order. Two stored
 * spellings that normalize alike ('DCA' and 'dca') are one authority, so the
 * unit is counted under it once.
 */
export function unitAuthorityKeys(unit: UnitItem): string[] {
  const keys: string[] = [];
  for (const raw of authoritiesOf(unit)) {
    const key = normalizeAuthorityKey(raw);
    if (key.length > 0 && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** One authority chip / summary row: its normalized key and stored spelling. */
export interface AuthorityOption {
  key: string;
  label: string;
}

/** The authority options for one view's loaded units. */
export interface AuthorityOptions {
  /** One per normalized key, sorted by key (case-insensitive, locale-free). */
  options: AuthorityOption[];
  /** Some loaded unit lists no authority at all. */
  hasUnrecorded: boolean;
}

/**
 * Derive the authority options from EVERY loaded unit of the view (never the
 * filtered rows, so chips cannot vanish or re-spell mid-interaction). The label
 * is the most frequent STORED spelling, untransformed - the same rule as the
 * Tenants list (displaySpelling), with no prettifier.
 */
export function authorityOptions(units: UnitItem[]): AuthorityOptions {
  const spellingsByKey = new Map<string, Map<string, number>>();
  let hasUnrecorded = false;
  for (const unit of units) {
    let recorded = false;
    for (const raw of authoritiesOf(unit)) {
      const key = normalizeAuthorityKey(raw);
      if (key.length === 0) continue; // whitespace-only: nothing to show
      recorded = true;
      const spellings = spellingsByKey.get(key) ?? new Map<string, number>();
      spellings.set(raw, (spellings.get(raw) ?? 0) + 1);
      spellingsByKey.set(key, spellings);
    }
    if (!recorded) hasUnrecorded = true;
  }
  const options = [...spellingsByKey.entries()]
    .map(([key, spellings]) => ({ key, label: displaySpelling(spellings) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { options, hasUnrecorded };
}

/**
 * THE INVARIANT: a selection the user can neither see nor clear must not
 * filter. An authority key is kept only while its chip shows - a key from a
 * stale link, or one carried onto a view whose units do not list it, is dropped
 * (the Properties list once locked to zero rows that way:
 * docs/issues/properties-authority-filter-invisible-lock.md). Not recorded is
 * kept only while its chip shows. Status, voucher and search are always on
 * screen, so they pass through. The URL is not rewritten here; the next
 * interaction re-serializes the pruned selection.
 */
export function pruneSelection(sel: UnitListSelection, authority: AuthorityOptions): UnitListSelection {
  const valid = new Set(authority.options.map((o) => o.key));
  const ha = new Set<string>();
  for (const key of sel.ha) {
    if (key === NONE_KEY ? authority.hasUnrecorded : valid.has(key)) ha.add(key);
  }
  return { ...sel, ha };
}

/** The voucher buckets a unit accepts (one number or a list; never `beds`). */
export function unitVoucherBuckets(unit: UnitItem): Set<VoucherBucketKey> {
  const buckets = new Set<VoucherBucketKey>();
  for (const size of voucherSizesOf(unit)) {
    const bucket = voucherBucketOfSize(size);
    if (bucket !== null) buckets.add(bucket);
  }
  return buckets;
}

/** OR within the voucher facet: a unit matches when ANY size it accepts is
 *  selected; Not recorded matches a unit with no usable size. Empty = all. */
export function matchesVoucher(unit: UnitItem, keys: ReadonlySet<string>): boolean {
  if (keys.size === 0) return true;
  const buckets = unitVoucherBuckets(unit);
  if (buckets.size === 0) return keys.has(NONE_KEY);
  for (const bucket of buckets) if (keys.has(bucket)) return true;
  return false;
}

/** OR within the authority facet: a unit matches when ANY authority it accepts
 *  is selected; Not recorded matches a unit that lists none. Empty = all. */
export function matchesAuthority(unit: UnitItem, keys: ReadonlySet<string>): boolean {
  if (keys.size === 0) return true;
  const unitKeys = unitAuthorityKeys(unit);
  if (unitKeys.length === 0) return keys.has(NONE_KEY);
  return unitKeys.some((key) => keys.has(key));
}

/** The address search: case-insensitive substring of the short address. */
function matchesQuery(unit: UnitItem, q: string): boolean {
  const needle = q.trim().toLowerCase();
  return needle.length === 0 || shortAddress(unit.address, unit.unitId).toLowerCase().includes(needle);
}

/** Apply the selection: AND across status, voucher, authority and search. */
export function applyUnitListFilters(units: UnitItem[], sel: UnitListSelection): UnitItem[] {
  return units.filter(
    (unit) =>
      (sel.status === 'all' || unit.status === sel.status) &&
      matchesVoucher(unit, sel.voucher) &&
      matchesAuthority(unit, sel.ha) &&
      matchesQuery(unit, sel.q),
  );
}

/** The two counts the summary shows. */
export interface SummaryCounts {
  available: number;
  comingSoon: number;
}

/** One summary row: an authority (or NONE_KEY), its label, and its counts. */
export interface SummaryRow extends SummaryCounts {
  key: string;
  label: string;
}

/** The whole summary: the All row plus the per-authority rows. */
export interface AuthoritySummaryModel {
  all: SummaryCounts;
  rows: SummaryRow[];
  /** Available or coming-soon units the voucher selection left out BECAUSE
   *  they record no voucher size at all (0 when no voucher filter is on, or
   *  when Not recorded is selected). The summary says so out loud: without it
   *  a size filter would silently shrink the counts on data that was simply
   *  never filled in (the import never writes the field). */
  unrecordedExcluded: number;
}

/** Which summary column a status lands in, if any. */
function columnOf(status: UnitStatus): keyof SummaryCounts | null {
  if (status === 'available') return 'available';
  if (status === COMING_SOON_STATUS) return 'comingSoon';
  return null;
}

/**
 * The by-housing-authority summary for the Active tab. Counts follow the
 * VOUCHER selection only - never the status or authority filters (the summary
 * IS the status-by-authority breakdown) and never the search. `all` counts each
 * property once; a property accepting several authorities counts under each of
 * their rows. Rows follow the option order (sorted by key), with the
 * no-authority row last; a row whose two counts are both zero is left out.
 */
export function buildAuthoritySummary(
  units: UnitItem[],
  voucherKeys: ReadonlySet<string>,
  authority: AuthorityOptions,
): AuthoritySummaryModel {
  const all: SummaryCounts = { available: 0, comingSoon: 0 };
  const byKey = new Map<string, SummaryCounts>();
  let unrecordedExcluded = 0;
  for (const unit of units) {
    const column = columnOf(unit.status);
    if (column === null) continue;
    if (!matchesVoucher(unit, voucherKeys)) {
      if (unitVoucherBuckets(unit).size === 0) unrecordedExcluded += 1;
      continue;
    }
    all[column] += 1;
    const keys = unitAuthorityKeys(unit);
    for (const key of keys.length > 0 ? keys : [NONE_KEY]) {
      const counts = byKey.get(key) ?? { available: 0, comingSoon: 0 };
      counts[column] += 1;
      byKey.set(key, counts);
    }
  }
  const rows: SummaryRow[] = [];
  const push = (key: string, label: string): void => {
    const counts = byKey.get(key);
    if (counts !== undefined && (counts.available > 0 || counts.comingSoon > 0)) {
      rows.push({ key, label, ...counts });
    }
  };
  for (const option of authority.options) push(option.key, option.label);
  push(NONE_KEY, NO_AUTHORITY_LABEL);
  return { all, rows, unrecordedExcluded };
}

/** True when nothing but the view's default status constrains the list - the
 *  state a user did not choose, so an empty result must not blame "the
 *  selected filters". */
export function isDefaultSelection(sel: UnitListSelection, view: UnitListView): boolean {
  return (
    sel.status === defaultStatus(view) && sel.ha.size === 0 && sel.voucher.size === 0 && sel.q.trim() === ''
  );
}

/**
 * The selection a summary count applies: that column's status and exactly that
 * authority (null = the All row, which clears the authority filter), keeping
 * the voucher filter the counts were computed under and clearing the search -
 * so the list then shows exactly the properties the count counted.
 */
export function countSelection(
  current: UnitListSelection,
  column: keyof SummaryCounts,
  key: string | null,
): UnitListSelection {
  return {
    status: column === 'available' ? 'available' : COMING_SOON_STATUS,
    ha: key === null ? new Set<string>() : new Set([key]),
    voucher: current.voucher,
    q: '',
  };
}
