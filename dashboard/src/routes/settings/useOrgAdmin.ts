// useOrgAdmin - everything Settings > Housing authorities & agencies shows
// (spec 2026-10-06 D10, D11): the lists and the latest rewrite (useOrgList),
// the use counts and the "Not on the list" rows, all read on mount. While the
// latest rewrite RUNS with a fresh heartbeat, ONLY the lists are re-read every
// `pollMs` (2 s - the useBroadcastResults precedent, R5 ruling): one GetItem,
// whose lastRewrite is the status line. The counts and the rows are each a
// FULL pass over every contact and unit, so they are read on mount, after an
// action (reload) and ONCE when the rewrite stops - the read that saw it stop
// may have raced its last record writes. A details read in flight is never
// aborted to start another (the server would finish the scan anyway): a
// request made meanwhile runs once, after it lands. A stalled rewrite
// (heartbeat 15 min old) is not polled; the section offers "Run again" for it.
// The heartbeat is a SERVER stamp that the server's lock judges on its own
// clock, so it is judged on serverNowMs() here too - never on a skewed
// browser clock (code review R1-ADV-FE-4; api/serverClock.ts).
import { useCallback, useEffect, useRef, useState } from 'react';
import { getNotOnList, getOrgUsage, type NotOnListRow, type OrgUsage } from '../../api/index.js';
import { serverNowMs } from '../../api/serverClock.js';
import { isRewriteLive } from '../orgs/orgCopy.js';
import { useOrgList, type OrgListState } from '../orgs/useOrgList.js';

/** The R5 ruling's cadence while a rewrite runs. */
export const ORG_ADMIN_POLL_MS = 2000;

export interface OrgAdminState {
  list: OrgListState;
  /** Records holding each entry's exact name, by orgId; null until read. */
  usage: OrgUsage | null;
  usageError: boolean;
  /** The "Not on the list" rows; null until read. */
  notOnList: NotOnListRow[] | null;
  notOnListError: boolean;
  /** True while the latest rewrite runs with a fresh heartbeat. */
  rewriteLive: boolean;
  /** Re-read the lists, the counts and the rows (after any action). */
  reload: () => void;
}

export function useOrgAdmin(options: { pollMs?: number } = {}): OrgAdminState {
  const pollMs = options.pollMs ?? ORG_ADMIN_POLL_MS;
  const list = useOrgList();
  const [usage, setUsage] = useState<OrgUsage | null>(null);
  const [usageError, setUsageError] = useState(false);
  const [notOnList, setNotOnList] = useState<NotOnListRow[] | null>(null);
  const [notOnListError, setNotOnListError] = useState(false);
  /** The details read in flight - aborted (and released) only by the mount
   *  effect's cleanup, never to start another. */
  const inFlightRef = useRef<AbortController | null>(null);
  /** A details read was asked for while one ran: run ONE more after it lands. */
  const againRef = useRef(false);

  const loadDetails = useCallback(async () => {
    if (inFlightRef.current !== null) {
      againRef.current = true;
      return;
    }
    do {
      againRef.current = false;
      const controller = new AbortController();
      inFlightRef.current = controller;
      const [counts, rows] = await Promise.allSettled([
        getOrgUsage(controller.signal),
        getNotOnList(controller.signal),
      ]);
      // Release the slot only while it is still this read's: the cleanup
      // releases it itself (an unmount, or StrictMode's mount-cleanup-mount in
      // development and in every e2e lane), and the next mount's read may
      // already hold it.
      if (inFlightRef.current === controller) inFlightRef.current = null;
      if (controller.signal.aborted) return; // unmounted
      if (counts.status === 'fulfilled') {
        setUsage(counts.value);
        setUsageError(false);
      } else {
        setUsageError(true);
      }
      if (rows.status === 'fulfilled') {
        setNotOnList(rows.value);
        setNotOnListError(false);
      } else {
        setNotOnListError(true);
      }
    } while (againRef.current);
  }, []);

  useEffect(() => {
    // loadDetails() sets state only AFTER an await (never synchronously) - a
    // fetch-on-mount, not the cascading-render case the rule targets (the
    // useContactTimeline.ts precedent).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadDetails();
    return () => {
      // Abort AND release: under StrictMode the effect runs again at once, and
      // that read must START, not queue behind the aborted one (a queued
      // request never survives an aborted read).
      inFlightRef.current?.abort();
      inFlightRef.current = null;
      againRef.current = false;
    };
  }, [loadDetails]);

  const reloadList = list.reload;
  const reload = useCallback(() => {
    reloadList();
    void loadDetails();
  }, [reloadList, loadDetails]);

  // Keyed on liveness only: a steady cadence while it runs, torn down the
  // moment the rewrite finishes, fails or goes stale (and on unmount). It
  // re-reads ONLY the lists - the counts and rows wait for the rewrite to stop.
  const rewriteLive = isRewriteLive(list.lastRewrite, serverNowMs());
  useEffect(() => {
    if (!rewriteLive) return undefined;
    const id = setInterval(reloadList, pollMs);
    return () => clearInterval(id);
  }, [rewriteLive, reloadList, pollMs]);

  // The rewrite just stopped (done, failed or stalled): read the counts and
  // the rows ONCE.
  const wasLiveRef = useRef(false);
  useEffect(() => {
    if (wasLiveRef.current && !rewriteLive) {
      // loadDetails() sets state only AFTER an await (never synchronously) - a
      // refetch, not the cascading-render case the rule targets.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void loadDetails();
    }
    wasLiveRef.current = rewriteLive;
  }, [rewriteLive, loadDetails]);

  return { list, usage, usageError, notOnList, notOnListError, rewriteLive, reload };
}
