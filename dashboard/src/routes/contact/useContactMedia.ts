// useContactMedia - the contact file's "Media from comms" gallery feed
// (2026-08-18).
//
// Reads GET /api/contacts/:id/media, the media pointer INDEX, one newest-first
// page at a time; `loadMore` walks older media by cursor with no horizon. It
// replaces deriving the gallery from the loaded timeline page, which silently
// hid any attachment older than that page (and, before it, a server-side scan
// of the newest 200 messages per thread with the same flaw).
//
// LIVE like the timeline: on SSE message.persisted / conversation.updated the
// FIRST page is refetched (debounced) and merged by item key over what is
// already shown, so a just-mirrored MMS appears without a reload and a "load
// more" walk in progress is not thrown away.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getContactMedia, useEventStream, type ContactMediaItem } from '../../api/index.js';
import { toCommsMediaItem, type CommsMediaItem } from './media.js';

const REFETCH_DEBOUNCE_MS = 300;
export const MEDIA_PAGE_SIZE = 60;

export interface ContactMediaState {
  status: 'loading' | 'ready' | 'error';
  items: CommsMediaItem[];
  /** True while older media exists past what is loaded. */
  hasMore: boolean;
  /** True while a loadMore page is in flight. */
  loadingMore: boolean;
  loadMore: () => void;
}

interface Loaded {
  forId: string;
  items: ContactMediaItem[];
  nextCursor: string | undefined;
}

/** Merge a fresh first page over what is loaded, by identity (sid:index), keeping newest-first. */
function mergeFirstPage(prev: ContactMediaItem[], fresh: ContactMediaItem[]): ContactMediaItem[] {
  const seen = new Set(fresh.map((m) => `${m.providerSid}:${m.index}`));
  const older = prev.filter((m) => !seen.has(`${m.providerSid}:${m.index}`));
  return [...fresh, ...older].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

export function useContactMedia(contactId: string): ContactMediaState {
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; loaded: Loaded | undefined }>({
    status: 'loading',
    loaded: undefined,
  });
  const [loadingMore, setLoadingMore] = useState(false);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const moreAbortRef = useRef<AbortController | undefined>(undefined);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  /** Fetch the FIRST page; on a refetch, merge over what is shown rather than replace. */
  const fetchFirst = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const page = await getContactMedia(contactId, { limit: MEDIA_PAGE_SIZE }, controller.signal);
      if (controller.signal.aborted) return;
      setState((prev) => {
        const isRefetch = prev.loaded !== undefined && prev.loaded.forId === contactId;
        return {
          status: 'ready',
          loaded: {
            forId: contactId,
            items: isRefetch ? mergeFirstPage(prev.loaded!.items, page.media) : page.media,
            // A refetch keeps the deeper cursor a loadMore walk reached; a first
            // load takes the page's.
            nextCursor: isRefetch ? prev.loaded!.nextCursor : page.nextCursor,
          },
        };
      });
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
      // A failed REFETCH keeps what is shown (stale beats blank); a failed first
      // load for THIS contact is an error.
      setState((prev) =>
        prev.loaded !== undefined && prev.loaded.forId === contactId ? prev : { status: 'error', loaded: undefined },
      );
    }
  }, [contactId]);

  useEffect(() => {
    // Contact switch: show loading for the new contact, never the old rows.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState((prev) => (prev.loaded?.forId === contactId ? prev : { status: 'loading', loaded: undefined }));
    void fetchFirst();
    return () => {
      abortRef.current?.abort();
      moreAbortRef.current?.abort();
    };
  }, [fetchFirst, contactId]);

  const loadMore = useCallback(() => {
    const cursor = state.loaded?.nextCursor;
    if (cursor === undefined || loadingMore || state.loaded?.forId !== contactId) return;
    moreAbortRef.current?.abort();
    const controller = new AbortController();
    moreAbortRef.current = controller;
    setLoadingMore(true);
    void (async () => {
      try {
        const page = await getContactMedia(contactId, { limit: MEDIA_PAGE_SIZE, cursor }, controller.signal);
        if (controller.signal.aborted) return;
        setState((prev) => {
          if (prev.loaded === undefined || prev.loaded.forId !== contactId) return prev;
          const seen = new Set(prev.loaded.items.map((m) => `${m.providerSid}:${m.index}`));
          const appended = page.media.filter((m) => !seen.has(`${m.providerSid}:${m.index}`));
          return {
            status: 'ready',
            loaded: { forId: contactId, items: [...prev.loaded.items, ...appended], nextCursor: page.nextCursor },
          };
        });
      } catch (err) {
        if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
        // Keep what is shown; the button stays available for another try.
      } finally {
        if (!controller.signal.aborted) setLoadingMore(false);
      }
    })();
  }, [contactId, loadingMore, state.loaded]);

  const scheduleRefetch = useCallback(() => {
    if (debounceRef.current !== undefined) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = undefined;
      void fetchFirst();
    }, REFETCH_DEBOUNCE_MS);
  }, [fetchFirst]);
  useEffect(
    () => () => {
      if (debounceRef.current !== undefined) {
        clearTimeout(debounceRef.current);
        debounceRef.current = undefined;
      }
    },
    [contactId],
  );
  useEventStream({ onMessagePersisted: scheduleRefetch, onConversationUpdated: scheduleRefetch });

  const items = useMemo(() => (state.loaded?.items ?? []).map(toCommsMediaItem), [state.loaded]);
  return {
    status: state.status,
    items,
    hasMore: state.loaded?.nextCursor !== undefined,
    loadingMore,
    loadMore,
  };
}
