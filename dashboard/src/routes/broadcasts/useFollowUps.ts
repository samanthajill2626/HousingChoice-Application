// useFollowUps - the Follow up tab's data (last-heard-from spec 5.6, 14.4).
// Fetched ONCE when Matching mounts, whatever tab is active (the tab label
// carries the count), and handed to FollowUpView as props.
// THE RULE (plan review R1 #4): an actioned row shows its new state IN PLACE
// for the session - `resolve` marks it interested / not interested (the row
// stays listed, the counts drop at once), `unresolve` puts it back (Undo) -
// and it leaves the list on the NEXT load, because the server no longer
// serves it. No action refetches. Every completed load REPLACES the session's
// resolutions with the server's truth. Loading is DERIVED (a stale load reads
// as loading) so no effect sets state synchronously.
import { useCallback, useEffect, useState } from 'react';
import { getFollowUps, type FollowUpItem, type TourSignal } from '../../api/index.js';

export type FollowUpsStatus = 'loading' | 'ready' | 'error';

export type FollowUpResolution = { kind: 'interested'; tour?: TourSignal } | { kind: 'not_interested' };

export interface FollowUpsState {
  status: FollowUpsStatus;
  items: FollowUpItem[];
  truncated: boolean;
  /** Rows still waiting: the served items minus the ones resolved here. */
  waitingCount: number;
  /** This session's actions, by followUpKey - the rows shown in place. */
  resolutions: ReadonlyMap<string, FollowUpResolution>;
  resolve: (item: FollowUpItem, resolution: FollowUpResolution) => void;
  unresolve: (item: FollowUpItem) => void;
  /** A new load; when it completes it replaces `items` AND clears `resolutions`. */
  retry: () => void;
}

export function followUpKey(item: Pick<FollowUpItem, 'unitId' | 'contactId'>): string {
  return `${item.unitId}|${item.contactId}`;
}

const NO_ITEMS: FollowUpItem[] = [];

interface Loaded {
  status: 'ready' | 'error';
  items: FollowUpItem[];
  truncated: boolean;
  forLoad: number;
}

export function useFollowUps(): FollowUpsState {
  const [load, setLoad] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [resolutions, setResolutions] = useState<ReadonlyMap<string, FollowUpResolution>>(() => new Map());

  useEffect(() => {
    const controller = new AbortController();
    getFollowUps(controller.signal)
      .then((res) => {
        if (controller.signal.aborted) return;
        setLoaded({ status: 'ready', items: res.items, truncated: res.truncated, forLoad: load });
        // The next load is the server's truth: actioned rows are gone from it.
        setResolutions(new Map());
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
        setLoaded({ status: 'error', items: NO_ITEMS, truncated: false, forLoad: load });
      });
    return () => controller.abort();
  }, [load]);

  const resolve = useCallback((item: FollowUpItem, resolution: FollowUpResolution) => {
    setResolutions((prev) => new Map(prev).set(followUpKey(item), resolution));
  }, []);
  const unresolve = useCallback((item: FollowUpItem) => {
    setResolutions((prev) => {
      const next = new Map(prev);
      next.delete(followUpKey(item));
      return next;
    });
  }, []);
  const retry = useCallback(() => setLoad((n) => n + 1), []);

  const current = loaded !== null && loaded.forLoad === load ? loaded : null;
  const items = current?.items ?? NO_ITEMS;
  const waitingCount = items.filter((i) => !resolutions.has(followUpKey(i))).length;
  return {
    status: current === null ? 'loading' : current.status,
    items,
    truncated: current?.truncated ?? false,
    waitingCount,
    resolutions,
    resolve,
    unresolve,
    retry,
  };
}
