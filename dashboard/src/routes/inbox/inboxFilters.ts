// inboxFilters — the Inbox filter-tab model (tab order/labels) and the per-filter
// empty-state copy. Kept apart from the page so both are unit-testable in
// isolation. Filter values map 1:1 to the GET /api/inbox ?filter= query.
import type { InboxFilter } from '../../api/index.js';

export interface InboxFilterTab {
  filter: InboxFilter;
  label: string;
}

/** Tab order, left->right. 'all' is the default (first). "Groups" is the plural
 *  CATEGORY (native group texts), deliberately not the product label "Group
 *  text" - a tab is a place, not a thing. */
export const INBOX_FILTERS: InboxFilterTab[] = [
  { filter: 'all', label: 'All' },
  { filter: 'unread', label: 'Unread' },
  { filter: 'unknown', label: 'Unknown' },
  { filter: 'groups', label: 'Groups' },
];

/**
 * The empty state for a page that returned NO rows but DID hand back a cursor.
 *
 * NOT a per-filter string, because it is not about the filter: it says what the
 * SERVER said, which is "this request stopped before it found anything, and
 * there is more behind it". `filter=unknown` produces it deliberately - its
 * per-request SCAN BUDGET can expire on a wall of soft-deleted residue or
 * threadless stubs and return `{ rows: [], nextCursor }` (app/src/routes/inbox.ts,
 * the unknown branch's budget exit; and now also its thread-read-failure exit).
 *
 * The filter's own copy would be a LIE in that state - "No unknown numbers"
 * over a live Load more reads as a broken app, and the operator's correct move
 * (click it) is the one the sentence talks them out of.
 */
export function emptyMoreCopy(): { title: string; body: string } {
  return {
    title: 'Nothing on this page yet',
    body: 'This search stopped early to stay fast. Load more to keep looking.',
  };
}

/**
 * The empty state for a page the OPERATOR cleared, with more behind the cursor.
 *
 * Reachable on the Unread tab only, and by ordinary success: `useInbox` narrows
 * a row out of `rows` the moment it is marked read (that narrowing is the whole
 * point of the tab), so at the end of a triage session on a page that FILLED -
 * and therefore minted a cursor - the list is empty while the server page was
 * not. `emptyCopy('unread')` there says "You're all caught up" NEXT TO a live
 * Load more, and those two statements contradict each other.
 *
 * It says NOTHING it cannot back. Not "there are more unread behind this" - the
 * server mints a cursor whenever a page fills, including on a queue that ends at
 * an exact multiple of the limit, so the next page can legitimately come back
 * empty. What is certainly true is that this page is done and the server has not
 * yet said the feed is.
 */
export function emptyClearedCopy(): { title: string; body: string } {
  return {
    title: 'This page is clear',
    body: 'Load more to keep looking.',
  };
}

/** The honest empty-state copy per filter (spec §States & mobile). */
export function emptyCopy(filter: InboxFilter): { title: string; body: string } {
  switch (filter) {
    case 'unread':
      return { title: "You're all caught up", body: 'Switch to All to browse.' };
    case 'unknown':
      // THE BODY DESCRIBES WHAT THE TAB CAN ACTUALLY SHOW (2026-08-26, phase-6
      // review). It used to promise "Untriaged inbound numbers show up here",
      // which is false twice over. The tab is a walk over CONTACTS typed
      // `unknown` (app/src/routes/inbox.ts, the filter=unknown branch): a number
      // with no contact record has nothing to return - coverage class (e),
      // "accepted as lost", and those threads stay on All - and a `team_member`
      // is excluded by ruling, class (c). "Untriaged" was wrong on a third axis:
      // an unknown contact already moved to `status: 'active'` is still on this
      // tab (class f), because what puts it here is being UNIDENTIFIED, not
      // being unreviewed.
      //
      // The TITLE is a cross-workspace contract - pinned by the perf route
      // contract (e2e/performance/routes.ts, routes.test.ts) and by
      // e2e/tests/dashboard-next/unknown-caller-triage.spec.ts - so it moves
      // only with those. The body is this file's alone.
      return { title: 'No unknown numbers', body: 'Contacts we have not identified yet show up here.' };
    case 'groups':
      return {
        title: 'No group texts yet',
        body: 'Group texts you are part of show up here.',
      };
    case 'all':
      return {
        title: 'No conversations yet',
        body: 'Inbound texts and calls show up here.',
      };
  }
}
