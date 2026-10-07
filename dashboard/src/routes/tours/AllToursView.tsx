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
// URL STATE (spec 4.7) is the Properties list's model (ListingsList.tsx): the
// filters are LOCAL state and the URL is their persistence. Control changes
// REPLACE the URL at once with a stamped write (OWN_WRITE); the search text is
// written on blur, never per keystroke. The URL is ADOPTED on mount, on every
// POP and on any navigation that is not a stamped write. A write is skipped
// while a navigation is still pending - the pending navigation wins. A filter
// change walks the NEW list at once when a search is set (spec 6), and Clear
// filters empties the search and stops the walk. A restore record in history
// state (spec 4.9) is bound to the list it was adopted for, so it can only
// ever drive that list.
//
// RETURNING FROM A TOUR (spec 4.8, 4.9): a row link carries { back, restore }
// (the LOCAL selection as a /tours/all URL, and the rows loaded plus the row's
// id and VISIBLE index); an unmodified primary click also stores the record in
// the list's own entry (a stamped REPLACE). Back with a record, the hook loads
// to its depth and the view focuses and scrolls to the opened row - or the row
// now at its position - unless the user acted first.
//
// THE LIST AREA follows the hook's status: loading -> the Spinner, and no
// count text and no actions (never "Showing 0 tours"); error -> the first-page
// failure and Retry, inside an alert; idle (an invalid date range) -> only the
// range message; ready -> the rows, then ONE action area. The count line is
// ONE role="status" element that stays mounted, empty, while nothing is ready
// (a live region inserted together with its text is not reliably announced).
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigationType, useSearchParams } from 'react-router-dom';
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
  applyTourListSelection,
  effectiveTourListSort,
  isDefaultTourListSelection,
  parseTourListRestore,
  parseTourListSelection,
  pruneTourListSelection,
  tourListApiKey,
  tourListRangeError,
  type TourListRestore,
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

/** This view's route; TourDetail's back arrow accepts it with any query. */
const ALL_TOURS_PATH = '/tours/all';

/** The history state stamped on this view's own URL writes. A row open adds
 *  `restore` (spec 4.9); every OTHER write replaces the whole state with the
 *  stamp alone, so a filter change or a blur save drops a restore record. */
const OWN_WRITE = Object.freeze({ tourListFilterWrite: true });

function isOwnWrite(state: unknown): boolean {
  return (
    typeof state === 'object' &&
    state !== null &&
    (state as Record<string, unknown>)['tourListFilterWrite'] === true
  );
}

/** The browser history's stack index, which react-router 7 keeps in
 *  `window.history.state.idx`. A PUSH or a Back/Forward moves it; a REPLACE -
 *  every write this view makes - does not. Undefined without a real browser
 *  history (a MemoryRouter), which disarms the pending-navigation check. */
function historyIdx(): unknown {
  if (typeof window === 'undefined') return undefined;
  const state: unknown = window.history.state;
  return typeof state === 'object' && state !== null ? (state as Record<string, unknown>)['idx'] : undefined;
}

/** The query string a selection writes (other params kept). */
function searchFor(base: URLSearchParams, sel: TourListSelection): string {
  const params = new URLSearchParams(base);
  applyTourListSelection(params, sel);
  return params.toString();
}

