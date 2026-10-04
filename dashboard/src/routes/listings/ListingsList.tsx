// ListingsList - the Properties list (Active and Deleted tabs): heading - tabs -
// filters - search - rows linking to the property page, in the design language
// (tokens + CSS Modules). The Active tab opens on Available and leads with the
// by-housing-authority summary Sam asked for (tracker #1:
// docs/superpowers/specs/2026-10-01-properties-available-view-design.md).
//
// FILTER STATE (status / voucher / ha / q) is LOCAL component state, and the URL
// is its persistence - parsed and written by unitListFacets. Why not read the
// URL directly: react-router 7's BrowserRouter applies every URL change inside a
// transition, so URL-driven controls lag the event that changed them - a second
// tap before the first commits used to drop the first, and a box bound to the
// URL can drop keystrokes. Local state updates urgently instead.
//
//   - Chips and the dropdown write the URL at once (REPLACE).
//   - The search box writes it on BLUR, when a row is opened, and with any other
//     filter write - never per keystroke: WebKit throttles replaceState (100
//     calls per 10 s) and throws past that, which would kill every URL write on
//     the page. (Text typed and then abandoned by a browser Back/Forward is not
//     saved; leaving the page that way is leaving the search.)
//   - Every write is STAMPED with history state (OWN_WRITE). The URL is ADOPTED
//     into local state on mount and on every navigation that is not a stamped
//     write: Back/Forward always, and any PUSH or REPLACE that someone else made
//     - a tab switch, a nav link, a summary count (the router turns a same-URL
//     link into a REPLACE, so "not a REPLACE" would be the wrong test). The stamp
//     keeps a LATE commit of the page's own earlier write from reverting a newer
//     choice.
//   - A write is skipped while a navigation is still pending (the browser's
//     history entry has already moved; its transition has not committed): the
//     pending tab switch or Back wins rather than being overwritten.
//
// The component stays MOUNTED across /listings and /listings/deleted (sibling
// routes in the same element position, App.tsx); the tab switch is a PUSH to a
// bare path, so it re-adopts a clean selection - which is what keeps an
// authority picked on Active from locking the Deleted tab
// (docs/issues/properties-authority-filter-invisible-lock.md), with
// pruneSelection as the second defense.
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useNavigationType, useSearchParams } from 'react-router-dom';
import { LISTING_STATUSES, LISTING_STATUS_LABELS, type UnitItem } from '../../api/index.js';
import { Button, Spinner } from '../../ui/index.js';
import { NONE_KEY, NONE_LABEL, VOUCHER_BUCKETS } from '../contacts/tenantFacets.js';
import { formatBedsBaths, formatRent, shortAddress, statusLabel } from '../listing/listingFormat.js';
import { UnitCreateForm } from '../listing/UnitCreateForm.js';
import { AuthoritySummary } from './AuthoritySummary.js';
import {
  applyUnitListFilters,
  applyUnitListSelection,
  authorityOptions,
  buildAuthoritySummary,
  countSelection,
  isDefaultSelection,
  parseUnitListSelection,
  pruneSelection,
  type StatusFilter,
  type SummaryCounts,
  type UnitListSelection,
  type UnitListView,
} from './unitListFacets.js';
import { useListings } from './useListings.js';
import styles from './ListingsList.module.css';

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All statuses' },
  ...LISTING_STATUSES.map((s) => ({ value: s, label: LISTING_STATUS_LABELS[s] })),
];

/** The voucher chips: the Tenants list's fixed five, then Not recorded. */
const VOUCHER_CHIPS: ReadonlyArray<{ key: string; label: string }> = [
  ...VOUCHER_BUCKETS,
  { key: NONE_KEY, label: NONE_LABEL },
];

/** Toggle one key in a facet set, returning a new set. */
function toggled(keys: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(keys);
  if (!next.delete(key)) next.add(key);
  return next;
}

/** The query string a selection serializes to on this view (other params kept). */
function searchFor(base: URLSearchParams, sel: UnitListSelection, view: UnitListView): string {
  const params = new URLSearchParams(base);
  applyUnitListSelection(params, sel, view);
  return params.toString();
}

/** The history state stamped on this page's own URL writes (see the header). */
const OWN_WRITE = Object.freeze({ unitListFilterWrite: true });

