// useInbox — owns the entity-centric inbox list for the active filter: the first
// page (GET /api/inbox), cursor "load more", optimistic mark-read with
// rollback, and live updates. Degrades to an honest 'pending' state until the C8
// backend slice lands (GET /api/inbox 404s).
//
// Live-update policy: the SSE `conversation.updated` event is PER-CONVERSATION
// and carries no contactId, so it cannot soundly patch an aggregated CONTACT
// row. Per the design spec ("treat either event as 'something changed,
// reconcile'"), any inbox-affecting event schedules a debounced refetch of the
// current filter's first page — the proven useToday policy. A future row-keyed
// `inbox.updated` event would enable no-network patch-in-place (see the plan's
// contract notes). Self-initiated mark-read IS patched optimistically
// (we know the row), re-applied over a racing refetch while in flight, and
// rolled back on failure.
import { useCallback, useEffect, useRef, useState } from 'react';
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

export type InboxStatus = 'loading' | 'pending' | 'ready' | 'error';

/** An in-flight optimistic mutation patch for one row (re-applied over refetches
 *  until the request settles). */
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
   *  It is a statement about the LATEST page read, so it is replaced (never
   *  OR-ed) by each page and reset on every filter change. */
  truncated: boolean;
  /** How many rows the SERVER has handed down for this filter (all pages so
   *  far), BEFORE the optimistic patches and the Unread narrowing produce
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
   *  a fetch installing new rows does. */
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
}

const PAGE_LIMIT = 30;
/** Debounce window (ms) for SSE-triggered reconcile-refetches — coalesces a
 *  burst of conversation.updated events into one refetch (matches useToday). */
const REFETCH_DEBOUNCE_MS = 300;

/** Stable identity for a row: conversationId for the two multi-party kinds,
 *  contactId for contacts, phone for unknowns. The four prefixes never collide -
 *  native group texts take `gt:` because `g:` is already relay's, and the
 *  trailing branch is the UNKNOWN case, so an unhandled kind would key as `u:`
 *  (empty phone) and collide with every other unhandled row. */
export function rowKey(row: InboxRowData): string {
  if (row.kind === 'relay_group') return `g:${row.conversationId ?? ''}`;
  if (row.kind === 'group_text') return `gt:${row.conversationId ?? ''}`;
  return row.kind === 'contact' ? `c:${row.contactId ?? ''}` : `u:${row.phone ?? ''}`;
}

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

