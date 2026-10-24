// useTodayPastTours - the Today page's "Past tours needing an outcome" section
// (Sam's item 18, Cameron 2026-09-30; ordered and labeled per spec
// 2026-10-23-today-checklist-design 5.3). It REUSES the Tours page's Past tab:
// the same loader (usePastTours - the same two reads over the same window) and
// the Past tab's selected rows, no-shows included - a no-show closes on its
// own two weeks after its last mark (tour spec 9.4). Nothing here decides
// which tour is "past"; change the Past tab's rule and Today follows.
//
// What it adds for the home page:
// - Names for EVERY Past row, so "Show all N" counts the rows Today actually
//   qualifies (spec 5.3; the page shows the first 5; no heading count). The
//   Past tab loads every contact and property to label its rows - too heavy
//   for the landing page - so this point-reads only the listed tenants and
//   properties, all at once (one round trip).
// - Soft-deleted tenants are skipped, as on every other Today row (the server
//   queue's rule). A failed lookup is NOT a deletion: the row stays, labeled
//   by id (the Past tab's fallback).
// - Today's order (spec 5.3): the range read's rows OLDEST scheduledAt first
//   (ties by tourId), so the oldest tours do not wait for the two-week
//   auto-close; then the off-range rows (undated, or dated after today) in
//   the loader's own order, last. The split is the Past tab's own rule
//   (isOffRangePastTour). The Past tab's order is unchanged.
// - Live refresh: a tour.updated event (a status or outcome PATCH, a
//   conversion, the auto-close sweep, a reopen, a create) reloads the rows,
//   debounced; addresses already looked up are reused (tenants are re-read,
//   for their delete state), and a failed reload keeps the rows and says so
//   (reloadFailed).
// - Failure isolation: a failed load is this section's error, never the page's.
import { useEffect, useRef, useState } from 'react';
import {
  getContact,
  getUnit,
  useEventStream,
  type Contact,
  type Tour,
  type UnitItem,
} from '../../api/index.js';
import { contactDisplayName, formatAddress } from '../contact/format.js';
import { isOffRangePastTour, usePastTours } from '../tours/useTours.js';

export interface TodayPastTourRow {
  tour: Tour;
  /** The tenant's display name; the tenantId when the lookup failed. */
  tenant: string;
  /** The property's address; the unitId when the lookup failed. */
  property: string;
}

export interface TodayPastToursState {
  /** 'idle' until the first rows are ready, names included (the section stays
   *  hidden meanwhile); 'error' only when the first load failed - a failed
   *  reload keeps the rows on screen. */
  status: 'idle' | 'ready' | 'error';
  /** Every Past row whose tenant is not soft-deleted, labeled, in Today's
   *  order (orderForToday). The page shows the first 5 with Show all. */
  rows: TodayPastTourRow[];
  /** How many rows the Past tab lists - the "See all N on the Past tab" count,
   *  so the link names what the click lands on. It includes what Today leaves
   *  out (a deleted tenant's tours), so it can exceed rows.length. */
  total: number;
  /** The last live reload failed; the rows on screen may be stale (the Past
   *  tab's reloadFailed, passed through). Never true unless status is ready. */
  reloadFailed: boolean;
}

/** Debounce window (ms) for tour.updated reloads - coalesces a burst (a bulk
 *  Mark toured in another tab) into one reload. */
const RELOAD_DEBOUNCE_MS = 300;

function isDeletedContact(c: Contact): boolean {
  return typeof c.deleted_at === 'string' && c.deleted_at.length > 0;
}

/** Successful PROPERTY lookups, kept for the hook's lifetime so a live reload
 *  re-reads no property it already named (a failed lookup is never stored: it
 *  retries on the next reload). Tenants are deliberately NOT kept: on Today a
 *  tenant's soft-delete decides whether the row shows at all, so every pass
 *  re-reads the listed tenants and a delete made in another tab takes effect on
 *  the next reload rather than the next mount (review R3-2). */
interface LabelCache {
  units: Map<string, UnitItem>;
}

