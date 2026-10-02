// ListingsList - the Properties list (Active and Deleted tabs): heading - tabs -
// filters - search - rows linking to the property page, in the design language
// (tokens + CSS Modules). The Active tab opens on Available and leads with the
// by-housing-authority summary Sam asked for (tracker #1:
// docs/superpowers/specs/2026-10-01-properties-available-view-design.md).
//
// ALL filter state lives in the URL (status / voucher / ha / q, parsed and
// written by propertyFacets). The component stays MOUNTED across /listings and
// /listings/deleted (sibling routes in the same element position, App.tsx), so
// component state would carry from one tab to the other - which is how an
// authority picked on Active once locked the Deleted tab at zero rows
// (docs/issues/properties-authority-filter-invisible-lock.md). The one piece of
// local state is the search box's text; see the note on it below.
import { useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useNavigationType, useSearchParams } from 'react-router-dom';
import { LISTING_STATUSES, LISTING_STATUS_LABELS, type UnitItem } from '../../api/index.js';
import { Button, Spinner } from '../../ui/index.js';
import { NONE_KEY, VOUCHER_BUCKETS } from '../contacts/tenantFacets.js';
import { formatBedsBaths, formatRent, shortAddress, statusLabel } from '../listing/listingFormat.js';
import { UnitCreateForm } from '../listing/UnitCreateForm.js';
import { PropertySummary } from './PropertySummary.js';
import {
  applyPropertyFilters,
  applyPropertySelection,
  authorityOptions,
  buildAuthoritySummary,
  countSelection,
  parsePropertySelection,
  pruneSelection,
  type PropertySelection,
  type PropertyView,
  type StatusFilter,
  type SummaryCounts,
} from './propertyFacets.js';
import { useListings } from './useListings.js';
import styles from './ListingsList.module.css';

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All statuses' },
  ...LISTING_STATUSES.map((s) => ({ value: s, label: LISTING_STATUS_LABELS[s] })),
];

/** The "nothing recorded" chip label - the Tenants list's word for it. */
const NOT_RECORDED = 'Not recorded';

/** The voucher chips: the Tenants list's fixed five, then Not recorded. */
const VOUCHER_CHIPS: ReadonlyArray<{ key: string; label: string }> = [
  ...VOUCHER_BUCKETS,
  { key: NONE_KEY, label: NOT_RECORDED },
];

/** Toggle one key in a facet set, returning a new set. */
function toggled(keys: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(keys);
  if (!next.delete(key)) next.add(key);
  return next;
}

function Row({ unit }: { unit: UnitItem }): React.JSX.Element {
  const address = shortAddress(unit.address, unit.unitId);
  const beds = formatBedsBaths(unit.beds, unit.baths);
  const rent = formatRent(unit.rent_min, unit.rent_max);
  return (
    <li className={styles.rowItem}>
      <Link to={`/listings/${unit.unitId}`} className={styles.row}>
        <span className={styles.address}>{address}</span>
        {/* Meta chips grouped so on a tight content pane they wrap to their own
         *  line below the address instead of crushing it (container query in CSS). */}
        <span className={styles.meta}>
          <span className={styles.badge}>{statusLabel(unit.status)}</span>
          {beds ? <span className={styles.beds}>{beds} bd/ba</span> : null}
          {rent ? <span className={styles.rent}>{rent}/mo</span> : null}
        </span>
      </Link>
    </li>
  );
}

/** One multi-select chip group: the uppercase label, the chips, and a Clear
 *  once anything is selected. Divs + aria-pressed buttons, deliberately NO
 *  ul/li, so the rows list stays the only source of listitems. */
