// useUnmatchedEmail -- the /email triage page's data hook for one tab
// ('unmatched' | 'quarantine'): the tab's first page (GET /api/unmatched-email),
// cursor "load more", optimistic ROW REMOVAL on an action (link / create-contact
// / spam / dismiss / release) with rollback, optimistic mark-read, and a live
// debounced refetch off the SSE `unmatched_email.updated`. Mirrors useInbox's
// shape (gen-ref commit-wins, abort-on-refetch, 404 -> honest 'pending').
//
// Actions RESOLVE the endpoint's payload (link/create return the redirect target
// so the page can navigate) and THROW on failure -- after rolling the row back --
// so the caller can surface the server's refusal. Every mutation also emits the
// SSE event, so the badge + a debounced refetch reconcile server-authoritatively.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  createContactFromUnmatched,
  dismissUnmatched,
  getUnmatchedEmail,
  linkUnmatched,
  markUnmatchedRead,
  releaseUnmatched,
  spamUnmatched,
  useEventStream,
  type UnmatchedEmailRow,
} from '../../api/index.js';

/** Which tab (== the route ?filter= value). */
export type UnmatchedFilter = 'unmatched' | 'quarantine';
export type UnmatchedStatus = 'loading' | 'pending' | 'ready' | 'error';

/** The New-contact modal's committed values. */
export interface NewContactInput {
  name: string;
  type: 'tenant' | 'landlord' | 'partner';
}

/** An in-flight optimistic patch for one row (re-applied over refetches until the
 *  request settles). `removed` hides the row; `read` clears its unread dot. */
interface Pending {
  removed?: boolean;
  read?: boolean;
}

export interface UnmatchedEmailState {
  status: UnmatchedStatus;
  rows: UnmatchedEmailRow[];
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  retry: () => void;
  /** Optimistically clear a row's unread dot + POST read. No-op if already read. */
  markRead: (id: string) => void;
  /** Link the row to an existing contact -> the conversation it landed in. */
  link: (id: string, contactId: string) => Promise<{ conversationId: string }>;
  /** Create a contact from the row then link -> the new contact + conversation. */
  createContact: (
    id: string,
    input: NewContactInput,
  ) => Promise<{ conversationId: string; contactId: string }>;
  /** Blocklist the sender + dismiss the row. */
  spam: (id: string) => Promise<void>;
  /** Dismiss the row (the "Dismiss"/"Delete" actions). */
  dismiss: (id: string) => Promise<void>;
  /** Move a quarantined row back to Unmatched. */
  release: (id: string) => Promise<void>;
}

const PAGE_LIMIT = 30;
/** Debounce window (ms) for SSE-triggered reconcile-refetches (matches useInbox). */
const REFETCH_DEBOUNCE_MS = 300;

