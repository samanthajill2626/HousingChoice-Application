// useInbox - owns the entity-centric inbox list for the active filter: the
// head page (GET /api/inbox), cursor "load more", optimistic mark-read /
// mark-unread with rollback, live updates, and (spec 5.8) an instant restore
// from the module store when the page comes back after a navigation. Degrades
// to an honest 'pending' state when GET /api/inbox 404s with no rows on
// screen (the C8 backend slice not live yet).
//
// ONE AUTHORITATIVE LIST. Every list mutation computes its next value from
// `listRef.current` synchronously and goes through `commitList`, which mirrors
// it into React state for rendering and saves a snapshot to the store while
// the list is `ready` and this instance is alive. No functional setState
// updater ever touches the list, so a saved snapshot is exactly what was
// committed. The pure merge rules live in inboxListMerge.ts.
//
// Live-update policy: the SSE `conversation.updated` event is PER-CONVERSATION
// and carries no contactId, so it cannot soundly patch an aggregated CONTACT
// row. Any inbox-affecting event schedules a debounced HEAD READ of the
// current filter (spec 5.6): a complete page one replaces the list; an
// incomplete one (a budget exit, a truncated page) merges in and removes
// nothing. A failed head read while rows are rendered keeps them and raises
// `refreshFailed` (the banner, spec 5.7). A future row-keyed `inbox.updated`
// event would enable no-network patch-in-place. Self-initiated mark-read IS
// patched optimistically (we know the row), re-applied over a racing head read
// while in flight, and rolled back on failure.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ApiError,
  getInbox,
  markConversationRead,
  markConversationUnread,
  markInboxRead,
  markInboxUnread,
  useEventStream,
  type InboxFilter,
  type InboxRow as InboxRowData,
} from '../../api/index.js';
import { useUnread } from '../../app/UnreadContext.js';
import { contactClearKey, conversationClearKey, phoneClearKey } from '../../app/unreadKeys.js';
import {
  appendPage,
  baseOf,
  emptyListState,
  mergeHeadRead,
  patchUnread,
  rowKey,
  type ListState,
} from './inboxListMerge.js';
import {
  inboxListKey,
  loadInboxList,
  saveInboxList,
  type InboxListSnapshot,
} from './inboxListStore.js';

export { rowKey } from './inboxListMerge.js';

export type InboxStatus = 'loading' | 'pending' | 'ready' | 'error';

/** The page size the dashboard requests (spec 5.1). */
export const DEFAULT_PAGE_LIMIT = 100;
/** Mirrors the server's MAX_INBOX_LIMIT (app/src/routes/inbox.ts). */
export const MAX_PAGE_LIMIT = 100;

/** An in-flight optimistic mutation patch for one row (re-applied over
 *  head reads until the request settles). */
interface Pending {
  unreadCount?: number;
}