/** A restore record from history state, bound to the list it belongs to. */
function boundRestore(
  state: unknown,
  selection: TourListSelection,
): { record: TourListRestore; listKey: string } | null {
  const record = parseTourListRestore(state);
  return record === null ? null : { record, listKey: tourListApiKey(selection) };
}

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
  const location = useLocation();
  const navigationType = useNavigationType();
  const [searchParams, setSearchParams] = useSearchParams();
  // Local filter state, adopted from the URL on mount and on every navigation
  // that is not one of this view's own stamped writes: a POP always, a PUSH
  // or REPLACE unless it carries OWN_WRITE (see the header).
  const urlSelection = parseTourListSelection(searchParams);
  const [chosen, setChosen] = useState<TourListSelection>(urlSelection);
  // The search the WALK follows: set at once on adoption and on a filter
  // change, 300 ms after typing otherwise (spec 6).
  const [walkQ, setWalkQ] = useState(urlSelection.q);
  // The restore record (spec 4.9) is BOUND to the list it was adopted for: it
  // can only ever drive that list (plan review P1 - a record that survived a
  // filter change re-loaded every later list to the old depth).
  const [restore, setRestore] = useState<{ record: TourListRestore; listKey: string } | null>(() =>
    boundRestore(location.state, urlSelection),
  );
  const [syncedKey, setSyncedKey] = useState(location.key);
  if (location.key !== syncedKey) {
    setSyncedKey(location.key);
    if (navigationType === 'POP' || !isOwnWrite(location.state)) {
      setChosen(urlSelection);
      setWalkQ(urlSelection.q);
      setRestore(boundRestore(location.state, urlSelection));
    }
  }

  // The history index of the COMMITTED location. While a PUSH or a
  // Back/Forward is still in flight, the browser's index has already moved
  // past it. Recorded in a LAYOUT effect - inside the commit, before any later
  // event can run (ListingsList.tsx, code review r3 there).
  const committedIdx = useRef<unknown>(undefined);
  useLayoutEffect(() => {
    committedIdx.current = historyIdx();
  }, [location.key]);

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (searchTimer.current !== null) clearTimeout(searchTimer.current);
    },
    [],
  );
  const whenRef = useRef<HTMLSelectElement>(null);

  const listKey = tourListApiKey(chosen);
  const restoreDepth = restore !== null && restore.listKey === listKey ? restore.record.depth : null;
  // The second condition is a belt: a debounce timer that fires after a POP
  // adoption (it cannot be cleared during render) can never walk an EMPTY box.
  const data = useAllTours({ listKey, walk: walkQ.trim() !== '' && chosen.q.trim() !== '', restoreDepth });

  /** Persist a selection to the URL - a stamped REPLACE, so Back leaves the
   *  page rather than walking filter changes; a row open also stores its
   *  restore record in the entry's state (spec 4.9). Skipped while a PUSH or a
   *  Back/Forward is pending: replacing the browser's current entry then would
   *  cancel the navigation the user already made. Returns whether it wrote. */
  function persist(next: TourListSelection, restoreRecord?: TourListRestore): boolean {
    if (historyIdx() !== committedIdx.current) return false;
    setSearchParams(new URLSearchParams(searchFor(searchParams, next)), {
      replace: true,
      state: restoreRecord === undefined ? OWN_WRITE : { ...OWN_WRITE, restore: restoreRecord },
    });
    return true;
  }

  function clearSearchTimer(): void {
    if (searchTimer.current !== null) clearTimeout(searchTimer.current);
    searchTimer.current = null;
  }

  /** EVERY control change, Clear filters included: apply it now, walk the new
   *  list at once when a search is set (or stop the walk when Clear filters
   *  empties the box), drop the restore record, persist it now. Always writes:
   *  comparing against the COMMITTED URL could wrongly skip while an earlier
   *  write is still in flight. */
  function change(next: TourListSelection): void {
    clearSearchTimer();
    setChosen(next);
    setWalkQ(next.q);
    setRestore(null);
    persist(next);
  }

  /** Typing narrows the loaded rows at once and never touches history; the
   *  walk follows 300 ms after the last keystroke, and stops at once when the
   *  box is emptied. */
  function search(value: string): void {
    setChosen((prev) => ({ ...prev, q: value }));
    clearSearchTimer();
    if (value.trim() === '') setWalkQ('');
    else searchTimer.current = setTimeout(() => setWalkQ(value), SEARCH_DEBOUNCE_MS);
  }

  /** Leaving the search box persists its text, only when that changes the URL
   *  (so tabbing through the page spends no history calls). That write drops
   *  the entry's restore record, so the view drops it too. */
  function persistSearch(): void {
    if (searchFor(searchParams, chosen) !== searchParams.toString() && persist(chosen)) setRestore(null);
  }

  function clearFilters(): void {
    // The button unmounts once the filters are cleared: keep keyboard focus
    // on the first control instead of the page body.
    whenRef.current?.focus({ preventScroll: true });
    change(DEFAULT_TOUR_LIST_SELECTION);
  }

  /** After a dead list: page 1 of a new list, and no restore (spec 4.9). */
  function startOver(): void {
    data.startOver();
    setRestore(null);
  }

  const rangeError = tourListRangeError(chosen);
  // The effective selection: the chosen one minus what no control shows (spec
  // 4.3). The chips and Clear filters render from it, as #1 renders its
  // pruned `selection` (ListingsList.tsx).
  const selection = pruneTourListSelection(chosen);
  // Needs booking is a request - it has no date, so a dated When hides it.
  const statusChips =
    chosen.when === 'any' ? TOUR_LIST_STATUS_CHIPS : TOUR_LIST_STATUS_CHIPS.filter((c) => c.value !== 'requested');
  const showClearFilters = !isDefaultTourListSelection(selection);

  // Where a row's back arrow returns (spec 4.8): the LOCAL selection - an
  // unsaved search included - serialized exactly as the URL writes it, never
  // read from `location`.
  const backSearch = searchFor(new URLSearchParams(), chosen);
  const back = backSearch === '' ? ALL_TOURS_PATH : `${ALL_TOURS_PATH}?${backSearch}`;

  const needle = chosen.q.trim().toLowerCase();
  const searching = needle !== '';
  const views = data.rows.map((r) => rowView(r, data.contacts, data.units));
  const visible = searching
    ? views.filter((v) => v.tenant.toLowerCase().includes(needle) || v.property.toLowerCase().includes(needle))
    : views;
  const ready = data.status === 'ready';

  // THE RETURN ANCHOR (spec 4.9). A convenience, never a hijack: any
  // user-intent event after mount cancels it. Not 'scroll' (the browser
  // scrolls on its own) and not click / keyup / pointerup (the tail of the
  // gesture that brought the user back). Refs are read only inside effects.
  const userActed = useRef(false);
  useEffect(() => {
    const mark = (): void => {
      userActed.current = true;
    };
    const kinds = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    for (const k of kinds) document.addEventListener(k, mark, { capture: true, passive: true });
    return () => {
      for (const k of kinds) document.removeEventListener(k, mark, { capture: true });
    };
  }, []);

  const listRef = useRef<HTMLUListElement>(null);
  const anchoredFor = useRef<TourListRestore | null>(null);
  // The record that applies to THIS list (bound at adoption).
  const record = restore !== null && restore.listKey === listKey ? restore.record : null;
  useLayoutEffect(() => {
    if (record === null || anchoredFor.current === record) return;
    if (data.restoreOutcome !== 'reached' && data.restoreOutcome !== 'capped') return;
    anchoredFor.current = record;
    if (userActed.current) return;
    // Among the VISIBLE rows: the opened row when it is there; else, when the
    // list was loaded to the depth (or ended), the row now at its position -
    // the next one to work on - clamped to the last; else (a capped restore
    // that stopped short, an empty list) nothing.
    const ids = visible.map((v) => v.row.tourId);
    let target: string | undefined = ids.includes(record.openedTourId) ? record.openedTourId : undefined;
    if (target === undefined && data.restoreOutcome === 'reached' && ids.length > 0) {
      target = ids[Math.min(record.openedIndex, ids.length - 1)];
    }
    if (target === undefined) return;
    const link = [...(listRef.current?.querySelectorAll<HTMLAnchorElement>('a[data-tour-id]') ?? [])].find(
      (a) => a.dataset['tourId'] === target,
    );
    // The house idiom (StatusMenu.tsx): focus without the browser's own
    // scroll, then the smallest scroll that shows it.
    link?.focus({ preventScroll: true });
    link?.scrollIntoView({ block: 'nearest' });
  }, [record, data.restoreOutcome, visible]);

  /** An unmodified primary click on a row opens it HERE: the list's own entry
   *  then remembers where the user was (a stamped REPLACE whose state carries
   *  the restore record, the search text included). react-router runs a
   *  Link's onClick even for a modified click, so the check is this
   *  handler's: any other click opens the tour elsewhere and writes nothing. */
  function openRow(e: React.MouseEvent<HTMLAnchorElement>, tourId: string, index: number): void {
    if (e.button !== 0 || e.metaKey || e.altKey || e.ctrlKey || e.shiftKey) return;
    persist(chosen, { depth: data.rows.length, openedTourId: tourId, openedIndex: index });
  }

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
          selected={selection.statuses}
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

        {/* Between Tour type and Sort: the spec's control order (4.3). */}
        <div className={`${styles.control} ${styles.search}`}>
          <label className={styles.controlLabel} htmlFor="tours-all-search">
            Search
          </label>
          <input
            id="tours-all-search"
            type="search"
            className={styles.searchInput}
            placeholder="Search tenant or property"
            value={chosen.q}
            onChange={(e) => search(e.target.value)}
            onBlur={persistSearch}
          />
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

      {/* From after To: nothing is sent (the hook is idle) and the list area
          keeps the message until it is fixed (spec 4.3) - outside the count
          line, as well as under the inputs. */}
      {data.status === 'idle' && rangeError !== null ? (
        <div className={rowStyles.empty}>
          <p className={rowStyles.emptyText}>{rangeError}</p>
        </div>
      ) : null}

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
        <ul className={rowStyles.rows} aria-label="All tours list" ref={listRef}>
          {visible.map((v, i) => (
            <li key={v.row.tourId} className={rowStyles.rowItem}>
              {/* The router state hands the tour page its back pointer and the
                  restore record: the rows LOADED, and this row's id and
                  position among the VISIBLE rows (spec 4.8, 4.9). */}
              <Link
                to={`/tours/${v.row.tourId}`}
                state={{ back, restore: { depth: data.rows.length, openedTourId: v.row.tourId, openedIndex: i } }}
                onClick={(e) => openRow(e, v.row.tourId, i)}
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
            <Button variant="secondary" size="sm" type="button" onClick={startOver}>
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
