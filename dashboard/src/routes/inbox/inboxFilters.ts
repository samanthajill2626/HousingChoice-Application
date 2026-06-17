// inboxFilters — the Inbox filter-tab model (tab order/labels) and the per-filter
// empty-state copy. Kept apart from the page so both are unit-testable in
// isolation. Filter values map 1:1 to the GET /api/inbox ?filter= query.
import type { InboxFilter } from '../../api/index.js';

export interface InboxFilterTab {
  filter: InboxFilter;
  label: string;
}

/** Tab order, left→right. 'all' is the default (first). */
export const INBOX_FILTERS: InboxFilterTab[] = [
  { filter: 'all', label: 'All' },
  { filter: 'unread', label: 'Unread' },
  { filter: 'unknown', label: 'Unknown' },
  { filter: 'mine', label: 'Assigned to me' },
];

/** The honest empty-state copy per filter (spec §States & mobile). */
export function emptyCopy(filter: InboxFilter): { title: string; body: string } {
  switch (filter) {
    case 'unread':
      return { title: "You're all caught up", body: 'Switch to All to browse.' };
    case 'unknown':
      return { title: 'No unknown numbers', body: 'Untriaged inbound numbers show up here.' };
    case 'mine':
      return { title: 'Nothing assigned to you', body: 'Rows you take ownership of show up here.' };
    case 'all':
      return {
        title: 'No conversations yet',
        body: 'Inbound texts and calls show up here.',
      };
  }
}