function ChipGroup({
  labelId,
  label,
  options,
  selected,
  onChange,
}: {
  labelId: string;
  label: string;
  options: ReadonlyArray<{ key: string; label: string }>;
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
}): React.JSX.Element {
  return (
    <div className={styles.control}>
      <span className={styles.controlLabel} id={labelId}>
        {label}
      </span>
      <div className={styles.chips} role="group" aria-labelledby={labelId}>
        {options.map((o) => {
          const on = selected.has(o.key);
          return (
            <button
              key={o.key}
              type="button"
              className={`${styles.chip} ${on ? styles.chipOn : ''}`}
              aria-pressed={on}
              onClick={() => onChange(toggled(selected, o.key))}
            >
              {o.label}
            </button>
          );
        })}
        {selected.size > 0 ? (
          <button
            type="button"
            className={styles.clear}
            aria-label={`Clear ${label.toLowerCase()} filter`}
            onClick={() => onChange(new Set<string>())}
          >
            Clear
          </button>
        ) : null}
      </div>
    </div>
  );
}

export interface ListingsListProps {
  /** The "Deleted" view (soft-deleted listings) vs the normal active list. */
  deleted?: boolean;
}

/** Active / Deleted view tabs. Links to the two routes so the URL is the source
 *  of truth (mirrors the Contacts list's filter tabs). */
const VIEW_TABS: { deleted: boolean; label: string; to: string }[] = [
  { deleted: false, label: 'Active', to: '/listings' },
  { deleted: true, label: 'Deleted', to: '/listings/deleted' },
];

