// OWNED BY FEATURE AGENT 1.
//
// Route: '/' (authenticated). The conversation INBOX: the paged list of
// ConversationSummary rows (newest activity first), live-updated via the SSE
// stream, with unread badges, assignment, opt-out, and the honest-identity
// triage state (type 'unknown_1to1') surfaced — never a faked name/type.
// Tapping a row navigates to /conversations/:id.
//
// Private components/hooks/styles live in src/routes/inbox/.
import { Button, EmptyState, InboxIcon, PlusIcon, Spinner } from '../ui/index.js';
import { useEventStream } from '../api/index.js';
import { useAuth } from '../app/AuthContext.js';
import { ConversationRow } from './inbox/ConversationRow.js';
import { useInbox } from './inbox/useInbox.js';
import styles from './inbox/Inbox.module.css';

export default function Inbox(): React.JSX.Element {
  const { status } = useAuth();
  const { conversations, loading, error, retry, hasMore, loadingMore, loadMore, applyUpdate } =
    useInbox();

  // Live updates: keep rows fresh (patch-in-place for known threads; coalesced
  // first-page refetch for unknown ones — see useInbox).
  // M2: only stream while authenticated. This screen already renders only when
  // authenticated, but gating explicitly means a mid-session expiry stops the
  // EventSource reconnect loop (no retry storm against a 401'd /api/events).
  useEventStream({ onConversationUpdated: applyUpdate, enabled: status === 'authenticated' });

  return (
    <section className={styles.screen} aria-labelledby="inbox-heading">
      <div className={styles.headerRow}>
        <h1 id="inbox-heading" className={styles.heading}>
          Inbox
        </h1>
        <Button as="a" href="/relay-groups/new" size="sm">
          <PlusIcon size={16} />
          New relay group
        </Button>
      </div>

      {loading ? (
        <Spinner center label="Loading conversations" />
      ) : error ? (
        <EmptyState
          icon={<InboxIcon size={28} />}
          title="Couldn't load conversations"
          description="Something went wrong reaching the server."
          action={
            <Button variant="secondary" onClick={retry}>
              Try again
            </Button>
          }
        />
      ) : conversations.length === 0 ? (
        <EmptyState
          icon={<InboxIcon size={28} />}
          title="No conversations yet"
          description="New SMS threads will show up here as they come in."
        />
      ) : (
        <>
          <ul className={styles.list} aria-label="Conversations">
            {conversations.map((c) => (
              <ConversationRow key={c.conversationId} conversation={c} />
            ))}
          </ul>

          {hasMore && (
            <div className={styles.loadMore}>
              <Button
                variant="secondary"
                block
                loading={loadingMore}
                onClick={loadMore}
              >
                Load more
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
