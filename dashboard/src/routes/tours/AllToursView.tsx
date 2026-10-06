// AllToursView - the Tours page's All tab body (spec docs/superpowers/specs/
// 2026-10-06-tour-list-design.md sections 4.3-4.9 and 6): every tour,
// upcoming and past, filtered and paged by the server (GET /api/tours/list,
// through useAllTours). ToursPage mounts it in place of the named views'
// component, so on /tours/all nothing else loads.
//
// FILTERS: When (with From / To under Date range), the Status chips, Tour
// type, Sort and the search box. The selection is PRUNED before it is sent - a
// filter the user can neither see nor clear never filters (spec 4.3). The
// search narrows the LOADED rows at once (tenant or property, as displayed);
// 300 ms after typing stops, the hook walks the rest of the filtered list.
//
// THE LIST AREA follows the hook's status: loading -> the Spinner, and no
// count text and no actions (never "Showing 0 tours"); error -> the first-page
// failure and Retry, inside an alert; idle (an invalid date range) -> only the
// range message; ready -> the rows, then ONE action area. The count line is
// ONE role="status" element that stays mounted, empty, while nothing is ready
// (a live region inserted together with its text is not reliably announced).
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  TOUR_OUTCOME_LABELS,
  TOUR_TYPE_LABELS,
  tourStatusLabel,
  undatedTourLabel,
  type TourListContactName,
  type TourListRow,
  type TourListUnitAddress,
  type TourType,
} from '../../api/index.js';
import { Button, Spinner } from '../../ui/index.js';
import { contactDisplayName, formatAddress } from '../contact/format.js';
import {
  DEFAULT_TOUR_LIST_SELECTION,
  TOUR_LIST_SORT_OPTIONS,
  TOUR_LIST_STATUS_CHIPS,
  TOUR_LIST_TYPE_OPTIONS,
  TOUR_LIST_WHEN_OPTIONS,
  effectiveTourListSort,
  isDefaultTourListSelection,
  parseTourListSelection,
  tourListApiKey,
  tourListRangeError,
  type TourListSelection,
  type TourListSort,
  type TourListWhen,
} from './tourListSelection.js';
import { whenLabel } from './tourTime.js';
import { useAllTours, type AllToursData } from './useAllTours.js';
import rowStyles from './ToursPage.module.css';
import styles from './AllToursView.module.css';

/** The search walk starts this long after typing stops (spec 6). */
const SEARCH_DEBOUNCE_MS = 300;

/** Toggle one value in a chip set, returning a new set. */
function toggled<T>(values: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(values);
  if (!next.delete(value)) next.add(value);
  return next;
}

/** One multi-select chip group - the Properties list's ChipGroup
 *  (ListingsList.tsx), over values: the uppercase label, the aria-pressed
 *  chips inside a group named by it, and a Clear once anything is selected.
 *  Divs + buttons, deliberately NO ul/li, so the rows list stays the only
 *  source of listitems. */
