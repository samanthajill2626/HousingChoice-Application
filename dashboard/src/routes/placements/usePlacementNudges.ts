// usePlacementNudges - the ONE nudge-ladder fetch for a placement, shared by the
// placement hub's Now card (safety-net line) and Deadlines and nudges card. The
// spec's "do not fetch twice" rule: PlacementDetail calls this once and passes
// the result DOWN to both cards, rather than each card self-fetching.
//
// Lifted verbatim from the DeadlinesNudgesCard's own fetch (Task 8): the aborted
// in-flight guard (a late response can't clobber fresher data), the dueAt-anchored
// self-refetch timer (nudge sends happen in the WORKER process whose events never
// reach app SSE clients - the RemindersPanel nextReminderRefetchDelay pattern), the
// scheduled.updated live refetch, and the busyId single-flight cancel/restore.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getPlacementNudges,
  patchPlacementNudge,
  useEventStream,
  ApiError,
  type PlacementNudgeView,
} from '../../api/index.js';
import { nextReminderRefetchDelay } from '../tours/RemindersPanel.js';

/** The last LANDED fetch: the ladder + which placementId it describes (loading is
 *  derived when it doesn't match - the RemindersPanel pattern, no setState in the
 *  effect body). */
interface Committed {
  nudges: PlacementNudgeView[];
  error: string | null;
  /** Which placementId this state describes. */
  forId: string;
  /** False until the first fetch for forId lands. */
  loaded: boolean;
}

export interface PlacementNudges {
  /** The current ladder (the prior one stays up during a refetch - no flash). */
  nudges: PlacementNudgeView[];
  /** True until the first fetch for the current placementId lands. */
  loading: boolean;
  error: string | null;
  /** The single in-flight cancel/restore, or null. */
  busyId: string | null;
  /** Force a refetch (used by the follow-up modal's parent after a write). */
  refetch: () => void;
  /** Cancel (upcoming) / restore (canceled) one rung, then refetch the honest
   *  ladder. A 409 (lost race / already sent) resolves silently via the refetch. */
  toggleCanceled: (nudge: PlacementNudgeView) => void;
}

export function usePlacementNudges(placementId: string): PlacementNudges {
  const [state, setState] = useState<Committed>({
    nudges: [],
    error: null,
    forId: placementId,
    loaded: false,
  });

  // Track the in-flight request so a refetch (SSE-driven or placementId change)
  // supersedes the previous one and a late response can't clobber fresher data.
  const abortRef = useRef<AbortController | null>(null);
  // The dueAt-anchored self-refetch timer (see the worker-fire liveness note).
  const anchorRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchNow = useCallback(() => {
    if (!placementId) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    getPlacementNudges(placementId, controller.signal)
      .then((nudges) => {
        if (controller.signal.aborted) return;
        setState({ nudges, error: null, forId: placementId, loaded: true });
      })
      .catch((err: unknown) => {
        if (
          controller.signal.aborted ||
          (err instanceof DOMException && err.name === 'AbortError')
        ) {
          return;
        }
        setState({
          nudges: [],
          error: err instanceof ApiError ? err.message : 'Failed to load nudges',
          forId: placementId,
          loaded: true,
        });
      });
  }, [placementId]);

  useEffect(() => {
    fetchNow();
    return () => abortRef.current?.abort();
  }, [fetchNow]);

  // Re-anchor the self-refetch timer on every landed ladder: fire just after the
  // next upcoming rung's dueAt (then short re-checks while the worker's poll
  // catches up). Runs off COMMITTED state so each refetch reschedules itself;
  // cleared on placementId change/unmount. REUSES the RemindersPanel delay math.
  useEffect(() => {
    if (anchorRef.current !== null) clearTimeout(anchorRef.current);
    anchorRef.current = null;
    if (state.forId !== placementId || !state.loaded) return undefined;
    const delay = nextReminderRefetchDelay(state.nudges, Date.now());
    if (delay === null) return undefined;
    anchorRef.current = setTimeout(fetchNow, delay);
    return () => {
      if (anchorRef.current !== null) clearTimeout(anchorRef.current);
      anchorRef.current = null;
    };
  }, [state, placementId, fetchNow]);

  // Live: refetch when a nudge ladder changes anywhere (scheduled.updated carries
  // no placementId to filter on). Refetches are QUIET: the prior ladder stays up
  // until the fresh one lands - no loading flash.
  const onScheduledUpdated = useCallback(() => fetchNow(), [fetchNow]);
  useEventStream({ onScheduledUpdated });

  // Cancel/restore one rung: PATCH, then refetch for the honest ladder. A 409
  // means the transition lost a race (the rung fired/was claimed between render
  // and click) - the refetch shows the real state, no error banner. One in-flight
  // action at a time (busyId) so a double-click can't fire two PATCHes.
  const [busyId, setBusyId] = useState<string | null>(null);
  const toggleCanceled = useCallback(
    (nudge: PlacementNudgeView) => {
      if (busyId !== null) return;
      setBusyId(nudge.nudgeId);
      patchPlacementNudge(placementId, nudge.nudgeId, nudge.state === 'upcoming')
        .catch(() => {
          /* 409 race / transient - the refetch below reports the honest state */
        })
        .finally(() => {
          setBusyId(null);
          fetchNow();
        });
    },
    [busyId, placementId, fetchNow],
  );

  return {
    nudges: state.nudges,
    loading: state.forId !== placementId || !state.loaded,
    error: state.error,
    busyId,
    refetch: fetchNow,
    toggleCanceled,
  };
}