export interface InboxState {
  status: InboxStatus;
  rows: InboxRowData[];
  /** The server withheld group-text rows this filter would otherwise show (page
   *  one takes the newest 50; the partition walk has its own budget). The page
   *  renders the "showing the latest" affordance instead of implying the list is
   *  complete. There is no exact total by design. */
  groupsTruncated: boolean;
  /** How many group-text rows are actually ON SCREEN for this filter.
   *
   *  A26, CORRECTED by adversarial 30. A26 moved this count off the displayed
   *  list and onto the server page, which fixed the wrong half of the drift: on
   *  the Unread filter `rows` drops every row the operator marks read while the
   *  server page does not, so the notice could claim "the latest 2 unread group
   *  texts" with ZERO group rows on screen. The notice is a statement about the
   *  rendered list, so it counts the rendered list. A26's own case survives
   *  because it only ever bit on Unread: on All and Groups a marked-read row
   *  stays in the list, so this number does not tick under a standing
   *  truncation claim. `groupsTruncated` remains the server's separate,
   *  untouched statement that MORE exist than were handed down. */
  groupRowsShown: number;
  /** The UNREAD feed ended for a NON-NATURAL reason (the server's request budget
   *  expired before the page filled, or its seen-set depth cap ended paging).
   *  Only a `filter=unread` response can set it. A page with rows simply ends -
   *  no affordance; an EMPTY SERVER page with this flag is NOT "all caught up",
   *  so Inbox.tsx renders the existing failure state + Retry instead of lying.
   *  It is a statement about the LATEST page read (a head read or a loaded
   *  page), so it is replaced (never OR-ed) by each page and reset on every
   *  filter change. */
  truncated: boolean;
  /** How many rows the SERVER has handed down for this filter (head + loaded
   *  pages), BEFORE the optimistic patches and the Unread narrowing produce
   *  `rows`.
   *
   *  Adversarial 4, the same drift the `groupRowsShown` comment above records
   *  and the mirror-image correction: `truncated` is a statement about the
   *  SERVER PAGE while `rows` is the CLIENT-FILTERED list, so pairing the two
   *  rendered the wrong surface. `rows.length === 0 && truncated` was reachable
   *  by an operator marking every row on a truncated page read - a successful
   *  local action producing "We couldn't load your inbox." with no server
   *  statement behind it. `groupRowsShown` moved a claim about the RENDERED list
   *  onto the rendered list; this moves a claim about the SERVER page onto the
   *  server page. Mark-read cannot move it (it only patches `unreadCount`); only
   *  a committed head read or loaded page does. */
  serverRowCount: number;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  retry: () => void;
  /** Optimistically mark a row's comms read (also called on row open). No-op if
   *  already read or the row can't be addressed. */
  markRead: (row: InboxRowData) => void;
  /** Optimistically mark a READ row unread (the row's toggle counterpart). No-op
   *  if already unread or unaddressable. */
  markUnread: (row: InboxRowData) => void;
  /** A background head read failed while rows were rendered (spec 5.7). */
  refreshFailed: boolean;
  /** Auto-load may fire (spec 5.2): the read that installed the live cursor
   *  chain delivered at least one row. */
  autoLoadArmed: boolean;
  /** Bumped by every committed head read and loaded page (never by a patch). */
  pageEpoch: number;
  /** The snapshot's scroll position when this mount restored from the store. */
  restoredScrollTop: number | null;
  /** The page reports the scroll container's scrollTop here (spec 5.8). */
  noteScrollTop: (top: number) => void;
}

/** Debounce window (ms) for SSE-triggered head reads - coalesces a burst of
 *  conversation.updated events into one read (matches useToday). */
const REFETCH_DEBOUNCE_MS = 300;

/** Group-text rows in a list (the basis for the truncation notice's count - see
 *  `InboxState.groupRowsShown`). */
function countGroupRows(rows: InboxRowData[]): number {
  return rows.filter((r) => r.kind === 'group_text').length;
}

