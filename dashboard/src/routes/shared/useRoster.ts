// useRoster - the ONE roster fetch the tour and placement hubs share. It serves
// the People card AND the 1:1 tab set, so the card and the tabs can never
// disagree about who is on a tour/placement (contact-rosters goal 4).
//
// LIVE (adjudication A14): neither hub page subscribes to `conversation.updated`
// at page level today - that subscription is private to the channel hooks. So
// this hook subscribes for ITSELF:
//   - tours      -> { onConversationUpdated, onTourUpdated }
//   - placements -> { onConversationUpdated, onPlacementUpdated }
// and refetches on a match. `conversation.updated` is matched against OUR OWN
// group thread: once a thread exists its participants ARE the roster (spec D1),
// so a member added or removed on that thread changes this payload and nothing
// else's event should cost us a fetch.
//
// The thread pointer is part of WHICH roster we are asking for: opening a group
// flips the source from plan/default to `participants`. It therefore rides the
// committed state's key, exactly like useTour's `forId` - a moved pointer reads
// as "loading the new answer", never as stale-but-confident data.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getPlacementRoster,
  getTourRoster,
  useEventStream,
  type ConversationUpdatedEvent,
  type PlacementUpdatedEvent,
  type RosterView,
  type TourUpdatedEvent,
} from '../../api/index.js';

/** WHICH roster to fetch. `threadId` is the owner's group-thread pointer
 *  (tour.groupThreadId / placement.group_thread) when it has one. */
export interface RosterOwnerRef {
  type: 'tour' | 'placement';
  id: string;
  threadId?: string;
}

export interface RosterState {
  status: 'loading' | 'ready' | 'error';
  /** The payload, or null while loading / after a failure. */
  roster: RosterView | null;
  /** Re-run the fetch (the card's Retry control). */
  refetch: () => void;
}

/** Debounce window (ms) for SSE-triggered refetches - coalesces a burst of
 *  member events into ONE re-read. Mirrors the channel hooks' window. */
const REFETCH_DEBOUNCE_MS = 300;

interface Committed {
  status: RosterState['status'];
  roster: RosterView | null;
  /** Which owner+pointer the committed state describes. */
  forKey: string;
}

export function useRoster(owner: RosterOwnerRef): RosterState {
  const { type, id } = owner;
  const threadId = owner.threadId;
  const forKey = `${type}#${id}#${threadId ?? ''}`;
  const [state, setState] = useState<Committed>({ status: 'loading', roster: null, forKey });

  // Track the in-flight fetch so a refetch (SSE-driven, pointer change, or the
  // Retry button) supersedes the previous one and a late response cannot
  // clobber fresher state.
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;
    try {
      const roster =
        type === 'tour' ? await getTourRoster(id, signal) : await getPlacementRoster(id, signal);
      if (signal.aborted) return;
      setState({ status: 'ready', roster, forKey });
    } catch (err) {
      if (signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
      setState({ status: 'error', roster: null, forKey });
    }
  }, [type, id, forKey]);

  useEffect(() => {
    // load sets state only after an await (never synchronously) - a fetch-on-mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    return () => abortRef.current?.abort();
  }, [load]);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      if (debounceRef.current !== undefined) clearTimeout(debounceRef.current);
    },
    [],
  );
  const scheduleRefetch = useCallback(() => {
    if (debounceRef.current !== undefined) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = undefined;
      void load();
    }, REFETCH_DEBOUNCE_MS);
  }, [load]);

  const onConversationUpdated = useCallback(
    (ev: ConversationUpdatedEvent) => {
      if (threadId !== undefined && ev.conversationId === threadId) scheduleRefetch();
    },
    [threadId, scheduleRefetch],
  );
  const onTourUpdated = useCallback(
    (ev: TourUpdatedEvent) => {
      if (ev.tourId === id) scheduleRefetch();
    },
    [id, scheduleRefetch],
  );
  const onPlacementUpdated = useCallback(
    (ev: PlacementUpdatedEvent) => {
      if (ev.placementId === id) scheduleRefetch();
    },
    [id, scheduleRefetch],
  );
  useEventStream({
    onConversationUpdated,
    ...(type === 'tour' ? { onTourUpdated } : { onPlacementUpdated }),
  });

  const refetch = useCallback(() => void load(), [load]);

  // Committed state describes a DIFFERENT owner/pointer -> the new fetch is in
  // flight; report loading rather than the previous answer.
  const stale = state.forKey !== forKey;
  return useMemo(
    () => ({
      status: stale ? ('loading' as const) : state.status,
      roster: stale ? null : state.roster,
      refetch,
    }),
    [stale, state.status, state.roster, refetch],
  );
}