export function ListingsList({ deleted = false }: ListingsListProps): React.JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const navigationType = useNavigationType();
  const [searchParams, setSearchParams] = useSearchParams();
  const { status, units } = useListings(deleted);
  const view: PropertyView = deleted ? 'deleted' : 'active';
  // The "New property" dialog (Active view only) with an empty landlord picker.
  const [creating, setCreating] = useState(false);

  // The search box keeps its OWN text, and the URL's `q` only persists it. The
  // router applies every URL change inside a transition (react-router 7's
  // BrowserRouter), so an input bound straight to the URL would lag a keystroke
  // and could drop characters. Typing REPLACES the URL and is never read back;
  // the URL's `q` is adopted only on a navigation that did not come from the box
  // - Back/Forward, a tab switch, a summary count (PUSH or POP) - and on mount
  // (a reload, or Back from a property page, which remounts this list).
  const urlQuery = parsePropertySelection(searchParams, view).q;
  const [query, setQuery] = useState(urlQuery);
  const [syncedKey, setSyncedKey] = useState(location.key);
  if (location.key !== syncedKey) {
    setSyncedKey(location.key);
    if (navigationType !== 'REPLACE' && query !== urlQuery) setQuery(urlQuery);
  }

  // Authority chips and summary rows come from EVERY loaded unit of this view
  // (never the filtered rows), labelled with the STORED spelling.
  const authority = useMemo(() => authorityOptions(units), [units]);
  // The effective selection: the URL's, minus anything no chip shows (the
  // invisible-lock invariant - propertyFacets.pruneSelection), plus the box's text.
  const selection = useMemo<PropertySelection>(
    () => ({ ...pruneSelection(parsePropertySelection(searchParams, view), authority), q: query }),
    [searchParams, view, authority, query],
  );
  const visible = useMemo(() => applyPropertyFilters(units, selection), [units, selection]);
  // The summary is the Active tab's alone; its counts follow the voucher filter.
  const summary = useMemo(
    () => (deleted ? null : buildAuthoritySummary(units, selection.voucher, authority)),
    [deleted, units, selection.voucher, authority],
  );

  /** Serialize a new selection, REPLACING the history entry: Back leaves the
   *  page rather than walking chip toggles (the Tenants-list rule). */
  function update(next: PropertySelection): void {
    const params = new URLSearchParams(searchParams);
    applyPropertySelection(params, next, view);
    setSearchParams(params, { replace: true });
  }

  /** Where a summary count links. A count is a drill-down NAVIGATION (a push),
   *  so Back returns to the view it was clicked from. */
  function countLink(column: keyof SummaryCounts, key: string | null): { pathname: string; search: string } {
    const params = new URLSearchParams(searchParams);
    applyPropertySelection(params, countSelection(selection, column, key), view);
    const search = params.toString();
    return { pathname: location.pathname, search: search.length > 0 ? `?${search}` : '' };
  }

  const showControls = status === 'ready' && units.length > 0;
  const authorityChips = authority.hasUnrecorded
    ? [...authority.options, { key: NONE_KEY, label: NOT_RECORDED }]
    : authority.options;

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>{deleted ? 'Deleted properties' : 'Properties'}</h1>
        {!deleted ? (
          <Button variant="primary" size="sm" type="button" onClick={() => setCreating(true)}>
            + New property
          </Button>
        ) : null}
      </div>
      <p className={styles.sub}>
        {deleted
          ? 'Soft-deleted properties. Open one to restore it.'
          : 'Available properties by default - change the status filter to see the rest.'}
      </p>

      <nav className={styles.tabs} aria-label="Properties view">
        {VIEW_TABS.map((t) => {
          const current = t.deleted === deleted;
          return (
            <Link
              key={t.label}
              // Only the CURRENT tab carries the query (re-clicking it keeps the
              // filters); the other tab is the bare path, so switching views
              // always starts clean.
              to={current ? { pathname: t.to, search: searchParams.toString() } : t.to}
              className={`${styles.tab} ${current ? styles.tabActive : ''}`}
              {...(current && { 'aria-current': 'page' })}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>

      {showControls && summary !== null ? <PropertySummary summary={summary} linkFor={countLink} /> : null}

      {showControls ? (
        <div className={styles.controls}>
          <div className={styles.control}>
            <label className={styles.controlLabel} htmlFor="listings-status">
              Status
            </label>
            <select
              id="listings-status"
              className={styles.select}
              value={selection.status}
              onChange={(e) => update({ ...selection, status: e.target.value as StatusFilter })}
            >
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <ChipGroup
            labelId="voucher-filter-label"
            label="Voucher size"
            options={VOUCHER_CHIPS}
            selected={selection.voucher}
            onChange={(voucher) => update({ ...selection, voucher })}
          />

          <ChipGroup
            labelId="ha-filter-label"
            label="Housing authority"
            options={authorityChips}
            selected={selection.ha}
            onChange={(ha) => update({ ...selection, ha })}
          />
        </div>
      ) : null}

      <div className={styles.search}>
        <label className={styles.searchLabel} htmlFor="listings-search">
          Search properties
        </label>
        <input
          id="listings-search"
          type="search"
          className={styles.searchInput}
          placeholder="Search by address"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            update({ ...selection, q: e.target.value });
          }}
          disabled={status !== 'ready'}
        />
      </div>

      {status === 'loading' ? <Spinner center /> : null}

      {status === 'error' ? (
        <p className={styles.error} role="alert">
          We couldn&apos;t load properties. Please try again.
        </p>
      ) : null}

      {status === 'ready' && units.length === 0 ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>{deleted ? 'No deleted properties' : 'No properties yet'}</p>
          <p className={styles.emptyBody}>
            {deleted ? 'Deleted properties will appear here.' : 'Nothing here to show right now.'}
          </p>
        </div>
      ) : null}

      {status === 'ready' && units.length > 0 ? (
        visible.length > 0 ? (
          <ul className={styles.rows} aria-label="Properties">
            {visible.map((unit) => (
              <Row key={unit.unitId} unit={unit} />
            ))}
          </ul>
        ) : (
          <p className={styles.noMatches}>
            {/* Entity quotes, never literal curly ones - added lines stay ASCII. */}
            {query.trim() ? (
              <>No matches for &ldquo;{query.trim()}&rdquo;.</>
            ) : (
              'No properties match the selected filters.'
            )}
          </p>
        )
      ) : null}

      {creating ? (
        <UnitCreateForm
          onClose={() => setCreating(false)}
          onCreated={(u) => {
            setCreating(false);
            void navigate('/listings/' + u.unitId);
          }}
        />
      ) : null}
    </div>
  );
}