/** Newest-activity-first, matching the server's inbox ordering. */
function sortByActivity(rows: InboxRowData[]): InboxRowData[] {
  return [...rows].sort(
    (a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
  );
}

/** Overlay the in-flight optimistic patches (keyed by rowKey) on a row list. */
function applyPatches(rows: InboxRowData[], pending: Map<string, Pending>): InboxRowData[] {
  return rows.map((row) => {
    const p = pending.get(rowKey(row));
    if (p === undefined) return row;
    return { ...row, ...(p.unreadCount !== undefined && { unreadCount: p.unreadCount }) };
  });
}

/** The store's shape (spec 5.8): server order, NOT narrowed, NOT sorted, with
 *  the pending patches folded in. */
function snapshotOf(
  list: ListState,
  pending: Map<string, Pending>,
  scrollTop: number,
): InboxListSnapshot {
  return {
    head: applyPatches(list.head, pending),
    tail: applyPatches(list.tail, pending),
    cursor: list.cursor,
    groupsTruncated: list.groupsTruncated,
    truncated: list.truncated,
    scrollTop,
  };
}

function listFromSnapshot(s: InboxListSnapshot): ListState {
  return {
    head: s.head,
    tail: s.tail,
    cursor: s.cursor,
    groupsTruncated: s.groupsTruncated,
    truncated: s.truncated,
    // A restore mounts UNARMED (spec 5.2): the first complete head read arms.
    autoLoadArmed: false,
    pageEpoch: 0,
  };
}

export function useInbox(
  filter: InboxFilter,
  limit: number = DEFAULT_PAGE_LIMIT,
  operatorId = 'anon',
  // True when the page is about to APPLY a restored scroll position (a POP
  // arrival): the scroll ref is then seeded with it from the first render, so
  // a StrictMode simulated unmount saves the position this visit shows.
  restoreScroll = false,
): InboxState {
  const initialKey = inboxListKey(operatorId, filter, limit);
  // Lazy init from the store: a restored list's FIRST render is already ready.
  const [restored] = useState<InboxListSnapshot | undefined>(() => loadInboxList(initialKey));
  const [status, setStatus] = useState<InboxStatus>(restored ? 'ready' : 'loading');
  const [list, setList] = useState<ListState>(() =>
    restored ? listFromSnapshot(restored) : emptyListState(),
  );
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // In-flight optimistic patches keyed by rowKey; re-applied over head reads.
  const [pending, setPending] = useState<Map<string, Pending>>(new Map());
  // The nav badge's optimistic layer. Marking a row read here decrements the
  // badge INSTANTLY instead of waiting for the reconcile fetch; the server stays
  // the authority and expires the clear on its next read. Both functions are
  // identity-stable by contract (see UnreadContext) - markRead's dep array below
  // depends on that.
  const { noteRowsCleared, rollbackRowsCleared } = useUnread();

  // The authoritative list, readable from any callback.
  const listRef = useRef<ListState>(list);
  // The rendered status, readable from inside a fetch callback without making
  // `fetchHead` depend on it. It decides whether the generation guard below
  // has anything to protect: see the guard for why that matters. It also
  // decides whether rows are rendered (spec 5.7) and whether a commit may save
  // (spec 5.8).
  //
  // Written through `applyStatus` and NEVER through `setStatus` directly, so the
  // ref cannot drift from the state. A `useEffect` mirror would look tidier and
  // be wrong: effects flush after commit, and a fetch continuation resolving in
  // that gap would read the previous status and take the opposite branch.
  const statusRef = useRef<InboxStatus>(status);
  // The pending patches, mirrored synchronously so the unmount save can see a
  // patch made in the same render that navigated away.
  const pendingRef = useRef<Map<string, Pending>>(new Map());
  // The store key the current state belongs to; captured at every save.
  const keyRef = useRef(initialKey);
  // The key whose state is already on screen (restored, or reset by the
  // filter effect): the effect resets only when the key CHANGES, which is
  // what lets a StrictMode replay and a restored mount skip the reset.
  const restoredKeyRef = useRef<string | null>(restored ? initialKey : null);
  // True between the mount effect's body and its cleanup: a request that
  // settles after unmount neither commits nor saves.
  const aliveRef = useRef(false);
  // The scroll container's last reported scrollTop (spec 5.8), seeded with
  // the restored value only when the page will apply it.
  const scrollTopRef = useRef(restoreScroll && restored !== undefined ? restored.scrollTop : 0);

  const abortRef = useRef<AbortController | null>(null);
  // Bumped on every committed optimistic mutation; a head read that started
  // before the commit (so it read pre-mutation server state) is then discarded
  // instead of clobbering the commit - unless the screen shows a spinner, in
  // which case nothing would re-issue it (see the guard in fetchHead).
  const genRef = useRef(0);
  // C2 / spec 11's defense-in-depth pair. `loadMore` gets its OWN abort handle
  // and its own generation, both keyed on the FILTER rather than on optimistic
  // mutations: a page fetched for the previous filter must never append to the
  // new filter's list, and its cursor addresses a different DynamoDB partition,
  // so installing it would 400 the next Load more.
  const loadMoreAbortRef = useRef<AbortController | null>(null);
  const filterGenRef = useRef(0);
  // The SSE-RECONCILE axis (adversarial 29). Bumped whenever a head read
  // COMMITS - the initial load, a retry, a debounced reconcile, or the mount
  // reconcile - so an in-flight `loadMore` can tell that the list it was a
  // continuation of has been replaced underneath it. Without it, the page
  // appends to a list it does not continue (silently skipped rows; before
  // appendPage's rowKey dedupe, duplicate rowKeys too) and installs a cursor
  // addressing a position the list no longer holds, which the next Load more
  // 400s on. The filter axis already had this guard; this is the same guard on
  // the other axis that can move the list.
  const firstPageGenRef = useRef(0);
  // THE FILTER THIS HOOK IS CURRENTLY SHOWING, readable from a callback that was
  // built for a DIFFERENT one. `scheduleRefetch` closes over the `fetchHead` of
  // whichever filter was active when the SSE event arrived, so a reconcile can
  // land for a tab the operator has already left - and `fetchHead` applies its
  // page to whatever list is on screen: a complete page replaces the list; an
  // incomplete one merges in (spec 5.6). Comparing the closure's `filter`
  // against this ref is what refuses it.
  //
  // A GENERATION COUNTER CANNOT DO THIS JOB, which is why `filterGenRef` is not
  // reused here: the stale callback would read the counter at CALL time, by
  // which point the filter effect has already bumped it, so the stale page
  // would compare EQUAL and commit. The identity of the filter is the only
  // thing the closure carries that the ref can be checked against.
  const activeFilterRef = useRef(filter);
  // The pending debounced reconcile, declared up here (rather than beside
  // `scheduleRefetch` below) so the filter-change effect can cancel it. Its
  // clearing effect has empty deps and therefore only ever ran on UNMOUNT,
  // which is what let a reconcile outlive the filter that scheduled it.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  /** The ONLY way this hook changes `status` - keeps `statusRef` atomic with it. */
  const applyStatus = useCallback((next: InboxStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  /** The ONLY writer of the list (spec 5.5). */
  const commitList = useCallback((next: ListState) => {
    listRef.current = next;
    setList(next);
    if (aliveRef.current && statusRef.current === 'ready') {
      saveInboxList(keyRef.current, snapshotOf(next, pendingRef.current, scrollTopRef.current));
    }
  }, []);

  const clearPendingRefetch = useCallback(() => {
    if (debounceRef.current !== undefined) {
      clearTimeout(debounceRef.current);
      debounceRef.current = undefined;
    }
  }, []);

  const fetchHead = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const gen = genRef.current;
    try {
      const pageData = await getInbox({ filter, limit }, controller.signal);
      if (controller.signal.aborted) return;
      // THE GENERATION GUARD PROTECTS A LIST, NOT A SPINNER.
      //
      // Discarding a pre-mutation page is right when there is a rendered list
      // whose committed state it would clobber. It is WRONG when the screen is
      // showing a spinner, because nothing re-issues a discarded page: the
      // filter effect's reset and a `retry` with no rows rendered both set
      // 'loading' and then fetch exactly once. Discarding there leaves no rows,
      // no request in flight, and no Retry (that affordance lives under
      // `status: error`) - a permanently stuck tab, which is a worse outcome
      // than the stale-page bug this hook was just fixed for.
      //
      // Reachable without any filter change: mark read, a complete head read
      // that returns no rows empties the list, a head read then fails with
      // nothing rendered (the error arm), the operator hits Retry (which sets
      // loading with no rows), and the POST commits while Retry's page is on
      // the wire. Installing that page instead is safe - the optimistic patch
      // still overlays it, and mark-read emits `conversation.updated`, so a
      // reconcile follows within the debounce window and corrects any count the
      // page carried stale.
      if (gen !== genRef.current && statusRef.current === 'ready') return;
      // A page for a filter we have LEFT is refused, never installed.
      //
      // HONEST STATUS: no test can currently fail by deleting this line, and
      // that is stated rather than hidden. Two other mechanisms already cover
      // every path that reaches here - the filter effect's cleanup ABORTS any
      // in-flight head read, and the effect CLEARS a pending reconcile before
      // it can fire - so today this is the third lock on a door with two
      // working ones. It is kept for the same reason `loadMore` checks
      // `filterStale()` at its commit point despite also aborting: it makes the
      // refusal local to the moment state is installed, so a future scheduler
      // (a focus-retry, a polling fallback) cannot reintroduce this class
      // silently. Delete it only together with that argument.
      if (filter !== activeFilterRef.current) return;
      // Settled after unmount: neither commit nor save (spec 5.5). Another
      // commit-point lock: the unmount cleanup already aborts this read.
      if (!aliveRef.current) return;
      firstPageGenRef.current += 1;
      // Ready BEFORE the commit so the commit's save sees a ready list.
      applyStatus('ready');
      // Any committed head read clears the banner (spec 5.7).
      setRefreshFailed(false);
      commitList(mergeHeadRead(listRef.current, pageData, filter, limit));
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        return;
      }
      // A failure for a filter we have LEFT is refused, like its page would be:
      // the same commit-point lock as the success path's refusal (the filter
      // effect's cleanup already aborts this read on a filter change).
      //
      // NO GENERATION CHECK ON THIS PATH, DELIBERATELY; the success path above
      // keeps its guard. The generation exists to stop a PRE-mutation page from
      // clobbering a committed mutation, and a failure installs no page: with
      // rows rendered it keeps them and only raises the banner, so there is
      // nothing for the generation to protect, and refusing on it SWALLOWS the
      // failure. Reachable with no filter change: a mark-read POST and a
      // background head read are both in flight, the POST commits (the
      // generation bumps), then the read fails - a generation check returns
      // here, before the rows-rendered check, and leaves a silently stale list
      // with no banner (spec decision 7, 5.7, invariant 4). The generation
      // check that stood here only ever stopped such a failure from BLANKING
      // the list, which the rows-rendered rule below now prevents on every
      // generation. With no rows rendered, returning here could strand a
      // spinner instead (a reset or a no-rows Retry set 'loading'): the error
      // and 404 arms below are its only way out.
      if (filter !== activeFilterRef.current) return;
      // Spec 5.7: with rows rendered, a failed head read (a 404 included: a
      // proxy or deploy-window 404 must not blank a healthy list) keeps the
      // rows and raises the banner. This resolves the residue the old failure
      // path could only file (docs/issues/inbox-reconcile-failure-blanks-list.md):
      // a background failure no longer blanks a healthy list into the error
      // state, and it is no longer silent either.
      const rowsRendered = statusRef.current === 'ready' && baseOf(listRef.current).length > 0;
      if (rowsRendered) {
        setRefreshFailed(true);
        return;
      }
      if (err instanceof ApiError && err.status === 404) {
        // C8 backend slice isn't live yet -> honest pending state (not an error).
        // Status FIRST, then the empty commit: an empty tab is `ready` with no
        // rows, and committing before the status change would save an empty
        // snapshot. The epoch is carried, never reset (spec 5.2). The empty
        // list resets `truncated` with the rest: a stale `truncated` from a
        // previous unread page would make this legitimately empty page render
        // the FAILURE state.
        firstPageGenRef.current += 1;
        applyStatus('pending');
        commitList({ ...emptyListState(), pageEpoch: listRef.current.pageEpoch });
        return;
      }
      applyStatus('error');
    }
  }, [filter, limit, applyStatus, commitList]);

  // Initial load / restore-and-reconcile / full reload on a key change. The
  // reset runs ONLY when the key differs from the one whose state is already
  // on screen (spec 5.8): a restored mount and a StrictMode replay of the same
  // key take the reconcile branch instead. `loading` is applied BEFORE the
  // empty commit so no empty snapshot is ever saved.
  //
  // The synchronous reset clears several independent state atoms (status, the
  // list, pending, refreshFailed) on a key change; folding them into one
  // derived state would obscure this hook's gen-ref race handling, so it stays
  // a reset-on-key-change by design. It needs no react-hooks/set-state-in-effect
  // suppression today (eslint-plugin-react-hooks 7.1.1): the rule reports at
  // most once per effect, at its FIRST setState, and accepts one that sits
  // under a ref-derived condition, as the reset's `applyStatus` does
  // (`restoredKeyRef`). Moving an unconditional setState such as
  // `setLoadingMore(false)` above that `if` makes the rule fire on it; a
  // suppression then belongs on that line.
  useEffect(() => {
    const key = inboxListKey(operatorId, filter, limit);
    // A NEW filter is a new partition: bump the loadMore generation and abort any
    // in-flight page BEFORE the reset, so a response already on the wire cannot
    // append to the list we are about to build (C2).
    filterGenRef.current += 1;
    loadMoreAbortRef.current?.abort();
    // The new filter is the one we are showing from here on, and any reconcile
    // still pending for the OLD one is cancelled rather than left to fire into
    // this list. These lines must precede `fetchHead()` below: the fetch it
    // starts checks `activeFilterRef` when it lands, and its commit saves under
    // `keyRef`.
    activeFilterRef.current = filter;
    keyRef.current = key;
    clearPendingRefetch();
    if (key !== restoredKeyRef.current) {
      applyStatus('loading');
      // The epoch is carried across the reset: it only ever counts up (spec 5.2).
      // The empty list resets `truncated` too, for the same reason as the rest:
      // `truncated` is a statement about the page this filter last read.
      // Carried across a tab switch it would still be set while the new
      // filter's first page is in flight, and the moment that page lands empty
      // the All tab would render the inbox ERROR state.
      commitList({ ...emptyListState(), pageEpoch: listRef.current.pageEpoch });
      pendingRef.current = new Map();
      setPending(new Map());
      setRefreshFailed(false);
      scrollTopRef.current = 0;
    }
    setLoadingMore(false);
    restoredKeyRef.current = key;
    void fetchHead();
    return () => abortRef.current?.abort();
  }, [fetchHead, filter, limit, operatorId, clearPendingRefetch, applyStatus, commitList]);

  // Alive for exactly the mounted lifetime (true again after a StrictMode
  // replay); an in-flight loadMore is abandoned on unmount.
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      loadMoreAbortRef.current?.abort();
    };
  }, []);

  // THE UNMOUNT SAVE (spec 5.8): a LAYOUT cleanup runs before the replacing
  // route's DOM commits, with the pending patches folded in and the last
  // reported scrollTop. Gated on `ready` only - it IS the unmount.
  useLayoutEffect(
    () => () => {
      if (statusRef.current !== 'ready') return;
      saveInboxList(
        keyRef.current,
        snapshotOf(listRef.current, pendingRef.current, scrollTopRef.current),
      );
    },
    [],
  );

  const noteScrollTop = useCallback((top: number) => {
    scrollTopRef.current = top;
  }, []);

  const retry = useCallback(() => {
    // With rows rendered the rows stay (no spinner); the banner clears when the
    // read commits and stays if it fails again (spec 5.7).
    const rowsRendered = statusRef.current === 'ready' && baseOf(listRef.current).length > 0;
    if (!rowsRendered) applyStatus('loading');
    void fetchHead();
  }, [fetchHead, applyStatus]);

  const loadMore = useCallback(() => {
    const cursor = listRef.current.cursor;
    if (cursor === null || loadingMore) return;
    setLoadingMore(true);
    // Same abort + generation pattern as fetchHead above (C2). The filter is
    // captured at callback creation and the cursor is read from `listRef` at
    // call time, so without this a tab switch mid-flight appends the OLD
    // filter's rows and installs a cursor addressing the OLD partition - which
    // the server tag-check then 400s into the empty .catch below, leaving
    // contaminated rows and a permanently dead Load more.
    loadMoreAbortRef.current?.abort();
    const controller = new AbortController();
    loadMoreAbortRef.current = controller;
    const gen = filterGenRef.current;
    const firstPageGen = firstPageGenRef.current;
    const filterStale = (): boolean => controller.signal.aborted || gen !== filterGenRef.current;
    // The SECOND axis (adversarial 29): a head read committed while this page
    // was on the wire, so the list is no longer the one this page continues and
    // its cursor is no longer the position the page was fetched from. Kept
    // SEPARATE from `filterStale` because the two want different cleanup: a
    // filter change has its own effect that already reset `loadingMore`,
    // whereas nothing else clears it here - leaving it set would spin Load more
    // forever.
    const reconcileStale = (): boolean => firstPageGen !== firstPageGenRef.current;
    getInbox({ filter, limit, cursor }, controller.signal)
      .then((pageData) => {
        if (filterStale() || reconcileStale() || !aliveRef.current) return;
        // appendPage REPLACES `truncated`, never ORs it: the flag describes the
        // page just read, and this commit sits inside the staleness guard so a
        // page for a filter (or a list) we no longer show cannot stamp it.
        commitList(appendPage(listRef.current, pageData));
      })
      .catch(() => {
        /* keep the cursor so the user can retry "Load more" */
      })
      .finally(() => {
        // The filter-change effect already cleared the flag for the new filter;
        // clearing it again from a stale page would re-enable the button under a
        // page that IS in flight. A reconcile-stale page DOES clear it: the
        // reconcile installed a fresh cursor, so Load more is live again. After
        // unmount there is nothing left to clear.
        if (!filterStale() && aliveRef.current) setLoadingMore(false);
      });
  }, [filter, limit, loadingMore, commitList]);

  // --- SSE: debounced head read of the current filter ------------------------
  // `debounceRef` / `clearPendingRefetch` are declared with the other refs above,
  // because the filter-change effect has to be able to cancel a pending
  // reconcile before it fires into a list it was never scheduled for.
  const scheduleRefetch = useCallback(() => {
    clearPendingRefetch();
    debounceRef.current = setTimeout(() => {
      debounceRef.current = undefined;
      void fetchHead();
    }, REFETCH_DEBOUNCE_MS);
  }, [fetchHead, clearPendingRefetch]);

  useEffect(() => clearPendingRefetch, [clearPendingRefetch]);

  useEventStream({ onConversationUpdated: scheduleRefetch });

  // --- Optimistic mutations (the patches are mirrored in pendingRef) --------
  const setPatch = useCallback((key: string, patch: Pending) => {
    const next = new Map(pendingRef.current);
    next.set(key, { ...next.get(key), ...patch });
    pendingRef.current = next;
    setPending(next);
  }, []);
  // Clear only the field this mutation owns - so concurrent overlays on the same
  // row don't wipe each other's still-in-flight state.
  const clearPatch = useCallback((key: string, field: keyof Pending) => {
    const prev = pendingRef.current;
    const entry = prev.get(key);
    if (entry === undefined || !(field in entry)) return;
    const next = new Map(prev);
    const remaining = { ...entry };
    delete remaining[field];
    if (Object.keys(remaining).length === 0) next.delete(key);
    else next.set(key, remaining);
    pendingRef.current = next;
    setPending(next);
  }, []);

  const markRead = useCallback(
    (row: InboxRowData) => {
      if (row.unreadCount === 0) return;
      const key = rowKey(row);
      // Resolve the read action per KIND (bail if unaddressable - don't fake
      // success). A MULTI-PARTY row (relay_group / group_text) marks read through
      // its OWN conversation (POST /api/conversations/:id/read), NOT the
      // contact/phone fan-out - the inbox mark-read routes both fan out over a
      // contact's participant-keyed threads, which a group thread has none of.
      // The badge's clear key is minted IN THE SAME BRANCH that resolved the read
      // action, bundled with it, rather than derived from `row.kind` separately:
      // the third branch catches rows BY PHONE across kinds, so a kind-derived
      // key would mint `c:undefined` for a contact row addressed by phone. It is
      // also a different vocabulary from `rowKey` (inboxListMerge.ts) - both
      // group kinds share `cv:` so the badge dedupes with the tour/placement
      // tabs (unreadKeys.ts).
      let resolved: { read: () => Promise<void>; clearKey: string } | undefined;
      if (row.kind === 'relay_group' || row.kind === 'group_text') {
        if (row.conversationId !== undefined) {
          const conversationId = row.conversationId;
          resolved = {
            read: () => markConversationRead(conversationId),
            clearKey: conversationClearKey(conversationId),
          };
        }
      } else if (row.kind === 'contact' && row.contactId !== undefined) {
        const contactId = row.contactId;
        resolved = { read: () => markInboxRead({ contactId }), clearKey: contactClearKey(contactId) };
      } else if (row.phone !== undefined) {
        const phone = row.phone;
        resolved = { read: () => markInboxRead({ phone }), clearKey: phoneClearKey(phone) };
      }
      if (resolved === undefined) return; // unaddressable - don't fake success
      const { read, clearKey } = resolved;
      // The filter EPOCH this mutation belongs to. `genRef` is global to the
      // hook, so without this the commit below invalidates the in-flight head
      // read of whatever filter the operator moved to - and since the filter
      // effect has already set status 'loading' and nothing re-fetches, that tab
      // strands on a SPINNER, with no Retry (that lives under `status: error`)
      // until an unrelated event arrives. The mutation is real either way; it
      // simply has no authority over a list it was never part of.
      //
      // (Since fetchHead's generation guard stopped discarding a page while the
      // screen shows a spinner, that strand has a second lock. This epoch still
      // keeps the bump from discarding a READY tab's in-flight head read on a
      // filter the mutation was never made against.)
      //
      // AN EPOCH, NOT AN IDENTITY, and the difference is a live bug not a nicety:
      // filter identities RECUR. Mark read on All, glance at Unread, come back
      // to All - an ordinary triage gesture, and one the browser's back button
      // performs by design - and an identity check sees 'all' again, concludes
      // nothing changed, and strands the tab it was meant to protect.
      // `filterGenRef` already counts filter-effect runs and never repeats.
      //
      // Note this is the MIRROR of the argument at `activeFilterRef` above: a
      // counter cannot serve THAT case because the stale closure reads it after
      // the bump, while here the read happens at CLICK time, before any bump,
      // which is exactly what a counter handles and an identity does not.
      const mutationGen = filterGenRef.current;
      setPatch(key, { unreadCount: 0 });
      // Past the unread>0 and addressability guards, so this row really is one
      // the badge counts: decrement it now, and let the next reconcile fetch
      // expire the clear.
      noteRowsCleared([clearKey]);
      read()
        .then(() => {
          // Commit wins over any in-flight pre-commit head read of the list this
          // mutation was made against - and only that list.
          if (filterGenRef.current === mutationGen) genRef.current += 1;
          // Commit to the list regardless of the filter: if the operator has
          // moved to a filter that also shows this row, zeroing it there is
          // correct, and on a list that does not contain it the patch is a
          // no-op. After unmount it neither commits nor saves (spec 5.5).
          if (aliveRef.current) commitList(patchUnread(listRef.current, key, 0));
        })
        .catch(() => {
          /* rollback: dropping the patch restores the list's original count */
          rollbackRowsCleared([clearKey]);
        })
        .finally(() => clearPatch(key, 'unreadCount'));
    },
    [setPatch, clearPatch, noteRowsCleared, rollbackRowsCleared, commitList],
  );

  const markUnread = useCallback(
    (row: InboxRowData) => {
      if (row.unreadCount > 0) return;
      const key = rowKey(row);
      // Same per-kind addressing as markRead. The nav badge is NOT touched
      // optimistically here: its optimistic layer models CLEARS only (pending
      // clear keys with a TTL); a manual flag rides the server's
      // conversation.updated, which the badge already reconciles on. The row
      // itself flips immediately.
      let flag: (() => Promise<void>) | undefined;
      if (row.kind === 'relay_group' || row.kind === 'group_text') {
        if (row.conversationId !== undefined) {
          const conversationId = row.conversationId;
          flag = () => markConversationUnread(conversationId);
        }
      } else if (row.kind === 'contact' && row.contactId !== undefined) {
        const contactId = row.contactId;
        flag = () => markInboxUnread({ contactId });
      } else if (row.phone !== undefined) {
        const phone = row.phone;
        flag = () => markInboxUnread({ phone });
      }
      if (flag === undefined) return; // unaddressable - don't fake success
      // Same filter-EPOCH scoping as markRead above, for the same reason and
      // with the same A-to-B-to-A trap - this generation bump would otherwise
      // strand the tab the operator moved to.
      const mutationGen = filterGenRef.current;
      setPatch(key, { unreadCount: 1 });
      flag()
        .then(() => {
          if (filterGenRef.current === mutationGen) genRef.current += 1;
          if (aliveRef.current) commitList(patchUnread(listRef.current, key, 1));
        })
        .catch(() => {
          /* rollback: dropping the patch restores the original (read) count */
        })
        .finally(() => clearPatch(key, 'unreadCount'));
    },
    [setPatch, clearPatch, commitList],
  );

  // --- Assemble the displayed rows ------------------------------------------
  const base = baseOf(list);
  const patched = applyPatches(base, pending);
  // On the Unread filter a row optimistically marked read drops out immediately,
  // so the list (and the "all caught up" empty state) stay in sync with the action.
  const visible = filter === 'unread' ? patched.filter((r) => r.unreadCount > 0) : patched;
  const rows = sortByActivity(visible);

  return {
    status,
    rows,
    groupsTruncated: list.groupsTruncated,
    truncated: list.truncated,
    // Counted off the SERVER list, never the rendered one (adversarial 4) - see
    // `InboxState`. `base` is exactly what the server handed down; `rows` is not.
    serverRowCount: base.length,
    // Counted off the RENDERED list (adversarial 30) - see `InboxState`.
    groupRowsShown: countGroupRows(rows),
    hasMore: list.cursor !== null,
    loadingMore,
    loadMore,
    retry,
    markRead,
    markUnread,
    refreshFailed,
    autoLoadArmed: list.autoLoadArmed,
    pageEpoch: list.pageEpoch,
    restoredScrollTop: restored ? restored.scrollTop : null,
    noteScrollTop,
  };
}
