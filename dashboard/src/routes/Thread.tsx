// OWNED BY FEATURE AGENT 2 — the THREAD view (route '/conversations/:id').
//
// Composes the conversation header (identity + assignment + the M1.9 "Call
// instead" affordance), the live message timeline (DeliveryBadge per outbound
// message, "sent ≠ delivered", inline Retry on failures), the optimistic
// composer (opt-out / refusal handling), the contact side panel + needs-review
// triage, mark-read on open/focus, and SSE live updates. Built ENTIRELY on the
// shared foundation (src/api, src/ui) + this folder's private components.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ApiError,
  getConversation,
  markRead,
  setAssignment,
  useApi,
  useEventStream,
  type Contact,
  type ConversationUpdatedEvent,
  type Message,
  type MessagePersistedEvent,
} from '../api';
import { Button, EmptyState, Sheet, Spinner, useToast } from '../ui';
import { ThreadHeader } from './thread/ThreadHeader';
import { MessageList } from './thread/MessageList';
import { SendBox } from './thread/SendBox';
import { ContactPanel } from './thread/ContactPanel';
import { useThreadMessages } from './thread/useThreadMessages';
import { resolveIdentity } from './thread/identity';
import { useAuth } from '../app/AuthContext';
import styles from './Thread.module.css';