export function useInbox(filter: InboxFilter): InboxState {
  const [status, setStatus] = useState<InboxStatus>('loading');
  const [base, setBase] = useState<InboxRowData[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [groupsTruncated, setGroupsTruncated] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // In-flight optimistic patches keyed by rowKey; re-applied over refetches.
  const [pending, setPending] = useState<Map<string, Pending>>(new Map());
  // The nav badge's optimistic layer. Marking a row read here decrements the
  // badge INSTANTLY instead of waiting for the reconcile fetch; the server stays
  // the authority and expires the clear on its next read. Both functions are
  // identity-stable by contract (see UnreadContext) - markRead's dep array below
  // depends on that.
  const { noteRowsCleared, rollbackRowsCleared } = useUnread();

  const abortRef = useRef<AbortController | null>(null);
  // Bumped on every committed optimistic mutation; a first-page refetch that
  // started before the commit (so it read pre-mutation server state) is then
  // discarded instead of clobbering the commit.
  const genRef = useRef(0);
  // C2 / spec 11's defense-in-depth pair. `loadMore` gets its OWN abort handle
  // and its own generation, both keyed on the FILTER rather than on optimistic
  // mutations: a page fetched for the previous filter must never append to the
  // new filter's list, and its cursor addresses a different DynamoDB partition,
  // so installing it would 400 the next Load more.
  const loadMoreAbortRef = useRef<AbortController | null>(null);
  const filterGenRef = useRef(0);
  // The SSE-RECONCILE axis (adversarial 29). Bumped whenever a first-page read
  // COMMITS - the initial load, a retry, or a debounced reconcile - so an
  // in-flight `loadMore` can tell that the list it was a continuation of has
  // been replaced underneath it. Without it, the page appends to a list it does
  // not continue (duplicate rowKeys, silently skipped rows - `rows` is not
  // deduped) and installs a cursor addressing a position the list no longer
  // holds, which the next Load more 400s on. The filter axis already had this
  // guard; this is the same guard on the other axis that can move `base`.
  const firstPageGenRef = useRef(0);
  // THE FILTER THIS HOOK IS CURRENTLY SHOWING, readable from a callback that was
  // built for a DIFFERENT one. `scheduleRefetch` closes over the
  // `fetchFirstPage` of whichever filter was active when the SSE event arrived,
  // so a reconcile can land for a tab the operator has already left - and
  // `fetchFirstPage` installs its page wholesale. Comparing the closure's
  // `filter` against this ref is what refuses it.
  //
  // A GENERATION COUNTER CANNOT DO THIS JOB, which is why `filterGenRef` is not
  // reused here: the stale callback would read the counter at CALL time, by
  // which point the filter effect has already bumped it, so the stale page
  // would compare EQUAL and commit. The identity of the filter is the only
  // thing the closure carries that the ref can be checked against.
  const activeFilterRef = useRef(filter);
  // The rendered status, readable from inside a fetch callback without making
  // `fetchFirstPage` depend on it. It decides whether the generation guard below
  // has anything to protect: see the guard for why that matters.
  //
  // Written through `applyStatus` and NEVER through `setStatus` directly, so the
  // ref cannot drift from the state. A `useEffect` mirror would look tidier and
  // be wrong: effects flush after commit, and a fetch continuation resolving in
  // that gap would read the previous status and take the opposite branch.
  const statusRef = useRef<InboxStatus>('loading');
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
  const clearPendingRefetch = useCallback(() => {
    if (debounceRef.current !== undefined) {
      clearTimeout(debounceRef.current);
      debounceRef.current = undefined;
    }
  }, []);

  const fetchFirstPage = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const gen = genRef.current;
    try {
      const pageData = await getInbox({ filter, limit: PAGE_LIMIT }, controller.signal);
      if (controller.signal.aborted) return;
      // THE GENERATION GUARD PROTECTS A LIST, NOT A SPINNER.
      //
      // Discarding a pre-mutation page is right when there is a rendered list
      // whose committed state it would clobber. It is WRONG when the screen is
      // showing a spinner, because nothing re-issues a discarded page: the
      // filter effect and `retry` both set 'loading' and then fetch exactly
      // once. Discarding there leaves no rows, no request in flight, and no
      // Retry (that affordance lives under `status: error`) - a permanently
      // stuck tab, which is a worse outcome than the stale-page bug this hook
      // was just fixed for.
      //
      // Reachable without any filter change: mark read, a background reconcile
      // fails, the operator hits Retry, and the POST commits while Retry's page
      // is on the wire. Installing that page instead is safe - the optimistic
      // patch still overlays it, and mark-read emits `conversation.updated`, so
      // a reconcile follows within the debounce window and corrects any count
      // the page carried stale.
      if (gen !== genRef.current && statusRef.current === 'ready') return;
      // A page for a filter we have LEFT is refused, never installed.
      //
      // HONEST STATUS: no test can currently fail by deleting this line, and
      // that is stated rather than hidden. Two other mechanisms already cover
      // every path that reaches here - the filter effect's cleanup ABORTS any
      // in-flight first-page fetch, and the effect CLEARS a pending reconcile
      // before it can fire - so today this is the third lock on a door with two
      // working ones. It is kept for the same reason `loadMore` checks
      // `filterStale()` at its commit point despite also aborting: it makes the
      // refusal local to the moment state is installed, so a future scheduler
      // (a focus-retry, a polling fallback) cannot reintroduce this class
      // silently. Delete it only together with that argument.
      if (filter !== activeFilterRef.current) return;
      firstPageGenRef.current += 1;
      setBase(pageData.rows);
      setCursor(pageData.nextCursor);
      setGroupsTruncated(pageData.groupsTruncated === true);
      setTruncated(pageData.truncated === true);
      applyStatus('ready');
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        return;
      }
      // THE SAME TWO AXES THE SUCCESS PATH REFUSES ON, and for the same reason.
      // This branch previously checked only the filter while claiming to check
      // both, and the missing generation check was reachable with no filter
      // change at all: a background reconcile that started before an optimistic
      // mark-read committed, and then FAILED, replaced a healthy list - and the
      // operator's just-committed action - with the inbox error state. The 404
      // arm below is worse, since it also empties `base`.
      //
      // RESIDUE, stated because the next reader will otherwise trust the
      // principle over the code: this does NOT make a failed reconcile
      // non-destructive in general. A background 500 with no mutation in flight
      // still blanks a healthy rendered list into the inbox error state, which
      // is what `loadMore`'s deliberately empty .catch refuses to do for a page
      // the operator actually asked for. Whether a background failure should
      // surface at all is a product decision rather than a defect, so it is
      // filed (docs/issues/inbox-reconcile-failure-blanks-list.md) rather than
      // decided here.
      if (gen !== genRef.current || filter !== activeFilterRef.current) return;
      if (err instanceof ApiError && err.status === 404) {
        // C8 backend slice isn't live yet → honest pending state (not an error).
        firstPageGenRef.current += 1;
        setBase([]);
        setCursor(null);
        setGroupsTruncated(false);
        // Reset with the rest: a stale `truncated` from a previous unread page
        // would make this legitimately empty page render the FAILURE state.
        setTruncated(false);
        applyStatus('pending');
        return;
      }
      applyStatus('error');
    }
  }, [filter, applyStatus]);

  // Initial load + full reload whenever the filter changes. The synchronous
  // reset clears four independent state atoms (status/base/cursor/pending) on a
  // filter change; folding them into one derived state would obscure this hook's
  // gen-ref race handling, so this reset-on-key-change is suppressed deliberately.
  useEffect(() => {
    // A NEW filter is a new partition: bump the loadMore generation and abort any
    // in-flight page BEFORE the reset, so a response already on the wire cannot
    // append to the list we are about to build (C2).
    filterGenRef.current += 1;
    loadMoreAbortRef.current?.abort();
    // The new filter is the one we are showing from here on, and any reconcile
    // still pending for the OLD one is cancelled rather than left to fire into
    // this list. Both lines must precede `fetchFirstPage()` below: the fetch
    // it starts checks `activeFilterRef` when it lands.
    activeFilterRef.current = filter;
    clearPendingRefetch();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    applyStatus('loading');
    setBase([]);
    setCursor(null);
    setGroupsTruncated(false);
    // Same reset for the same reason: `truncated` is a statement about the page
    // this filter last read. Carried across a tab switch it would still be set
    // while the new filter's first page is in flight, and the moment that page
    // lands empty the All tab would render the inbox ERROR state.
    setTruncated(false);
    setLoadingMore(false);
    setPending(new Map());
    void fetchFirstPage();
    return () => abortRef.current?.abort();
  }, [fetchFirstPage, filter, clearPendingRefetch, applyStatus]);

  const retry = useCallback(() => {
    applyStatus('loading');
    void fetchFirstPage();
  }, [fetchFirstPage, applyStatus]);

  const loadMore = useCallback(() => {
    if (cursor === null || loadingMore) return;
    setLoadingMore(true);
    // Same abort + generation pattern as fetchFirstPage above (C2). The filter
    // and cursor are captured at callback creation, so without this a tab switch
    // mid-flight appends the OLD filter's rows and installs a cursor addressing
    // the OLD partition - which the server tag-check then 400s into the empty
    // .catch below, leaving contaminated rows and a permanently dead Load more.
    loadMoreAbortRef.current?.abort();
    const controller = new AbortController();
    loadMoreAbortRef.current = controller;
    const gen = filterGenRef.current;
    const firstPageGen = firstPageGenRef.current;
    const filterStale = (): boolean => controller.signal.aborted || gen !== filterGenRef.current;
    // The SECOND axis (adversarial 29): a first-page read committed while this
    // page was on the wire, so `base` is no longer the list this page continues
    // and `cursor` is no longer the position it was fetched from. Kept SEPARATE
    // from `filterStale` because the two want different cleanup: a filter change
    // has its own effect that already reset `loadingMore`, whereas nothing else
    // clears it here - leaving it set would spin Load more forever.
    const reconcileStale = (): boolean => firstPageGen !== firstPageGenRef.current;
    getInbox({ filter, limit: PAGE_LIMIT, cursor }, controller.signal)
      .then((pageData) => {
        if (filterStale() || reconcileStale()) return;
        setBase((prev) => [...prev, ...pageData.rows]);
        setCursor(pageData.nextCursor);
        // REPLACE, never OR: the flag describes the page just read, and it sits
        // inside the staleness guard so a page for a filter (or a list) we no
        // longer show cannot stamp it.
        setTruncated(pageData.truncated === true);
      })
      .catch(() => {
        /* keep the cursor so the user can retry "Load more" */
      })
      .finally(() => {
        // The filter-change effect already cleared the flag for the new filter;
        // clearing it again from a stale page would re-enable the button under a
        // page that IS in flight. A reconcile-stale page DOES clear it: the
        // reconcile installed a fresh cursor, so Load more is live again.
        if (!filterStale()) setLoadingMore(false);
      });
  }, [filter, cursor, loadingMore]);

  // --- SSE: debounced reconcile-refetch of the current filter's first page ---
  // `debounceRef` / `clearPendingRefetch` are declared with the other refs above,
  // because the filter-change effect has to be able to cancel a pending
  // reconcile before it fires into a list it was never scheduled for.
  const scheduleRefetch = useCallback(() => {
    clearPendingRefetch();
    debounceRef.current = setTimeout(() => {
      debounceRef.current = undefined;
      void fetchFirstPage();
    }, REFETCH_DEBOUNCE_MS);
  }, [fetchFirstPage, clearPendingRefetch]);

  useEffect(() => clearPendingRefetch, [clearPendingRefetch]);

  useEventStream({ onConversationUpdated: scheduleRefetch });

  // --- Optimistic mutations -------------------------------------------------
  const setPatch = useCallback((key: string, patch: Pending) => {
    setPending((prev) => {
      const next = new Map(prev);
      next.set(key, { ...next.get(key), ...patch });
      return next;
    });
  }, []);
  // Clear only the field this mutation owns - so concurrent overlays on the same
  // row don't wipe each other's still-in-flight state.
  const clearPatch = useCallback((key: string, field: keyof Pending) => {
    setPending((prev) => {
      const entry = prev.get(key);
      if (entry === undefined || !(field in entry)) return prev;
      const next = new Map(prev);
      const remaining = { ...entry };
      delete remaining[field];
      if (Object.keys(remaining).length === 0) next.delete(key);
      else next.set(key, remaining);
      return next;
    });
  }, []);

  const markRead = useCallback(
    (row: InboxRowData) => {
      if (row.unreadCount === 0) return;
      const key = rowKey(row);
      // Resolve the read action per KIND (bail if unaddressable — don't fake
      // success). A MULTI-PARTY row (relay_group / group_text) marks read through
      // its OWN conversation (POST /api/conversations/:id/read), NOT the
      // contact/phone fan-out - the inbox mark-read routes both fan out over a
      // contact's participant-keyed threads, which a group thread has none of.
      // The badge's clear key is minted IN THE SAME BRANCH that resolved the read
      // action, bundled with it, rather than derived from `row.kind` separately:
      // the third branch catches rows BY PHONE across kinds, so a kind-derived
      // key would mint `c:undefined` for a contact row addressed by phone. It is
      // also a different vocabulary from `rowKey` above - both group kinds share
      // `cv:` so the badge dedupes with the tour/placement tabs (unreadKeys.ts).
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
        resolved = {
          read: () => markInboxRead({ contactId }),
          clearKey: contactClearKey(contactId),
        };
      } else if (row.phone !== undefined) {
        const phone = row.phone;
        resolved = { read: () => markInboxRead({ phone }), clearKey: phoneClearKey(phone) };
      }
      if (resolved === undefined) return; // unaddressable - don't fake success
      const { read, clearKey } = resolved;
      // The filter EPOCH this mutation belongs to. `genRef` is global to the
      // hook, so without this the commit below invalidates the in-flight first
      // page of whatever filter the operator moved to - and since the filter
      // effect has already set status 'loading' and nothing re-fetches, that tab
      // strands on a SPINNER, with no Retry (that lives under `status: error`)
      // until an unrelated event arrives. The mutation is real either way; it
      // simply has no authority over a list it was never part of.
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
          // Commit wins over any in-flight pre-commit refetch of the list this
          // mutation was made against - and only that list.
          if (filterGenRef.current === mutationGen) genRef.current += 1;
          // Commit to base regardless: if the operator has moved to a filter
          // that also shows this row, zeroing it there is correct, and on a list
          // that does not contain it the map is a no-op.
          setBase((prev) => prev.map((r) => (rowKey(r) === key ? { ...r, unreadCount: 0 } : r)));
        })
        .catch(() => {
          /* rollback: dropping the patch restores base's original count */
          rollbackRowsCleared([clearKey]);
        })
        .finally(() => clearPatch(key, 'unreadCount'));
    },
    [setPatch, clearPatch, noteRowsCleared, rollbackRowsCleared],
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
          setBase((prev) => prev.map((r) => (rowKey(r) === key ? { ...r, unreadCount: 1 } : r)));
        })
        .catch(() => {
          /* rollback: dropping the patch restores base's original (read) count */
        })
        .finally(() => clearPatch(key, 'unreadCount'));
    },
    [setPatch, clearPatch],
  );

  // --- Assemble the displayed rows ------------------------------------------
  const patched = base.map((row) => {
    const p = pending.get(rowKey(row));
    if (p === undefined) return row;
    return {
      ...row,
      ...(p.unreadCount !== undefined && { unreadCount: p.unreadCount }),
    };
  });
  // On the Unread filter a row optimistically marked read drops out immediately,
  // so the list (and the "all caught up" empty state) stay in sync with the action.
  const visible = filter === 'unread' ? patched.filter((r) => r.unreadCount > 0) : patched;
  const rows = sortByActivity(visible);

  return {
    status,
    rows,
    groupsTruncated,
    truncated,
    // Counted off the SERVER list, never the rendered one (adversarial 4) - see
    // `InboxState`. `base` is exactly what the server handed down; `rows` is not.
    serverRowCount: base.length,
    // Counted off the RENDERED list (adversarial 30) - see `InboxState`.
    groupRowsShown: countGroupRows(rows),
    hasMore: cursor !== null,
    loadingMore,
    loadMore,
    retry,
    markRead,
    markUnread,
  };
}
