// Inbox — the entity-centric communications hub (§2026-06-17-inbox-design). One
// row per contact (or untriaged unknown number), newest-activity-first, with All
// (default) / Unread / Unknown filters. Opening a row navigates to the contact
// page AND marks its comms read (optimistic). Degrades to an honest pending state
// until the C8 backend lands. New design language (tokens + CSS Modules);
// state-sync handled in useInbox.
import { useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { InboxFilter } from '../../api/index.js';
import { Spinner } from '../../ui/index.js';
import { INBOX_FILTERS, emptyCopy } from './inboxFilters.js';
import { InboxRow } from './InboxRow.js';
import { rowKey, useInbox } from './useInbox.js';
import styles from './Inbox.module.css';

/** The filter query param is the SOURCE OF TRUTH for the active tab, so
 *  `/inbox?filter=groups` is a real, shareable deep link (the truncation
 *  affordance below links to exactly that) and the back button steps through
 *  filters. An unrecognized value degrades to All rather than crashing or
 *  400ing the server on a hand-typed URL. */
function filterFromParam(raw: string | null): InboxFilter {
  return INBOX_FILTERS.some((t) => t.filter === raw) ? (raw as InboxFilter) : 'all';
}

export function Inbox(): React.JSX.Element {
  const [params, setParams] = useSearchParams();
  const filter = filterFromParam(params.get('filter'));
  const inbox = useInbox(filter);
  const empty = emptyCopy(filter);
  // A26: the count comes from the hook's server-page tally, NOT from a filter
  // over `inbox.rows`. `rows` is the DISPLAYED list - already narrowed by the
  // Unread filter and already patched by the optimistic mark-read - so counting
  // it made the notice tick 4, 3, 2 while the truncation claim stood.
  const groupRowCount = inbox.groupRowsShown;
  const groupNoun = groupRowCount === 1 ? 'group text' : 'group texts';

  const selectFilter = useCallback(
    (next: InboxFilter) => {
      // 'all' is the default, so it stays OUT of the URL - a bare /inbox is the
      // canonical link. useInbox drops the cursor on every filter change (its
      // fetch callback is keyed on the filter), so no stale cursor can cross
      // partitions.
      setParams(next === 'all' ? {} : { filter: next }, { replace: false });
    },
    [setParams],
  );

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Inbox</h1>
      <p className={styles.sub}>Triage texts and calls — every row opens its contact.</p>

      <div className={styles.tabs} role="tablist" aria-label="Inbox filters">
        {INBOX_FILTERS.map((tab) => (
          <button
            key={tab.filter}
            type="button"
            role="tab"
            aria-selected={filter === tab.filter}
            className={`${styles.tab} ${filter === tab.filter ? styles.tabActive : ''}`}
            onClick={() => selectFilter(tab.filter)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {inbox.groupsTruncated ? (
        // Honest, and no invented TOTAL: the group partition cannot produce one
        // without walking it. The number is what the server actually handed
        // down for this filter, and the link goes to the filter that pages the
        // whole list.
        //
        // C12 RULING - the Unread case. This notice can render on the Unread
        // tab, where the rows counted are unread group texts, but the only
        // group-paging view we have is `?filter=groups`, which pages ALL group
        // texts. There is no server-side unread-groups filter today: the groups
        // partition is walked newest-first with its own budget, and an
        // unread-scoped variant would be a new query shape and a new cursor tag,
        // which this feature does not add. So the affordance is LABELLED for
        // where it really goes rather than implying a view that does not exist -
        // the cheap correct option, and reachable only past ~2000 group threads
        // against a real-world 132.
        <p className={styles.notice}>
          Showing the latest {groupRowCount} {filter === 'unread' ? 'unread ' : ''}
          {groupNoun}.
          {filter !== 'groups' ? (
            <>
              {' '}
              <Link to="/inbox?filter=groups">
                {filter === 'unread'
                  ? 'Browse all group texts (read and unread)'
                  : 'See all group texts'}
              </Link>
            </>
          ) : null}
        </p>
      ) : null}

      {inbox.status === 'loading' ? <Spinner center /> : null}

      {inbox.status === 'error' ? (
        <div className={styles.error} role="alert">
          <p>We couldn&apos;t load your inbox.</p>
          <button type="button" className={styles.retry} onClick={() => inbox.retry()}>
            Retry
          </button>
        </div>
      ) : null}

      {inbox.status === 'pending' ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>The inbox turns on with its backend</p>
          <p className={styles.emptyBody}>This view is wired and will fill in once the feed ships.</p>
        </div>
      ) : null}

      {inbox.status === 'ready' && inbox.rows.length === 0 ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>{empty.title}</p>
          <p className={styles.emptyBody}>{empty.body}</p>
        </div>
      ) : null}

      {inbox.status === 'ready' && inbox.rows.length > 0 ? (
        <>
          <ul className={styles.rows} aria-label="Conversations">
            {inbox.rows.map((row) => (
              <InboxRow
                key={rowKey(row)}
                row={row}
                onOpen={inbox.markRead}
                onMarkRead={inbox.markRead}
              />
            ))}
          </ul>
          {inbox.hasMore ? (
            <button
              type="button"
              className={styles.loadMore}
              onClick={() => inbox.loadMore()}
              disabled={inbox.loadingMore}
            >
              {inbox.loadingMore ? 'Loading…' : 'Load more'}
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
