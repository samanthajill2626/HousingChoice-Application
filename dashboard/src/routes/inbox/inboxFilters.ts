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

/** The honest empty-state copy per filter (spec §States & mobile). */
export function emptyCopy(filter: InboxFilter): { title: string; body: string } {
  switch (filter) {
    case 'unread':
      return { title: "You're all caught up", body: 'Switch to All to browse.' };
    case 'unknown':
      return { title: 'No unknown numbers', body: 'Untriaged inbound numbers show up here.' };
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