export default function Thread(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const conversationId = id ?? '';
  const navigate = useNavigate();
  const toast = useToast();
  const { me } = useAuth();

  // --- Conversation header (refetchable so triage type-flips reflect) --------
  const {
    data: conversation,
    loading: convLoading,
    error: convError,
    refetch: refetchConversation,
  } = useApi((signal) => getConversation(conversationId, signal), [conversationId]);

  // --- Message timeline ------------------------------------------------------
  const timeline = useThreadMessages(conversationId);

  // --- Contact (side panel) --------------------------------------------------
  const contactId = conversation?.participants?.[0]?.contactId;
  const identity = useMemo(
    () => resolveIdentity(conversation, undefined),
    [conversation],
  );

  // --- Mark read on open + on window focus -----------------------------------
  const markReadRef = useRef(false);
  const doMarkRead = useCallback(() => {
    if (conversationId.length === 0) return;
    markRead(conversationId).catch(() => {
      // Non-fatal: the unread badge will clear on the next successful read.
    });
  }, [conversationId]);

  useEffect(() => {
    // Once messages have loaded for this conversation, mark it read.
    if (!timeline.loading && !markReadRef.current && conversationId.length > 0) {
      markReadRef.current = true;
      doMarkRead();
    }
  }, [timeline.loading, conversationId, doMarkRead]);

  useEffect(() => {
    markReadRef.current = false;
  }, [conversationId]);

  useEffect(() => {
    const onFocus = (): void => doMarkRead();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [doMarkRead]);

  // --- Live updates (SSE) ----------------------------------------------------
  const onMessagePersisted = useCallback(
    (event: MessagePersistedEvent) => {
      if (event.conversationId !== conversationId) return;
      timeline.ingestEvent(event);
    },
    [conversationId, timeline],
  );

  const onConversationUpdated = useCallback(
    (event: ConversationUpdatedEvent) => {
      if (event.conversationId !== conversationId) return;
      // Header/assignment/type may have changed — refetch the header.
      refetchConversation();
    },
    [conversationId, refetchConversation],
  );

  useEventStream({ onMessagePersisted, onConversationUpdated });

  // --- Assignment ------------------------------------------------------------
  const [assigning, setAssigning] = useState(false);
  const handleSetAssignment = useCallback(
    (assigneeUserId: string | null) => {
      if (conversationId.length === 0) return;
      setAssigning(true);
      setAssignment(conversationId, assigneeUserId)
        .then(() => {
          toast.success(assigneeUserId ? 'Assigned to you' : 'Unassigned');
          refetchConversation();
        })
        .catch((err: unknown) => {
          const msg = err instanceof ApiError ? err.message : 'Could not update assignment';
          toast.error(msg);
        })
        .finally(() => setAssigning(false));
    },
    [conversationId, toast, refetchConversation],
  );

  // --- Retry (re-send a failed message's body) -------------------------------
  const [retryingId, setRetryingId] = useState<string | undefined>(undefined);
  const handleRetry = useCallback(
    (message: Message) => {
      setRetryingId(message.tsMsgId);
      timeline
        .retry(message)
        .catch((err: unknown) => {
          const msg = err instanceof ApiError ? err.message : 'Retry failed';
          toast.error(msg);
        })
        .finally(() => setRetryingId(undefined));
    },
    [timeline, toast],
  );

  // --- Contact panel (Sheet on mobile) ---------------------------------------
  const [sheetOpen, setSheetOpen] = useState(false);
  const handleContactResolved = useCallback(
    (_updated: Contact): void => {
      void _updated;
      // The backend may have flipped the conversation type (unknown_1to1 →
      // tenant/landlord_1to1) — refetch so the header badge + "needs review"
      // cue update. Close the mobile sheet.
      refetchConversation();
      setSheetOpen(false);
    },
    [refetchConversation],
  );

  // --- Render states ---------------------------------------------------------
  if (convLoading && conversation === undefined) {
    return (
      <section className={styles.thread}>
        <Spinner center label="Loading conversation" />
      </section>
    );
  }

  if (convError) {
    const notFound = convError.status === 404;
    return (
      <section className={styles.thread}>
        <EmptyState
          title={notFound ? 'Conversation not found' : "Couldn't load this conversation"}
          description={
            notFound
              ? 'This conversation may have been removed.'
              : 'Something went wrong loading the thread.'
          }
          action={
            <Button variant="secondary" onClick={() => navigate('/')}>
              Back to inbox
            </Button>
          }
        />
      </section>
    );
  }

  const optedOut = conversation?.sms_opt_out === true;
  const meUserId = me?.userId ?? '';

  // The timeline is "empty" only once it has loaded with no messages.
  const showEmptyTimeline = !timeline.loading && timeline.messages.length === 0 && !timeline.error;

  return (
    <section className={styles.thread}>
      <ThreadHeader
        conversation={conversation}
        identity={identity}
        meUserId={meUserId}
        onSetAssignment={handleSetAssignment}
        assigning={assigning}
        onOpenContact={() => setSheetOpen(true)}
        onBack={() => navigate('/')}
      />

      <div className={styles.body}>
        <div className={styles.main}>
          {timeline.loading ? (
            <div className={styles.timelineFill}>
              <Spinner center label="Loading messages" />
            </div>
          ) : timeline.error ? (
            <div className={styles.timelineFill}>
              <EmptyState
                title="Couldn't load messages"
                description="The message history is unavailable right now."
              />
            </div>
          ) : showEmptyTimeline ? (
            <div className={styles.timelineFill}>
              <EmptyState
                title="No messages yet"
                description="Send the first message to start this conversation."
              />
            </div>
          ) : (
            <MessageList
              messages={timeline.messages}
              hasMore={timeline.hasMore}
              loadingOlder={timeline.loadingOlder}
              onLoadOlder={timeline.loadOlder}
              onRetry={handleRetry}
              {...(retryingId !== undefined && { retryingId })}
            />
          )}

          <SendBox onSend={timeline.send} optedOut={optedOut} />
        </div>

        {/* Side column on wide screens. */}
        <aside className={styles.side}>
          <ContactPanel contactId={contactId} onResolved={handleContactResolved} />
        </aside>
      </div>

      {/* Bottom sheet on mobile. */}
      <Sheet open={sheetOpen} onClose={() => setSheetOpen(false)} title="Contact">
        <ContactPanel contactId={contactId} onResolved={handleContactResolved} />
      </Sheet>
    </section>
  );
}