function ChipGroup<T extends string>({
  labelId,
  label,
  options,
  selected,
  onChange,
}: {
  labelId: string;
  label: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  selected: ReadonlySet<T>;
  onChange: (next: Set<T>) => void;
}): React.JSX.Element {
  const chipsRef = useRef<HTMLDivElement>(null);
  return (
    <div className={styles.control}>
      <span className={styles.controlLabel} id={labelId}>
        {label}
      </span>
      <div className={styles.chips} role="group" aria-labelledby={labelId} ref={chipsRef}>
        {options.map((o) => {
          const on = selected.has(o.value);
          return (
            <button
              key={o.value}
              type="button"
              className={`${styles.chip} ${on ? styles.chipOn : ''}`}
              aria-pressed={on}
              onClick={() => onChange(toggled(selected, o.value))}
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
              onChange(new Set<T>());
            }}
          >
            Clear
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** A row as displayed: the labels the search matches and the name reads. */
interface RowView {
  row: TourListRow;
  tenant: string;
  property: string;
  /** The date column: the date and time, else "Needs booking" / "Undated". */
  date: string;
  status: string;
  /** A closed tour's outcome; never on any other status. */
  outcome: string | undefined;
  type: string;
}

function rowView(
  row: TourListRow,
  contacts: Record<string, TourListContactName>,
  units: Record<string, TourListUnitAddress>,
): RowView {
  // A missing name entry falls back to the raw id, like the other tabs (spec
  // 4.4); an entry with no name or phone reads "Unknown contact", and an
  // address that formats to nothing reads the unit id (ToursPage.tsx).
  const contact = Object.hasOwn(contacts, row.tenantId) ? contacts[row.tenantId] : undefined;
  const unit = Object.hasOwn(units, row.unitId) ? units[row.unitId] : undefined;
  return {
    row,
    tenant:
      contact === undefined ? row.tenantId : contactDisplayName(contact.firstName, contact.lastName, contact.phone),
    property: (unit === undefined ? '' : formatAddress(unit.address)) || row.unitId,
    date: whenLabel(row.scheduledAt) || undatedTourLabel(row),
    status: tourStatusLabel(row),
    outcome:
      row.status === 'closed' && row.outcome !== undefined
        ? (TOUR_OUTCOME_LABELS[row.outcome] ?? row.outcome)
        : undefined,
    type: TOUR_TYPE_LABELS[row.tourType] ?? row.tourType,
  };
}

/** The row link's accessible name (spec 4.4): who and where, the date column,
 *  the status, and a closed row's outcome. */
function rowName(v: RowView): string {
  const name = `Tour for ${v.tenant} at ${v.property}, ${v.date}, ${v.status}`;
  return v.outcome === undefined ? name : `${name}, ${v.outcome}`;
}

function counted(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The count line's text for a READY list (spec 4.5 and 6). */
function countText(data: AllToursData, searching: boolean, matches: number): string {
  if (searching) {
    const m = counted(matches, 'match', 'matches');
    if (data.loader === 'walk') return `Searching... ${m} so far`;
    return data.complete ? m : `${m} so far - not the whole list`;
  }
  if (data.loader === 'follow') return 'Checking more tours...';
  const t = counted(data.rows.length, 'tour', 'tours');
  return data.complete ? t : `Showing ${t}`;
}

export function AllToursView(): React.JSX.Element {
  const [searchParams] = useSearchParams();
  // The filters are LOCAL state, adopted from the URL on mount.
  const urlSelection = parseTourListSelection(searchParams);
  const [chosen, setChosen] = useState<TourListSelection>(urlSelection);
  // The search the WALK follows: the adopted search at once, typing 300 ms
  // after it stops (spec 6).
  const [walkQ, setWalkQ] = useState(urlSelection.q);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (searchTimer.current !== null) clearTimeout(searchTimer.current);
    },
    [],
  );
  const whenRef = useRef<HTMLSelectElement>(null);

  const listKey = tourListApiKey(chosen);
  // The second condition is a belt: a debounce timer can never walk an EMPTY
  // box.
  const data = useAllTours({ listKey, walk: walkQ.trim() !== '' && chosen.q.trim() !== '', restoreDepth: null });

  /** A filter change: a new selection, so a new list. */
  function change(next: TourListSelection): void {
    setChosen(next);
  }

  /** Typing narrows the loaded rows at once; the walk follows 300 ms after the
   *  last keystroke, and stops at once when the box is emptied. */
  function search(value: string): void {
    setChosen((prev) => ({ ...prev, q: value }));
    if (searchTimer.current !== null) clearTimeout(searchTimer.current);
    searchTimer.current = null;
    if (value.trim() === '') setWalkQ('');
    else searchTimer.current = setTimeout(() => setWalkQ(value), SEARCH_DEBOUNCE_MS);
  }

  function clearFilters(): void {
    // The button unmounts once the filters are cleared: keep keyboard focus
    // on the first control instead of the page body.
    whenRef.current?.focus({ preventScroll: true });
    change(DEFAULT_TOUR_LIST_SELECTION);
  }

  const rangeError = tourListRangeError(chosen);
  // Needs booking is a request - it has no date, so a dated When hides it.
  const statusChips =
    chosen.when === 'any' ? TOUR_LIST_STATUS_CHIPS : TOUR_LIST_STATUS_CHIPS.filter((c) => c.value !== 'requested');
  const showClearFilters = !isDefaultTourListSelection(chosen);

  const needle = chosen.q.trim().toLowerCase();
  const searching = needle !== '';
  const views = data.rows.map((r) => rowView(r, data.contacts, data.units));
  const visible = searching
    ? views.filter((v) => v.tenant.toLowerCase().includes(needle) || v.property.toLowerCase().includes(needle))
    : views;
  const ready = data.status === 'ready';

  return (
    <section aria-label="All tours">
      <div className={styles.controls}>
        <div className={styles.control}>
          <label className={styles.controlLabel} htmlFor="tours-all-when">
            When
          </label>
          <select
            id="tours-all-when"
            ref={whenRef}
            className={styles.select}
            value={chosen.when}
            onChange={(e) => change({ ...chosen, when: e.target.value as TourListWhen })}
          >
            {TOUR_LIST_WHEN_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        {chosen.when === 'range' ? (
          <div className={styles.dateInputs}>
            <div className={styles.control}>
              <label className={styles.controlLabel} htmlFor="tours-all-from">
                From
              </label>
              <input
                id="tours-all-from"
                type="date"
                className={styles.select}
                value={chosen.from}
                onChange={(e) => change({ ...chosen, from: e.target.value })}
              />
            </div>
            <div className={styles.control}>
              <label className={styles.controlLabel} htmlFor="tours-all-to">
                To
              </label>
              <input
                id="tours-all-to"
                type="date"
                className={styles.select}
                value={chosen.to}
                onChange={(e) => change({ ...chosen, to: e.target.value })}
              />
            </div>
            {/* Under the inputs; nothing is sent until it is fixed (spec 4.3). */}
            {rangeError !== null ? <p className={styles.rangeError}>{rangeError}</p> : null}
          </div>
        ) : null}

        <ChipGroup
          labelId="tours-all-status-label"
          label="Status"
          options={statusChips}
          selected={chosen.statuses}
          onChange={(statuses) => change({ ...chosen, statuses })}
        />

        <div className={styles.control}>
          <label className={styles.controlLabel} htmlFor="tours-all-type">
            Tour type
          </label>
          <select
            id="tours-all-type"
            className={styles.select}
            value={chosen.type}
            onChange={(e) => change({ ...chosen, type: e.target.value as TourType | '' })}
          >
            {TOUR_LIST_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.control}>
          <label className={styles.controlLabel} htmlFor="tours-all-sort">
            Sort
          </label>
          <select
            id="tours-all-sort"
            className={styles.select}
            value={effectiveTourListSort(chosen)}
            onChange={(e) => change({ ...chosen, sort: e.target.value as TourListSort })}
          >
            {TOUR_LIST_SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        {showClearFilters ? (
          <button type="button" className={`${styles.clear} ${styles.resetAll}`} onClick={clearFilters}>
            Clear filters
          </button>
        ) : null}
      </div>

      <div className={styles.search}>
        <label className={styles.searchLabel} htmlFor="tours-all-search">
          Search
        </label>
        <input
          id="tours-all-search"
          type="search"
          className={styles.searchInput}
          placeholder="Search tenant or property"
          value={chosen.q}
          onChange={(e) => search(e.target.value)}
        />
      </div>

      {/* ONE status region: the count, plus the walk-cap sentence and the
          refreshed notice as their own spans (spec 4.5: the count line says
          it). Mounted and EMPTY while nothing is ready (ruling D-6). */}
      <p className={styles.countLine} role="status">
        {ready ? <span>{countText(data, searching, visible.length)}</span> : null}
        {ready && searching && data.walkCapped && !data.complete ? (
          <span className={styles.notice}>
            {' Search stopped before the end of the list. Narrow the filters to search the rest.'}
          </span>
        ) : null}
        {ready && data.refreshed ? <span className={styles.notice}>{' The list was refreshed.'}</span> : null}
      </p>

      {data.status === 'loading' ? <Spinner center /> : null}

      {data.status === 'error' ? (
        <div className={styles.failure} role="alert">
          <p className={styles.errorText}>We couldn&apos;t load tours. Please try again.</p>
          <Button variant="secondary" size="sm" type="button" onClick={() => data.retry()}>
            Retry
          </Button>
        </div>
      ) : null}

      {ready && visible.length > 0 ? (
        <ul className={rowStyles.rows} aria-label="All tours list">
          {visible.map((v) => (
            <li key={v.row.tourId} className={rowStyles.rowItem}>
              <Link
                to={`/tours/${v.row.tourId}`}
                className={rowStyles.row}
                aria-label={rowName(v)}
                data-tour-id={v.row.tourId}
              >
                <span className={rowStyles.main}>
                  <span className={rowStyles.tenant}>{v.tenant}</span>
                  <span className={rowStyles.property}>{v.property}</span>
                </span>
                <span className={rowStyles.meta}>
                  <span className={rowStyles.time}>{v.date}</span>
                  <span className={rowStyles.badge}>{v.status}</span>
                  {v.outcome !== undefined ? <span className={rowStyles.badge}>{v.outcome}</span> : null}
                  <span className={rowStyles.badge}>{v.type}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}

      {ready && visible.length === 0 && data.complete ? (
        <div className={rowStyles.empty}>
          <p className={rowStyles.emptyText}>No tours match these filters.</p>
          {showClearFilters ? (
            <button type="button" className={styles.clear} onClick={clearFilters}>
              Clear filters
            </button>
          ) : null}
        </div>
      ) : null}

      {/* ONE action area, first match wins (spec 4.5): a dead list offers only
          Start over (never a Retry that would resend the rejected cursor); a
          failed page offers Retry; a capped follow offers Keep checking
          INSTEAD of Load more; Load more only while no loader runs. */}
      {ready ? (
        data.dead ? (
          <div className={styles.actions} role="alert">
            <p className={styles.errorText}>We couldn&apos;t load more tours.</p>
            <Button variant="secondary" size="sm" type="button" onClick={() => data.startOver()}>
              Start over
            </Button>
          </div>
        ) : data.moreFailed ? (
          <div className={styles.actions} role="alert">
            <p className={styles.errorText}>We couldn&apos;t load tours. Please try again.</p>
            <Button variant="secondary" size="sm" type="button" onClick={() => data.loadMore()}>
              Retry
            </Button>
          </div>
        ) : data.followCapped && data.loader === 'none' ? (
          <div className={styles.actions}>
            <p className={styles.actionText}>No more matches in the tours checked so far.</p>
            <Button variant="secondary" size="sm" type="button" onClick={() => data.loadMore()}>
              Keep checking
            </Button>
          </div>
        ) : !data.complete && data.loader === 'none' ? (
          <div className={styles.actions}>
            <Button variant="secondary" size="sm" type="button" onClick={() => data.loadMore()}>
              Load more
            </Button>
          </div>
        ) : null
      ) : null}
    </section>
  );
}
