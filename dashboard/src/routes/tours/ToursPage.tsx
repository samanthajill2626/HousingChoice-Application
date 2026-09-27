// ToursPage - the /tours list page, in three URL-backed VIEWS switched by the
// Active | Past | Closed tabs (mirrors the properties list's Active/Deleted tabs;
// Cameron 2026-07-15 - the URL is the source of truth):
//
//   Active (/tours) — two sections:
//     Upcoming  — tours in the next 30 days (from=start-of-today, to=+30d),
//                 grouped by local date (soonest first; "Today" label for today).
//                 Row: tenant name - property (unit address) - time - status - type.
//     Needs booking — time-less tours (status='requested'), oldest first.
//                 Row: tenant name - property - status - type (no time column).
//
//   Past (/tours/past) - the last 90 days' tours (through the end of today)
//                 that still need a decision (spec 4): rows carry a
//                 plain-words state, a Mark toured button / Record outcome
//                 link, a checkbox, and a bulk Mark toured (N) toolbar; each
//                 mark re-reads the tour first. PastToursView is a Past-only
//                 child, so its selection and batch results never survive a
//                 tab switch. The batch's busy flag (also its in-flight guard)
//                 and the mounted view's reload slot are MODULE state - one
//                 batch per browser tab - so a tab switch or a route change
//                 (to a tour page and back) while a batch runs still shows
//                 every mark control disabled, and the batch's refresh
//                 reaches the Past view mounted when it ends. A full page
//                 reload ends the batch.
//
//   Closed (/tours/closed) — the "not live" tours: status closed (terminal)
//                 AND canceled (revivable - Cameron 2026-07-15), newest first
//                 (fetched only on this view). Rows show the tour DATE (not
//                 time-of-day - these can be months old); the status badge
//                 tells Closed and Canceled apart.
//
// The Active view's header carries "+ New tour" (Cameron 2026-07-15): the SAME
// Schedule-a-tour dialog the tenant file opens, with both sides free typeaheads;
// a 201 navigates to the new tour (mirrors the properties "+ New property").
//
// Each row links to /tours/:tourId (the TourDetail page). Tenant names and unit
// labels are resolved from the full contacts + units lists (same cross-reference
// pattern used by PlacementsBoard / TenantFile) — INCLUDING soft-deleted records:
// a closed tour routinely outlives its contact/unit (tenant placed, property
// removed from inventory), and a live-only map rendered raw uuids for those rows.
// Staff-facing vocabulary: "property" for the unit (per GLOSSARY.md).
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  TOUR_STATUS_LABELS,
  TOUR_TYPE_LABELS,
  getTour,
  patchTour,
  type Tour,
  type Contact,
  type UnitItem,
} from '../../api/index.js';
import { Button, Spinner } from '../../ui/index.js';
import { contactDisplayName, formatAddress } from '../contact/format.js';
import { ScheduleTourForm } from './ScheduleTourForm.js';
import { pastState, useClosedTours, usePastTours, useTours } from './useTours.js';
import { useContacts } from '../contacts/useContacts.js';
import { useListings } from '../listings/useListings.js';
import styles from './ToursPage.module.css';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve a tenant's display name from the contacts map. Falls back to the
 *  raw tenantId when the contact hasn't loaded yet. */
function tenantName(contacts: Map<string, Contact>, tenantId: string): string {
  const c = contacts.get(tenantId);
  if (!c) return tenantId;
  return contactDisplayName(c.firstName, c.lastName, c.phone);
}

/** Resolve a unit's property label from the units map. Falls back to the
 *  unitId when the unit hasn't loaded yet. Staff-facing word: "property". */
function propertyLabel(units: Map<string, UnitItem>, unitId: string): string {
  const u = units.get(unitId);
  if (!u) return unitId;
  return formatAddress(u.address) || unitId;
}

/** Format just the time part of a scheduledAt ISO string for display, e.g.
 *  "2:30 PM". Returns '' when absent or unparseable. */
