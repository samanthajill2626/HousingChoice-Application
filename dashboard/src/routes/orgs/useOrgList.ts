// useOrgList - the stored organization lists for a picker or the Settings tab
// (plan 3.11; spec D1: no client cache either - every mount reads GET
// /api/organizations once). The status flavor of the useSettings idiom: a
// picker must KNOW the list failed to load, because it cannot offer names then
// (spec R2 ruling 6). A reload keeps the current data until the answer lands.
// noteAdded(): a name "Is this really new?" just added is counted at once, so
// its chip never flashes "Not on the list" while the re-read is in flight.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getOrgList, type OrgEntry, type OrgRewriteState } from '../../api/index.js';

export interface OrgListState {
  entries: OrgEntry[];
  /** The stored item's version; null until the first read succeeds. */
  version: number | null;
  lastRewrite: OrgRewriteState | undefined;
  /** True until the first read settles. */
  loading: boolean;
  /** True when the latest read failed. */
  error: boolean;
  /** Re-read the list (after an add, or while a rewrite runs). */
  reload: () => void;
  /** "Yes, add it" just added `entry` (spec D6): it counts as on the list AT
   *  ONCE - its chip never flashes "Not on the list" - and stays counted until
   *  a read returns it; the list is re-read. */
  noteAdded: (entry: OrgEntry) => void;
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
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
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

  const noteAdded = useCallback(
    (entry: OrgEntry) => {
      setAdded((prev) => (prev.some((e) => e.orgId === entry.orgId) ? prev : [...prev, entry]));
      void load();
    },
    [load],
  );

  const entries = useMemo(
    () => [...data.entries, ...added.filter((a) => !data.entries.some((e) => e.orgId === a.orgId))],
    [data.entries, added],
  );

  return { ...data, entries, loading, error, reload, noteAdded };
}
