// useTodayPastTours - the Today page's "Past tours needing an outcome" section
// (Sam's item 18, Cameron 2026-09-30). It REUSES the Tours page's Past tab: the
// same loader (usePastTours - the same two reads over the same window) and the
// Past tab's selected rows, minus no-shows (selectTodayPastTours). Nothing here
// decides which tour is "past"; change the Past tab's rule and Today follows.
//
// What it adds for the home page:
// - Names for the rows it shows. The Past tab loads EVERY contact and property
//   to label its rows - too heavy for the landing page - so this point-reads
//   only the tenants and properties of the rows it lists.
// - Soft-deleted tenants are skipped, as on every other Today row (the server
//   queue's rule). The walk continues past them, so the section still fills to
//   the cap. A failed lookup is NOT a deletion: the row stays, labeled by id
//   (the Past tab's fallback).
// - Live refresh: a tour.updated event (a status or outcome PATCH, a
//   conversion) reloads the rows, debounced; names already looked up are
//   reused, and a failed reload keeps the rows and says so (reloadFailed).
// - Failure isolation: a failed load is this section's error, never the page's.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  getContact,
  getUnit,
  useEventStream,
  type Contact,
  type Tour,
  type UnitItem,
} from '../../api/index.js';
import { contactDisplayName, formatAddress } from '../contact/format.js';
import { TODAY_PAST_TOURS_CAP, selectTodayPastTours, usePastTours } from '../tours/useTours.js';

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
  /** Up to TODAY_PAST_TOURS_CAP rows, in the Past tab's order. */
  rows: TodayPastTourRow[];
  /** How many rows the Past tab lists - the "See all N on the Past tab" count,
   *  so the link names what the click lands on. It includes what Today leaves
   *  out (no-shows, a deleted tenant's tours), so it can exceed rows.length
   *  even when Today lists everything it qualifies. */
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

/** Successful lookups, kept for the hook's lifetime so a live reload re-reads
 *  nobody it already named. A failed lookup is never stored: it retries on the
 *  next reload. (A rename or delete shows on the next mount - the Past tab's
 *  own contact list has the same horizon.) */
interface LabelCache {
  contacts: Map<string, Contact>;
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

/** Walk `tours` in order and label the first TODAY_PAST_TOURS_CAP whose tenant
 *  is not soft-deleted. Tenants are read in parallel a batch at a time (one
 *  batch when nobody is deleted); each batch's properties are requested at the
 *  same moment, so labeling costs one round trip, not two. Every lookup is
 *  best-effort: a failure resolves to undefined, so this never rejects (an
 *  aborted pass resolves to [] and is discarded by the caller). */
async function labelRows(tours: Tour[], signal: AbortSignal, cache: LabelCache): Promise<TodayPastTourRow[]> {
  const contactOf = cachedLookup(cache.contacts, getContact, signal);
  const unitOf = cachedLookup(cache.units, getUnit, signal);

  const kept: { tour: Tour; contact: Contact | undefined }[] = [];
  let next = 0;
  while (kept.length < TODAY_PAST_TOURS_CAP && next < tours.length) {
    const batch = tours.slice(next, next + (TODAY_PAST_TOURS_CAP - kept.length));
    next += batch.length;
    // Start the batch's property reads now; a deleted tenant's is wasted, rarely.
    for (const t of batch) void unitOf(t.unitId);
    const found = await Promise.all(batch.map((t) => contactOf(t.tenantId)));
    if (signal.aborted) return [];
    batch.forEach((tour, i) => {
      const contact = found[i];
      if (contact !== undefined && isDeletedContact(contact)) return;
      kept.push({ tour, contact });
    });
  }

  const unitList = await Promise.all(kept.map((k) => unitOf(k.tour.unitId)));
  if (signal.aborted) return [];

  return kept.map(({ tour, contact }, i) => {
    const unit = unitList[i];
    return {
      tour,
      tenant:
        contact !== undefined
          ? contactDisplayName(contact.firstName, contact.lastName, contact.phone)
          : tour.tenantId,
      property: unit !== undefined ? formatAddress(unit.address) || tour.unitId : tour.unitId,
    };
  });
}

export function useTodayPastTours(): TodayPastToursState {
  const { status: pastStatus, past, reload, reloadFailed } = usePastTours(true);
  // `past` is a new array on every load, so this (and the labeling effect)
  // re-runs per load and never on an unrelated render.
  const eligible = useMemo(() => selectTodayPastTours(past), [past]);
  const pastCount = past.length;
  const [labeled, setLabeled] = useState<{ rows: TodayPastTourRow[]; total: number } | null>(null);
  const cacheRef = useRef<LabelCache>({ contacts: new Map(), units: new Map() });

  useEffect(() => {
    if (pastStatus !== 'ready') return;
    const controller = new AbortController();
    // The state write is in the async callback, never synchronous in the
    // effect (react-hooks/set-state-in-effect). A reload keeps the previous
    // rows on screen until this lands.
    void labelRows(eligible, controller.signal, cacheRef.current).then((rows) => {
      if (controller.signal.aborted) return;
      setLabeled({ rows, total: pastCount });
    });
    return () => controller.abort();
  }, [pastStatus, eligible, pastCount]);

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