function isOwnWrite(state: unknown): boolean {
  return (
    typeof state === 'object' &&
    state !== null &&
    (state as Record<string, unknown>)['unitListFilterWrite'] === true
  );
}

/** The browser history's stack index, which react-router 7 keeps in
 *  `window.history.state.idx`. A PUSH or a Back/Forward moves it; a REPLACE -
 *  every write this page makes - does not. Undefined without a real browser
 *  history (a MemoryRouter), which disarms the pending-navigation check. */
function historyIdx(): unknown {
  if (typeof window === 'undefined') return undefined;
  const state: unknown = window.history.state;
  return typeof state === 'object' && state !== null ? (state as Record<string, unknown>)['idx'] : undefined;
}

function Row({ unit, onOpen }: { unit: UnitItem; onOpen: () => void }): React.JSX.Element {
  const address = shortAddress(unit.address, unit.unitId);
  const beds = formatBedsBaths(unit.beds, unit.baths);
  const rent = formatRent(unit.rent_min, unit.rent_max);
  return (
    <li className={styles.rowItem}>
      {/* onOpen saves the search before the row navigates: a tap that does not
       *  blur the box first (iOS) must not lose it. */}
      <Link to={`/listings/${unit.unitId}`} className={styles.row} onClick={onOpen}>
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
  const chipsRef = useRef<HTMLDivElement>(null);
  return (
    <div className={styles.control}>
      <span className={styles.controlLabel} id={labelId}>
        {label}
      </span>
      <div className={styles.chips} role="group" aria-labelledby={labelId} ref={chipsRef}>
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
            onClick={() => {
              // Clear unmounts itself; hand keyboard focus to the group's first
              // chip first, so it does not fall back to the page body.
              chipsRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
              onChange(new Set<string>());
            }}
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
  const view: UnitListView = deleted ? 'deleted' : 'active';
  // The "New property" dialog (Active view only) with an empty landlord picker.
  const [creating, setCreating] = useState(false);

  // Local filter state, adopted from the URL on mount and on every navigation
  // that is not one of this page's own stamped writes (see the header): a POP
  // always, a PUSH or REPLACE unless it carries OWN_WRITE.
  const urlSelection = parseUnitListSelection(searchParams, view);
  const [chosen, setChosen] = useState<UnitListSelection>(urlSelection);
  const [syncedKey, setSyncedKey] = useState(location.key);
  if (location.key !== syncedKey) {
    setSyncedKey(location.key);
    if (navigationType === 'POP' || !isOwnWrite(location.state)) setChosen(urlSelection);
  }

  // Authority chips and summary rows come from EVERY loaded unit of this view
  // (never the filtered rows), labelled with the STORED spelling.
  const authority = useMemo(() => authorityOptions(units), [units]);
  // The effective selection: the chosen one minus anything no chip shows (the
  // invisible-lock invariant - unitListFacets.pruneSelection). ONLY once the
  // view's units are ready: a loading view has no chips to prune against, and
  // pruning then would strip every authority out of the URLs built below. Nothing
  // filters, and no control shows, while it loads.
  const selection = useMemo(
    () => (status === 'ready' ? pruneSelection(chosen, authority) : chosen),
    [status, chosen, authority],
  );
  const visible = useMemo(() => applyUnitListFilters(units, selection), [units, selection]);
  // The summary is the Active tab's alone; its counts follow the voucher filter.
  const summary = useMemo(
    () => (deleted ? null : buildAuthoritySummary(units, selection.voucher, authority)),
    [deleted, units, selection.voucher, authority],
  );

  // The history index of the COMMITTED location. While a PUSH or a Back/Forward
  // is still in flight, the browser's index has already moved past it. Recorded
  // in a LAYOUT effect - inside the commit, before any later event can run. A
  // passive effect runs after paint, so a filter tap landing between a
  // committed navigation and that effect read a stale index and was wrongly
  // skipped as "pending" (code review r3).
  const committedIdx = useRef<unknown>(undefined);
  useLayoutEffect(() => {
    committedIdx.current = historyIdx();
  }, [location.key]);

  /** Persist a selection to the URL - a stamped REPLACE, so Back leaves the page
   *  rather than walking filter changes (the Tenants-list rule). Skipped while a
   *  PUSH or Back/Forward is pending: replacing the browser's current entry then
   *  would cancel the tab switch or Back the user already made, and overwrite
   *  the entry it landed on. The pending navigation wins and is adopted. */
  function persist(next: UnitListSelection): void {
    if (historyIdx() !== committedIdx.current) return;
    setSearchParams(new URLSearchParams(searchFor(searchParams, next, view)), {
      replace: true,
      state: OWN_WRITE,
    });
  }

  /** A filter change: apply it now, persist it now. Always writes: comparing
   *  against the COMMITTED URL could wrongly skip while an earlier write is
   *  still in flight (a chip toggled on and straight back off). */
  function change(next: UnitListSelection): void {
    setChosen(next);
    persist(next);
  }

  /** Leaving the search box - or opening a row - persists its text, only when
   *  that changes the URL, so tabbing through the page spends no history calls.
   *  (Comparing against
   *  the committed URL could only skip wrongly after a blur, a refocus, an edit
   *  back to the committed text and a second blur, all inside one router
   *  transition - not a human sequence.) */
  function persistSearch(): void {
    if (searchFor(searchParams, selection, view) !== searchParams.toString()) persist(selection);
  }

  /** Where a summary count links. A PUSH, so Back undoes the drill-down - or, on
   *  a same-URL target, the router's REPLACE; either way it is not a stamped
   *  write, so the selection is adopted from the URL it lands on. */
  function countLink(column: keyof SummaryCounts, key: string | null): { pathname: string; search: string } {
    const search = searchFor(searchParams, countSelection(selection, column, key), view);
    return { pathname: location.pathname, search: search.length > 0 ? `?${search}` : '' };
  }

  const showControls = status === 'ready' && units.length > 0;
  const authorityChips = authority.hasUnrecorded
    ? [...authority.options, { key: NONE_KEY, label: NONE_LABEL }]
    : authority.options;
  // The current tab's link carries the UNPRUNED choice, typed text included: a
  // click on it while the view is still loading must not drop a selection the
  // loaded view would show.
  const currentSearch = searchFor(searchParams, chosen, view);
  const statusRef = useRef<HTMLSelectElement>(null);

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
              to={current ? { pathname: t.to, search: currentSearch } : t.to}
              className={`${styles.tab} ${current ? styles.tabActive : ''}`}
              {...(current && { 'aria-current': 'page' })}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>

      {showControls && summary !== null ? (
        <AuthoritySummary summary={summary} linkFor={countLink} />
      ) : null}

      {showControls ? (
        <div className={styles.controls}>
          <div className={styles.control}>
            <label className={styles.controlLabel} htmlFor="listings-status">
              Status
            </label>
            <select
              id="listings-status"
              ref={statusRef}
              className={styles.select}
              value={selection.status}
              onChange={(e) => change({ ...selection, status: e.target.value as StatusFilter })}
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
            onChange={(voucher) => change({ ...selection, voucher })}
          />

          <ChipGroup
            labelId="ha-filter-label"
            label="Housing authority"
            options={authorityChips}
            selected={selection.ha}
            onChange={(ha) => change({ ...selection, ha })}
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
          value={chosen.q}
          // Typing filters at once but never touches history; leaving the box
          // persists the text (see the header).
          onChange={(e) => {
            const q = e.target.value;
            setChosen((prev) => ({ ...prev, q }));
          }}
          onBlur={persistSearch}
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
              <Row key={unit.unitId} unit={unit} onOpen={persistSearch} />
            ))}
          </ul>
        ) : isDefaultSelection(selection, view) ? (
          // Nothing but the default status is in play - the user chose no
          // filter, so do not blame "the selected filters".
          <div className={styles.noMatches}>
            <p className={styles.noMatchesText}>No available properties right now.</p>
            <button
              type="button"
              className={styles.clear}
              onClick={() => {
                change({ ...selection, status: 'all' });
                // This button unmounts as the rows appear; keep keyboard focus
                // on the control it just changed instead of the page body -
                // without scrolling a phone back up, away from the new rows.
                statusRef.current?.focus({ preventScroll: true });
              }}
            >
              Show all statuses
            </button>
          </div>
        ) : (
          <p className={styles.noMatches}>
            {/* Entity quotes, never literal curly ones - added lines stay ASCII. */}
            {selection.q.trim() ? (
              <>No matches for &ldquo;{selection.q.trim()}&rdquo;.</>
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