function formatTime(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/** Format the DATE of a scheduledAt ISO string, e.g. "Jul 14, 2026" — the
 *  Closed section's lead column (a months-old tour's time-of-day is noise).
 *  Returns '' when absent or unparseable. */
function formatDate(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** YYYY-MM-DD local key for grouping. Returns '' for undefined input. */
function localDateKey(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** A human-readable date group header, e.g. "Today", "Thu Jul 3". */
function dateGroupLabel(dateKey: string, todayKey: string): string {
  if (dateKey === todayKey) return 'Today';
  const d = new Date(`${dateKey}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateKey;
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

/** Today's YYYY-MM-DD key in local time. */
function todayKey(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = (now.getMonth() + 1).toString().padStart(2, '0');
  const d = now.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ---------------------------------------------------------------------------
// Row components
// ---------------------------------------------------------------------------

interface TourRowProps {
  tour: Tour;
  contacts: Map<string, Contact>;
  units: Map<string, UnitItem>;
  /** The lead meta column: the tour's time (Upcoming - the date is the group
   *  header), its date (Closed - possibly months old), or nothing (Needs
   *  booking - timeless). */
  timeDisplay: 'time' | 'date' | 'none';
}

function TourRow({ tour, contacts, units, timeDisplay }: TourRowProps): React.JSX.Element {
  const tenant = tenantName(contacts, tour.tenantId);
  const property = propertyLabel(units, tour.unitId);
  const timeLabel =
    timeDisplay === 'time'
      ? formatTime(tour.scheduledAt)
      : timeDisplay === 'date'
        ? formatDate(tour.scheduledAt)
        : undefined;
  const statusLabel = TOUR_STATUS_LABELS[tour.status] ?? tour.status;
  const typeLabel = TOUR_TYPE_LABELS[tour.tourType as keyof typeof TOUR_TYPE_LABELS] ?? tour.tourType;

  return (
    <li className={styles.rowItem}>
      <Link
        to={`/tours/${tour.tourId}`}
        className={styles.row}
        aria-label={`Tour for ${tenant} at ${property}`}
      >
        {/* Identity (tenant + property). On a tight content pane .main stacks and
         *  the meta chips wrap to their own line below (container query in the CSS),
         *  so the name + address never get crushed to a couple of characters. */}
        <span className={styles.main}>
          <span className={styles.tenant}>{tenant}</span>
          <span className={styles.property}>{property}</span>
        </span>
        <span className={styles.meta}>
          {timeLabel !== undefined ? <span className={styles.time}>{timeLabel}</span> : null}
          <span className={styles.badge}>{statusLabel}</span>
          <span className={styles.badge}>{typeLabel}</span>
        </span>
      </Link>
    </li>
  );
}

interface PastTourRowProps {
  tour: Tour;
  contacts: Map<string, Contact>;
  units: Map<string, UnitItem>;
  selected: boolean;
  onToggle: () => void;
  onMarkToured: () => void;
  busy: boolean;
  result: MarkResult | undefined;
}

/** A Past row (spec 4.3): the link carries identity + meta and the back
 *  pointer; the checkbox and the actions sit BESIDE it (interactive content
 *  cannot nest inside an <a>), each in a fixed slot every row renders.
 *  Every accessible name ends with the row's date-time so two tours for one
 *  tenant at one property stay distinct. */
function PastTourRow({
  tour,
  contacts,
  units,
  selected,
  onToggle,
  onMarkToured,
  busy,
  result,
}: PastTourRowProps): React.JSX.Element {
  const tenant = tenantName(contacts, tour.tenantId);
  const property = propertyLabel(units, tour.unitId);
  const when = whenLabel(tour.scheduledAt);
  const who = `${tenant} at ${property} on ${when}`;
  const notMarked = tour.status === 'scheduled';
  const needsOutcome = tour.status === 'toured' && tour.outcome === undefined;

  return (
    <li className={styles.rowItem}>
      <div className={styles.pastRow}>
        {/* Two fixed slots on EVERY row (OD-7), each empty when the row has
            nothing to put there: a leading one the checkbox's width and a
            trailing one the widest action's, so every card shares one left
            and one right edge and the chips line up down the list. */}
        <span className={styles.lead}>
          {notMarked ? (
            <input
              type="checkbox"
              className={styles.check}
              checked={selected}
              disabled={busy}
              onChange={onToggle}
              aria-label={`Select tour for ${who}`}
            />
          ) : null}
        </span>
        <Link
          to={`/tours/${tour.tourId}`}
          state={BACK_TO_PAST}
          className={styles.row}
          aria-label={`Tour for ${who}`}
        >
          <span className={styles.main}>
            <span className={styles.tenant}>{tenant}</span>
            <span className={styles.property}>{property}</span>
          </span>
          <span className={styles.meta}>
            {when.length > 0 ? <span className={styles.time}>{when}</span> : null}
            <span className={styles.badge}>{pastState(tour)}</span>
          </span>
        </Link>
        <span className={styles.rowActions}>
          {notMarked ? (
            <Button
              size="sm"
              variant="secondary"
              type="button"
              disabled={busy}
              onClick={onMarkToured}
              aria-label={`Mark toured: ${who}`}
            >
              Mark toured
            </Button>
          ) : null}
          {needsOutcome ? (
            <Link
              to={`/tours/${tour.tourId}?outcome=1`}
              state={BACK_TO_PAST}
              className={styles.actionLink}
              aria-label={`Record outcome: ${who}`}
            >
              Record outcome
            </Link>
          ) : null}
        </span>
      </div>
      {result !== undefined ? (
        result.ok ? (
          <p role="status" className={styles.rowResult}>
            Marked toured
          </p>
        ) : (
          <p role="alert" className={`${styles.rowResult} ${styles.rowResultError}`}>
            Could not mark toured: {result.message}
          </p>
        )
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------------------
// The Past batch store - one bulk "Mark toured" batch per browser tab
// ---------------------------------------------------------------------------

// The runner's busy flag (which is also its in-flight guard) and the slot for
// the MOUNTED Past view's reload live at MODULE scope, not in a component. A
// batch keeps running after the view that started it unmounts: on a tab
// switch, and on a route change (a row link or Record outcome to
// /tours/:tourId, then back) that unmounts the whole page. So the flag outlives
// every page instance: each Past view mounted meanwhile renders every mark
// control disabled, the runner refuses a second batch, and the refresh reaches
// whichever Past view is mounted when the batch ends. One batch per browser
// tab, across tab switches AND route changes; a full page reload ends it (the
// module state starts fresh).
let batchRunning = false;
const batchListeners = new Set<() => void>();

function subscribeBatch(cb: () => void): () => void {
  batchListeners.add(cb);
  return () => {
    batchListeners.delete(cb);
  };
}

function readBatch(): boolean {
  return batchRunning;
}

/** Called only on the runner's event-handler path - never in render or in an
 *  effect. */
function setBatchRunning(next: boolean): void {
  if (batchRunning === next) return;
  batchRunning = next;
  for (const cb of batchListeners) cb();
}

/** The mounted Past view's reload; each view registers its own while mounted. */
let mountedPastReload: (() => void) | null = null;

/** Test isolation only: end any batch a previous test left running. */
export function resetBulkBatchStoreForTests(): void {
  setBatchRunning(false);
  mountedPastReload = null;
}

/** The page's name maps. The batch state is NOT a prop: the busy flag, the
 *  in-flight guard and the mounted view's reload slot are the module store
 *  above, so they hold for every Past view in this browser tab - across tab
 *  switches AND route changes (one batch per browser tab; a full page reload
 *  ends it). */
interface PastToursViewProps {
  contacts: Map<string, Contact>;
  units: Map<string, UnitItem>;
}

/** The Past tab's body (spec 4.2-4.5): the lazy data hook, the bulk runner
 *  and the view's own batch state (selection, results, snapshot). Mounted
 *  ONLY while the Past view shows. */
function PastToursView({ contacts, units }: PastToursViewProps): React.JSX.Element {
  // Enabled for this component's whole life: it exists only on the Past view.
  const { status: pastStatus, past: pastTours, reload: reloadPast, reloadFailed } = usePastTours(true);
  // True while ANY batch in this browser tab runs, including one an earlier,
  // since-unmounted view started (the module store above).
  const bulkBusy = useSyncExternalStore(subscribeBatch, readBatch);

  // Register this view's reload as the mounted one while mounted: a module
  // write in an effect - no state is set here. The cleanup clears the slot
  // only while it still holds THIS view's reload. `reloadPast` is
  // identity-stable, so this runs once per mount.
  useEffect(() => {
    mountedPastReload = reloadPast;
    return () => {
      if (mountedPastReload === reloadPast) mountedPastReload = null;
    };
  }, [reloadPast]);

  // Bulk "Mark toured" (spec 4.5): the raw selection and the per-row results
  // of the LAST batch (cleared when the next one starts). `snapshot` remembers
  // what each id looked like when the batch ran, so a row the reload drops can
  // still be named in the above-toolbar block. The busy flag that drives the
  // disabled controls and the re-entry guard are the module store's (above).
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [results, setResults] = useState<ReadonlyMap<string, MarkResult>>(new Map());
  const [snapshot, setSnapshot] = useState<ReadonlyMap<string, Tour>>(new Map());

  // Only "Not marked" rows can be selected; a row that left that state (marked
  // elsewhere, then reloaded) drops out of the effective selection.
  const notMarkedIds = useMemo(
    () => pastTours.filter((t) => t.status === 'scheduled').map((t) => t.tourId),
    [pastTours],
  );
  const selected = useMemo(
    () => new Set(notMarkedIds.filter((id) => selectedIds.has(id))),
    [notMarkedIds, selectedIds],
  );
  const allSelected = notMarkedIds.length > 0 && selected.size === notMarkedIds.length;
  const someSelected = selected.size > 0 && !allSelected;

  // Results for ids the reload no longer lists - named from the snapshot, so
  // no result is ever silent (spec 4.5). Successes and failures are split
  // because they render with different roles.
  const vanished = useMemo(() => {
    const listed = new Set(pastTours.map((t) => t.tourId));
    const ok: { id: string; tour: Tour }[] = [];
    const failed: { id: string; tour: Tour; message: MarkFailure }[] = [];
    for (const [id, r] of results) {
      const tour = snapshot.get(id);
      if (listed.has(id) || tour === undefined) continue;
      if (r.ok) ok.push({ id, tour });
      else failed.push({ id, tour, message: r.message });
    }
    return { ok, failed };
  }, [results, snapshot, pastTours]);

  const toggleOne = (id: string): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAll = (): void => {
    setSelectedIds(allSelected ? new Set() : new Set(notMarkedIds));
  };

  // The runner: ONE tour at a time, IN LIST ORDER. Per id: re-read the tour
  // (the list is a snapshot, and the server accepts canceled -> toured,
  // no_show -> toured and a reschedule that keeps `scheduled`, so a tour a
  // colleague has since canceled, marked no-show or rebooked must not be
  // flipped, given a false "Tour took place" milestone and stripped of its
  // fresh reminders); PATCH only when the CURRENT status is scheduled AND the
  // current scheduledAt is the one the list showed. The GET is eventually
  // consistent, so the window is one round trip plus replication lag.
  // Sequential on purpose - each PATCH rotates that tour's reminder ladder and
  // writes audit/activity rows; serial keeps those ordered and the per-row
  // result deterministic. Sends ONLY { status: 'toured' } - never an outcome,
  // never closed. Ignores a call while a batch is in flight anywhere in this
  // browser tab.
  const markToured = async (ids: string[]): Promise<void> => {
    if (batchRunning) return;
    const listed = new Map(pastTours.map((t) => [t.tourId, t]));
    const eligible = ids.filter((id) => notMarkedIds.includes(id));
    if (eligible.length === 0) return;
    try {
      setBatchRunning(true);
      setResults(new Map());
      setSnapshot(listed);
      const next = new Map<string, MarkResult>();
      for (const id of eligible) {
        // The guard phase - the re-read AND the status/time comparison - is
        // one try: any throw in it (a failed GET, or an answer whose fields
        // cannot be read) records this row and moves on, so no result is
        // ever silent.
        let unchanged: boolean;
        try {
          const current = await getTour(id);
          unchanged =
            current.status === 'scheduled' && current.scheduledAt === listed.get(id)?.scheduledAt;
        } catch {
          next.set(id, { ok: false, message: 'Could not check the tour' });
          continue;
        }
        if (!unchanged) {
          next.set(id, { ok: false, message: 'Changed since the list loaded' });
          continue;
        }
        try {
          await patchTour(id, { status: 'toured' });
          next.set(id, { ok: true });
        } catch {
          next.set(id, { ok: false, message: 'The update failed' });
        }
      }
      setResults(next);
      setSelectedIds((prev) => {
        const remaining = new Set(prev);
        for (const [id, r] of next) if (r.ok) remaining.delete(id);
        return remaining;
      });
      mountedPastReload?.();
    } finally {
      setBatchRunning(false);
    }
    // The flag's one release point is that finally, reached on every path, so
    // a throw anywhere in the batch cannot leave the tab's Past controls
    // disabled. A hung request still holds the flag until it settles.
    // The refresh goes through the module's mounted-view slot, so it reaches
    // the Past view mounted NOW. After a tab switch, or a route change to a
    // tour page and back, mid-batch that is a remounted view (this closure's
    // own setters above landed on the unmounted instance, a no-op in React
    // 19); with no Past view mounted the call is a no-op and the next mount
    // fetches fresh. The PATCHes already sent stand, and the module-owned flag
    // kept every mark control disabled - in every Past view of this browser
    // tab - and a second batch from starting meanwhile. A full page reload
    // ends the batch (and this loop with it).
  };

  if (pastStatus === 'idle') return <Spinner center />;
  if (pastStatus === 'error') {
    return (
      <p className={styles.error} role="alert">
        We couldn&apos;t load tours. Please try again.
      </p>
    );
  }

  return (
    <section className={styles.section} aria-label="Past tours">
      {reloadFailed ? (
        <p role="alert" className={styles.vanished}>
          Could not refresh the list. Reload the page to see the latest.
        </p>
      ) : null}
      {vanished.ok.length > 0 ? (
        <div role="status" className={styles.vanishedOk}>
          {vanished.ok.map((v) => (
            <p key={v.id}>
              {tenantName(contacts, v.tour.tenantId)} at {propertyLabel(units, v.tour.unitId)} on{' '}
              {whenLabel(v.tour.scheduledAt)}: Marked toured
            </p>
          ))}
        </div>
      ) : null}
      {vanished.failed.length > 0 ? (
        <div role="alert" className={styles.vanished}>
          {vanished.failed.map((f) => (
            <p key={f.id}>
              {tenantName(contacts, f.tour.tenantId)} at {propertyLabel(units, f.tour.unitId)} on{' '}
              {whenLabel(f.tour.scheduledAt)}: {f.message}
            </p>
          ))}
        </div>
      ) : null}
      {pastTours.length === 0 ? (
        <div className={styles.empty}>
          <p className={styles.emptyText}>No past tours need attention in the last 90 days.</p>
        </div>
      ) : (
        <>
          <div className={styles.toolbar}>
            <label className={styles.selectAll}>
              <input
                type="checkbox"
                className={styles.check}
                checked={allSelected}
                ref={(el) => {
                  if (el) el.indeterminate = someSelected;
                }}
                disabled={bulkBusy || notMarkedIds.length === 0}
                onChange={toggleAll}
              />
              Select all not marked
            </label>
            <Button
              size="sm"
              variant="primary"
              type="button"
              disabled={selected.size === 0 || bulkBusy}
              onClick={() => void markToured([...selected])}
            >
              Mark toured ({selected.size})
            </Button>
          </div>
          <ul className={styles.rows} aria-label="Past tours list">
            {pastTours.map((t) => (
              <PastTourRow
                key={t.tourId}
                tour={t}
                contacts={contacts}
                units={units}
                selected={selected.has(t.tourId)}
                onToggle={() => toggleOne(t.tourId)}
                onMarkToured={() => void markToured([t.tourId])}
                busy={bulkBusy}
                result={results.get(t.tourId)}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export type ToursView = 'active' | 'past' | 'closed';

export interface ToursPageProps {
  /** Which URL-backed view: the default active list, the Past tab (spec 4.1),
   *  or the Closed tab. */
  view?: ToursView;
}

/** Active / Past / Closed view tabs. Links to the three routes so the URL is
 *  the source of truth (mirrors the properties list's Active/Deleted tabs). */
const VIEW_TABS: { view: ToursView; label: string; to: string }[] = [
  { view: 'active', label: 'Active', to: '/tours' },
  { view: 'past', label: 'Past', to: '/tours/past' },
  { view: 'closed', label: 'Closed', to: '/tours/closed' },
];

const PAGE_TITLE: Record<ToursView, string> = {
  active: 'Tours',
  past: 'Past tours',
  closed: 'Closed tours',
};

const PAGE_INTRO: Record<ToursView, string> = {
  active: 'Upcoming scheduled tours and unbooked tour requests.',
  past: 'Last 90 days: tours that were never marked toured, toured tours still waiting on an outcome or a placement, and no-shows.',
  closed: 'Tours that ended - converted into a placement, closed as not a fit, or canceled.',
};

/** Router state the Past tab's links carry so the tour page's back arrow
 *  returns here (spec 4.6). */
const BACK_TO_PAST = { back: '/tours/past' } as const;

/** One bulk "Mark toured" result, per tour (spec 4.5). The three messages are
 *  fixed strings - never a raw server code. */
type MarkResult = { ok: true } | { ok: false; message: MarkFailure };
type MarkFailure = 'Could not check the tour' | 'Changed since the list loaded' | 'The update failed';

/** U+202F / U+00A0: the en-US formatters emit one before AM/PM on ICU 72+
 *  hosts (the repo convention, inbox/inboxTime.ts, maps them to U+0020). */
const NBSP_LIKE = /[\u202f\u00a0]/g;

/** The row's "Sep 24, 2026, 2:30 PM" string (also the suffix of every label),
 *  with plain spaces only, so the text and every accessible name read the
 *  same on every host. */
function whenLabel(iso: string | undefined): string {
  return [formatDate(iso), formatTime(iso)]
    .filter((s) => s.length > 0)
    .join(', ')
    .replace(NBSP_LIKE, ' ');
}

export function ToursPage({ view = 'active' }: ToursPageProps): React.JSX.Element {
  const navigate = useNavigate();
  const closed = view === 'closed';
  const past = view === 'past';
  const { status: toursStatus, upcoming, needsBooking } = useTours();
  const { status: contactsStatus, contacts: contactsList } = useContacts('all');
  const { status: unitsStatus, units: unitsList } = useListings();
  // Soft-deleted contacts/units still back rows (closed tours especially) — fetch
  // them too so those rows show real names instead of raw ids.
  const { status: deletedContactsStatus, contacts: deletedContactsList } = useContacts('deleted');
  const { status: deletedUnitsStatus, units: deletedUnitsList } = useListings(true);

  // The "+ New tour" dialog (Active view only) - the SAME Schedule-a-tour form
  // the tenant file opens, here with BOTH sides as free typeaheads (no locked
  // tenant, no pre-committed unit). On create, jump to the new tour.
  const [creating, setCreating] = useState(false);

  // Closed tours are fetched only when the Closed view is showing.
  const { status: closedStatus, closed: closedTours } = useClosedTours(closed);

  const crossRefLoading =
    contactsStatus === 'loading' ||
    unitsStatus === 'loading' ||
    deletedContactsStatus === 'loading' ||
    deletedUnitsStatus === 'loading';
  const crossRefError =
    contactsStatus === 'error' ||
    unitsStatus === 'error' ||
    deletedContactsStatus === 'error' ||
    deletedUnitsStatus === 'error';
  // The Past view waits only for the cross-reference maps here: its child owns
  // its own spinner and error (it mounts once these land, then fetches).
  const loading = closed
    ? closedStatus === 'loading' || closedStatus === 'idle' || crossRefLoading
    : past
      ? crossRefLoading
      : toursStatus === 'loading' || crossRefLoading;
  const error = closed
    ? closedStatus === 'error' || crossRefError
    : past
      ? crossRefError
      : toursStatus === 'error' || crossRefError;

  // Build lookup maps for cross-referencing. Live records are set LAST so a
  // (defensive, shouldn't-happen) id collision resolves to the live record.
  const contactsMap = useMemo(() => {
    const m = new Map<string, Contact>();
    for (const c of deletedContactsList) m.set(c.contactId, c);
    for (const c of contactsList) m.set(c.contactId, c);
    return m;
  }, [contactsList, deletedContactsList]);

  const unitsMap = useMemo(() => {
    const m = new Map<string, UnitItem>();
    for (const u of deletedUnitsList) m.set(u.unitId, u);
    for (const u of unitsList) m.set(u.unitId, u);
    return m;
  }, [unitsList, deletedUnitsList]);

  // Group upcoming tours by local date key, preserving soonest-first order.
  const upcomingGroups = useMemo(() => {
    const today = todayKey();
    const groups: { dateKey: string; label: string; tours: Tour[] }[] = [];
    const byKey = new Map<string, Tour[]>();
    const keyOrder: string[] = [];
    for (const t of upcoming) {
      const key = localDateKey(t.scheduledAt);
      if (!byKey.has(key)) {
        byKey.set(key, []);
        keyOrder.push(key);
      }
      byKey.get(key)!.push(t);
    }
    for (const key of keyOrder) {
      groups.push({ dateKey: key, label: dateGroupLabel(key, today), tours: byKey.get(key)! });
    }
    return groups;
  }, [upcoming]);

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>{PAGE_TITLE[view]}</h1>
        {view === 'active' ? (
          <Button variant="primary" size="sm" type="button" onClick={() => setCreating(true)}>
            + New tour
          </Button>
        ) : null}
      </div>
      <p className={styles.sub}>{PAGE_INTRO[view]}</p>

      <nav className={styles.tabs} aria-label="Tours view">
        {VIEW_TABS.map((t) => (
          <Link
            key={t.view}
            to={t.to}
            className={`${styles.tab} ${t.view === view ? styles.tabActive : ''}`}
            {...(t.view === view && { 'aria-current': 'page' })}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {loading ? <Spinner center /> : null}

      {!loading && error ? (
        <p className={styles.error} role="alert">
          We couldn&apos;t load tours. Please try again.
        </p>
      ) : null}

      {!loading && !error && view === 'active' ? (
        <>
          {/* --- Upcoming section --- */}
          <section className={styles.section} aria-label="Upcoming tours">
            <h2 className={styles.sectionTitle}>Upcoming</h2>
            {upcomingGroups.length === 0 ? (
              <div className={styles.empty}>
                <p className={styles.emptyText}>No tours scheduled in the next 30 days.</p>
              </div>
            ) : (
              upcomingGroups.map((g) => (
                <div key={g.dateKey} className={styles.dateGroup}>
                  <p className={styles.dateLabel}>{g.label}</p>
                  <ul className={styles.rows} aria-label={`Tours on ${g.label}`}>
                    {g.tours.map((t) => (
                      <TourRow
                        key={t.tourId}
                        tour={t}
                        contacts={contactsMap}
                        units={unitsMap}
                        timeDisplay="time"
                      />
                    ))}
                  </ul>
                </div>
              ))
            )}
          </section>

          {/* --- Needs booking section --- */}
          <section className={styles.section} aria-label="Needs booking">
            <h2 className={styles.sectionTitle}>Needs booking</h2>
            {needsBooking.length === 0 ? (
              <div className={styles.empty}>
                <p className={styles.emptyText}>No unbooked tour requests.</p>
              </div>
            ) : (
              <ul className={styles.rows} aria-label="Unbooked tour requests">
                {needsBooking.map((t) => (
                  <TourRow
                    key={t.tourId}
                    tour={t}
                    contacts={contactsMap}
                    units={unitsMap}
                    timeDisplay="none"
                  />
                ))}
              </ul>
            )}
          </section>

        </>
      ) : null}

      {/* --- Past view (/tours/past) - spec 4.3-4.5. The child owns the view's
          selection and results and unmounts on a tab switch; the batch's
          busy flag, in-flight guard and reload slot are module state (one
          batch per browser tab, see the store above PastToursView). --- */}
      {!loading && !error && past ? <PastToursView contacts={contactsMap} units={unitsMap} /> : null}

      {/* --- Closed view (/tours/closed) --- */}
      {!loading && !error && closed ? (
        <section className={styles.section} aria-label="Closed tours">
          {closedTours.length === 0 ? (
            <div className={styles.empty}>
              <p className={styles.emptyText}>No closed or canceled tours yet.</p>
            </div>
          ) : (
            <ul className={styles.rows} aria-label="Closed tours list">
              {closedTours.map((t) => (
                <TourRow
                  key={t.tourId}
                  tour={t}
                  contacts={contactsMap}
                  units={unitsMap}
                  timeDisplay="date"
                />
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {creating ? (
        <ScheduleTourForm
          onClose={() => setCreating(false)}
          onCreated={(t) => {
            setCreating(false);
            void navigate('/tours/' + t.tourId);
          }}
        />
      ) : null}
    </div>
  );
}