export function useUnmatchedEmail(filter: UnmatchedFilter): UnmatchedEmailState {
  const [status, setStatus] = useState<UnmatchedStatus>('loading');
  const [base, setBase] = useState<UnmatchedEmailRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // In-flight optimistic patches keyed by unmatchedId; re-applied over refetches.
  const [pending, setPending] = useState<Map<string, Pending>>(new Map());

  const abortRef = useRef<AbortController | null>(null);
  // Bumped on every committed mutation; a first-page refetch that started before
  // the commit (so it read pre-mutation server state) is discarded, so it can't
  // resurrect an optimistically-removed row.
  const genRef = useRef(0);

  const fetchFirstPage = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const gen = genRef.current;
    try {
      const page = await getUnmatchedEmail(filter, undefined, controller.signal);
      if (controller.signal.aborted || gen !== genRef.current) return;
      setBase(page.rows);
      setCursor(page.nextCursor);
      setStatus('ready');
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        return;
      }
      if (err instanceof ApiError && err.status === 404) {
        // Route not live yet -> honest pending state (not an error).
        setBase([]);
        setCursor(null);
        setStatus('pending');
        return;
      }
      setStatus('error');
    }
  }, [filter]);

  // Initial load + full reload whenever the tab changes.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatus('loading');
    setBase([]);
    setCursor(null);
    setPending(new Map());
    void fetchFirstPage();
    return () => abortRef.current?.abort();
  }, [fetchFirstPage]);

  const retry = useCallback(() => {
    setStatus('loading');
    void fetchFirstPage();
  }, [fetchFirstPage]);

  const loadMore = useCallback(() => {
    if (cursor === null || loadingMore) return;
    setLoadingMore(true);
    getUnmatchedEmail(filter, cursor)
      .then((page) => {
        setBase((prev) => [...prev, ...page.rows]);
        setCursor(page.nextCursor);
      })
      .catch(() => {
        /* keep the cursor so the user can retry "Load more" */
      })
      .finally(() => setLoadingMore(false));
  }, [filter, cursor, loadingMore]);

  // --- SSE: debounced reconcile-refetch of the current tab's first page -------
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scheduleRefetch = useCallback(() => {
    if (debounceRef.current !== undefined) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = undefined;
      void fetchFirstPage();
    }, REFETCH_DEBOUNCE_MS);
  }, [fetchFirstPage]);

  useEffect(
    () => () => {
      if (debounceRef.current !== undefined) clearTimeout(debounceRef.current);
    },
    [],
  );

  useEventStream({ onUnmatchedEmailUpdated: scheduleRefetch });

  // --- Optimistic patches -----------------------------------------------------
  const setPatch = useCallback((id: string, patch: Pending) => {
    setPending((prev) => {
      const next = new Map(prev);
      next.set(id, { ...next.get(id), ...patch });
      return next;
    });
  }, []);
  const clearPatch = useCallback((id: string, field: keyof Pending) => {
    setPending((prev) => {
      const entry = prev.get(id);
      if (entry === undefined || !(field in entry)) return prev;
      const next = new Map(prev);
      const remaining = { ...entry };
      delete remaining[field];
      if (Object.keys(remaining).length === 0) next.delete(id);
      else next.set(id, remaining);
      return next;
    });
  }, []);

  const markRead = useCallback(
    (id: string) => {
      const row = base.find((r) => r.unmatchedId === id);
      if (row === undefined || row.read || pending.get(id)?.read) return;
      setPatch(id, { read: true });
      markUnmatchedRead(id)
        .then(() => {
          genRef.current += 1; // commit wins over any in-flight pre-commit refetch
          setBase((prev) => prev.map((r) => (r.unmatchedId === id ? { ...r, read: true } : r)));
        })
        .catch(() => {
          /* rollback: dropping the patch restores the unread dot */
        })
        .finally(() => clearPatch(id, 'read'));
    },
    [base, pending, setPatch, clearPatch],
  );

  // A row-removing action (link/create/spam/dismiss/release): optimistically hide
  // the row, run the request, COMMIT the removal on success (gen-bump so a racing
  // refetch can't resurrect it) or ROLL BACK + rethrow on failure.
  const mutateRemove = useCallback(
    async <T,>(id: string, run: () => Promise<T>): Promise<T> => {
      setPatch(id, { removed: true });
      try {
        const res = await run();
        genRef.current += 1;
        setBase((prev) => prev.filter((r) => r.unmatchedId !== id));
        clearPatch(id, 'removed');
        return res;
      } catch (err) {
        clearPatch(id, 'removed'); // rollback: the row reappears
        throw err;
      }
    },
    [setPatch, clearPatch],
  );

  const link = useCallback(
    (id: string, contactId: string) => mutateRemove(id, () => linkUnmatched(id, contactId)),
    [mutateRemove],
  );
  const createContact = useCallback(
    (id: string, input: NewContactInput) =>
      mutateRemove(id, () => createContactFromUnmatched(id, input)),
    [mutateRemove],
  );
  const spam = useCallback(
    (id: string) => mutateRemove(id, () => spamUnmatched(id)).then(() => undefined),
    [mutateRemove],
  );
  const dismiss = useCallback(
    (id: string) => mutateRemove(id, () => dismissUnmatched(id)).then(() => undefined),
    [mutateRemove],
  );
  const release = useCallback(
    (id: string) => mutateRemove(id, () => releaseUnmatched(id)).then(() => undefined),
    [mutateRemove],
  );

  // --- Assemble the displayed rows (drop removed, apply optimistic read) -------
  const rows = base
    .filter((r) => !pending.get(r.unmatchedId)?.removed)
    .map((r) => (pending.get(r.unmatchedId)?.read ? { ...r, read: true } : r));

  return {
    status,
    rows,
    hasMore: cursor !== null,
    loadingMore,
    loadMore,
    retry,
    markRead,
    link,
    createContact,
    spam,
    dismiss,
    release,
  };
}