/** One lookup per id per pass, answered from `cache` when it can be. */
function cachedLookup<T>(
  cache: Map<string, T>,
  fetchOne: (id: string, signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
): (id: string) => Promise<T | undefined> {
  const inPass = new Map<string, Promise<T | undefined>>();
  return (id) => {
    const hit = cache.get(id);
    if (hit !== undefined) return Promise.resolve(hit);
    let p = inPass.get(id);
    if (p === undefined) {
      p = fetchOne(id, signal).then(
        (value) => {
          cache.set(id, value);
          return value;
        },
        () => undefined,
      );
      inPass.set(id, p);
    }
    return p;
  };
}

/** Label every Past row whose tenant is not soft-deleted, keeping the given
 *  order. Every tenant and property read starts at once (the property reads
 *  beside the tenant reads, so labeling costs one round trip; a deleted
 *  tenant's property read is wasted, rarely). Every lookup is best-effort: a
 *  failure resolves to undefined, so this never rejects (an aborted pass
 *  resolves to [] and is discarded by the caller). */
async function labelRows(tours: Tour[], signal: AbortSignal, cache: LabelCache): Promise<TodayPastTourRow[]> {
  // A fresh map per pass: tenants are only de-duplicated within this pass.
  const contactOf = cachedLookup(new Map<string, Contact>(), getContact, signal);
  const unitOf = cachedLookup(cache.units, getUnit, signal);

  const unitsPending = Promise.all(tours.map((t) => unitOf(t.unitId)));
  const contacts = await Promise.all(tours.map((t) => contactOf(t.tenantId)));
  const units = await unitsPending;
  if (signal.aborted) return [];

  const rows: TodayPastTourRow[] = [];
  tours.forEach((tour, i) => {
    const contact = contacts[i];
    if (contact !== undefined && isDeletedContact(contact)) return;
    const unit = units[i];
    rows.push({
      tour,
      tenant:
        contact !== undefined
          ? contactDisplayName(contact.firstName, contact.lastName, contact.phone)
          : tour.tenantId,
      property: unit !== undefined ? formatAddress(unit.address) || tour.unitId : tour.unitId,
    });
  });
  return rows;
}

/** Today's order for the labeled Past rows (spec 5.3): the in-range rows (the
 *  range read's) by OLDEST scheduledAt first, ties by tourId; then the
 *  off-range rows (isOffRangePastTour - the Past tab's own split) in the order
 *  given, last. Pure; never mutates its input. */
export function orderForToday(rows: readonly TodayPastTourRow[], now: Date = new Date()): TodayPastTourRow[] {
  const inRange = rows.filter((r) => !isOffRangePastTour(r.tour, now));
  const offRange = rows.filter((r) => isOffRangePastTour(r.tour, now));
  inRange.sort((a, b) => {
    const aAt = a.tour.scheduledAt ?? '';
    const bAt = b.tour.scheduledAt ?? '';
    if (aAt !== bAt) return aAt < bAt ? -1 : 1;
    return a.tour.tourId < b.tour.tourId ? -1 : a.tour.tourId > b.tour.tourId ? 1 : 0;
  });
  return [...inRange, ...offRange];
}

export function useTodayPastTours(): TodayPastToursState {
  const { status: pastStatus, past, reload, reloadFailed } = usePastTours(true);
  // Today lists the Past rows themselves (no-shows included, spec 9.4). `past`
  // is a new array on every load, so the labeling effect re-runs per load and
  // never on an unrelated render.
  const pastCount = past.length;
  const [labeled, setLabeled] = useState<{ rows: TodayPastTourRow[]; total: number } | null>(null);
  const cacheRef = useRef<LabelCache>({ units: new Map() });

  useEffect(() => {
    if (pastStatus !== 'ready') return;
    const controller = new AbortController();
    // The state write is in the async callback, never synchronous in the
    // effect (react-hooks/set-state-in-effect). A reload keeps the previous
    // rows on screen until this lands.
    void labelRows(past, controller.signal, cacheRef.current).then((rows) => {
      if (controller.signal.aborted) return;
      setLabeled({ rows: orderForToday(rows, new Date()), total: pastCount });
    });
    return () => controller.abort();
  }, [pastStatus, past, pastCount]);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      if (debounceRef.current !== undefined) clearTimeout(debounceRef.current);
    },
    [],
  );
  useEventStream({
    onTourUpdated: () => {
      if (debounceRef.current !== undefined) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = undefined;
        reload();
      }, RELOAD_DEBOUNCE_MS);
    },
  });

  if (pastStatus === 'error') return { status: 'error', rows: [], total: 0, reloadFailed: false };
  if (labeled === null) return { status: 'idle', rows: [], total: 0, reloadFailed: false };
  return { status: 'ready', rows: labeled.rows, total: labeled.total, reloadFailed };
}
