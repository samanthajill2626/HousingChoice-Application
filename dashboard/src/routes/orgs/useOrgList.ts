// useOrgList - the stored organization lists for a picker or the Settings tab
// (plan 3.11; spec D1: no client cache either - every mount reads GET
// /api/organizations once). The status flavor of the useSettings idiom: a
// picker must KNOW the list failed to load, because it cannot offer names then
// (spec R2 ruling 6). A reload keeps the current data until the answer lands.
// noteAdded(): a name "Is this really new?" just added - or one it answered
// with ("Use X", "Put it in Agency": a name added or renamed since this list
// was read, code review R1-ADV-FE-7) - is counted at once, so its chip never
// says "Not on the list" while the re-read is in flight.
// poll(): a timer's re-read, SKIPPED while a read is in flight - reload()
// aborts the read in flight to start afresh, which on a timer meant a read
// slower than the timer never landed (code review R1-ADV-FE-5). Skipped only
// for POLL_TICKS_PER_READ ticks: a read still in flight then is given up on -
// aborted and started afresh - so one read that never settles (a hung request)
// cannot stop the polling for good (code review R2-FE-5).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getOrgList, type OrgEntry, type OrgRef, type OrgRewriteState } from '../../api/index.js';

/** How many poll ticks a read may stay in flight before a tick restarts it -
 *  about 5 x the poller's cadence (10 s at the Settings tab's 2 s). */
export const POLL_TICKS_PER_READ = 5;

export interface OrgListState {
  entries: OrgEntry[];
  /** The stored item's version; null until the first read succeeds. */
  version: number | null;
  lastRewrite: OrgRewriteState | undefined;
  /** True until the first read settles. */
  loading: boolean;
  /** True when the latest read failed. */
  error: boolean;
  /** Re-read the list (after an add or an action): a read in flight is aborted. */
  reload: () => void;
  /** A timer's re-read (while a rewrite runs): skipped while a read is in
   *  flight, so the poll never aborts a slow read - unless that read is still
   *  in flight POLL_TICKS_PER_READ ticks on: then it is aborted and restarted. */
  poll: () => void;
  /** "Yes, add it" just added `entry` (spec D6), or "Is this really new?"
   *  answered with it (R1-ADV-FE-7: a bare OrgRef): it counts as on the list
   *  AT ONCE - its chip never flashes "Not on the list" - and stays counted
   *  until a read returns it; the list is re-read. */
  noteAdded: (entry: OrgRef) => void;
}

/** A name the server just confirmed, as a list entry until a read returns
 *  the server's copy: an added entry is kept whole; a bare ref (a "Use"
 *  answer) has no spellings yet. */
function provisional(ref: OrgRef): OrgEntry {
  return { spellings: [], createdAt: '', createdBy: '', updatedAt: '', updatedBy: '', ...ref };
}

interface Loaded {
  entries: OrgEntry[];
  version: number | null;
  lastRewrite: OrgRewriteState | undefined;
}

const EMPTY: Loaded = { entries: [], version: null, lastRewrite: undefined };

export function useOrgList(): OrgListState {
  const [data, setData] = useState<Loaded>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  /** Entries this mount just added, counted until a read returns them. */
  const [added, setAdded] = useState<OrgEntry[]>([]);
  /** The read in flight, null once it settles. */
  const abortRef = useRef<AbortController | null>(null);
  /** Poll ticks the read in flight has outlived (a tick, not a clock: the
   *  cadence is the poller's, and a browser clock can be skewed or frozen). */
  const ticksRef = useRef(0);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    ticksRef.current = 0;
    try {
      const res = await getOrgList(controller.signal);
      if (controller.signal.aborted) return;
      setData({ entries: res.entries, version: res.version, lastRewrite: res.lastRewrite });
      // The server's copy of a just-added entry takes over from ours.
      setAdded((prev) => prev.filter((a) => !res.entries.some((e) => e.orgId === a.orgId)));
      setError(false);
      setLoading(false);
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
      setError(true);
      setLoading(false);
    } finally {
      // Settled: release the slot - unless a newer read already holds it
      // (a reload, or StrictMode's second mount, started one meanwhile).
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, []);

  useEffect(() => {
    // load() sets state only AFTER an await (never synchronously) - a
    // fetch-on-mount, not the cascading-render case the rule targets (the
    // useContactTimeline.ts precedent).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    return () => abortRef.current?.abort();
  }, [load]);

  const reload = useCallback(() => {
    void load();
  }, [load]);

  const poll = useCallback(() => {
    if (abortRef.current !== null) {
      // The previous read has not landed yet: let it, for a while (R1-ADV-FE-5)...
      ticksRef.current += 1;
      if (ticksRef.current < POLL_TICKS_PER_READ) return;
      // ...but not forever: load() aborts it and starts afresh (R2-FE-5).
    }
    void load();
  }, [load]);

  const noteAdded = useCallback(
    (entry: OrgRef) => {
      setAdded((prev) => (prev.some((e) => e.orgId === entry.orgId) ? prev : [...prev, provisional(entry)]));
      void load();
    },
    [load],
  );

  const entries = useMemo(
    () => [...data.entries, ...added.filter((a) => !data.entries.some((e) => e.orgId === a.orgId))],
    [data.entries, added],
  );

  return { ...data, entries, loading, error, reload, poll, noteAdded };
}
