// Inbox — the entity-centric communications hub (§2026-06-17-inbox-design). One
// row per contact (or untriaged unknown number), newest-activity-first, with All
// (default) / Unread / Unknown / Assigned-to-me filters. Opening a row navigates
// to the contact page AND marks its comms read (optimistic). Degrades to an
// honest pending state until the C8 backend lands. New design language (tokens +
// CSS Modules); state-sync handled in useInbox.
import { useState } from 'react';
import type { InboxFilter } from '../../api/index.js';
import { Spinner } from '../../ui/index.js';
import { useAuth } from '../../app/AuthContext.js';
import { INBOX_FILTERS, emptyCopy } from './inboxFilters.js';
import { InboxRow } from './InboxRow.js';
import { rowKey, useInbox } from './useInbox.js';
import styles from './Inbox.module.css';

export function Inbox(): React.JSX.Element {
  const [filter, setFilter] = useState<InboxFilter>('all');
  const { me } = useAuth();
  const inbox = useInbox(filter);
  const empty = emptyCopy(filter);

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
            onClick={() => setFilter(tab.filter)}
          >
            {tab.label}
          </button>
        ))}
      </div>

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
                currentUserId={me?.userId}
                currentUserName={me?.email ?? 'You'}
                onOpen={inbox.markRead}
                onMarkRead={inbox.markRead}
                onAssign={inbox.assign}
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
