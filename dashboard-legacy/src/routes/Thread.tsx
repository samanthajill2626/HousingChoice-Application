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
  getContact,
  getConversation,
  markRead,
  setAssignment,
  setRelayClosed,
  useApi,
  useEventStream,
  type Contact,
  type ConversationUpdatedEvent,
  type Message,
  type MessagePersistedEvent,
} from '../api';
import { Button, EmptyState, Sheet, Spinner, useToast } from '../ui';
import { ThreadHeader } from './thread/ThreadHeader';
import { RelayThreadHeader } from './thread/RelayThreadHeader';
import { MessageList } from './thread/MessageList';
import { SendBox } from './thread/SendBox';
import { ContactPanel } from './thread/ContactPanel';
import { RelayMembersList } from './thread/RelayMembersList';
import { ClosedThreadBanner } from './thread/ClosedThreadBanner';
import { useThreadMessages } from './thread/useThreadMessages';
import { useRelayMembers } from './thread/useRelayMembers';
import { resolveIdentity } from './thread/identity';
import { useAuth } from '../app/AuthContext';
import styles from './Thread.module.css';

export default function Thread(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const conversationId = id ?? '';
  const navigate = useNavigate();
  const toast = useToast();
  const { me, status: authStatus } = useAuth();

  // --- Conversation header (refetchable so triage type-flips reflect) --------
  const {
    data: conversation,
    loading: convLoading,
    error: convError,
    refetch: refetchConversation,
  } = useApi((signal) => getConversation(conversationId, signal), [conversationId]);

  // --- Relay group (M1.7) ----------------------------------------------------
  // Detect a relay_group thread and switch to the relay surface (group header +
  // members panel + per-recipient delivery + closed banner). 1:1 behavior is
  // untouched (isRelay false → every relay branch below is skipped).
  const isRelay = conversation?.type === 'relay_group';
  const relayClosed = isRelay && conversation?.status === 'closed';
  const relay = useRelayMembers(conversationId, isRelay);

  // --- Message timeline ------------------------------------------------------
  const timeline = useThreadMessages(conversationId);

  // --- Contact (side panel) --------------------------------------------------
  // H1: the contact is fetched HERE (lifted up) so the header identity can show
  // the real name post-triage — not just in the side panel. ContactPanel
  // receives the fetched contact + refetch as props (it no longer fetches).
  // A relay_group has a multi-member roster, not a single 1:1 contact — so we do
  // NOT fetch a contact for it (the roster panel replaces the contact panel).
  const contactId = isRelay ? undefined : conversation?.participants?.[0]?.contactId;
  const {
    data: contact,
    loading: contactLoading,
    error: contactError,
    refetch: refetchContact,
  } = useApi<Contact>(
    (signal) => {
      if (contactId === undefined) return Promise.reject(new ApiError(0, 'no_contact', 'no contact'));
      return getContact(contactId, signal);
    },
    [contactId],
  );

  const identity = useMemo(
    // Feed the resolved contact so a triaged tenant/landlord shows their real
    // name and the "needs review" cue clears; unknown/needs_review still shows
    // the phone (resolveIdentity never fabricates a name).
    () => resolveIdentity(conversation, contact),
    [conversation, contact],
  );

  // --- Mark read on open + on window focus -----------------------------------
  // M3: don't POST /read when the thread is already read. The on-open mark-read
  // fires once per conversation (markReadRef latch); the focus handler only
  // re-marks when there is actually unread AND the on-open pass has completed
  // (so the two don't race a redundant double-POST on the same open+focus).
  const markReadRef = useRef(false);
  // Latest unread_count, read inside the focus handler without re-subscribing.
  const unreadRef = useRef(0);
  unreadRef.current = conversation?.unread_count ?? 0;

  // F: a short-lived latch so THIS client's own markRead (which the backend
  // echoes back as a conversation.updated with unread_count 0) doesn't trigger a
  // redundant self-refetch. We only suppress when our markRead actually drove
  // unread → 0; the echo (unread_count 0) consumes the latch exactly once. Other
  // dashboards still need unread→0 events, so we do NOT blanket-skip them.
  const selfReadEchoRef = useRef(false);

  const doMarkRead = useCallback(() => {
    if (conversationId.length === 0) return;
    // Only arm the self-echo latch when there is actually unread to clear (an
    // already-read mark-read produces no unread→0 transition to echo).
    if (unreadRef.current > 0) selfReadEchoRef.current = true;
    markRead(conversationId).catch(() => {
      // Non-fatal: the unread badge will clear on the next successful read.
      selfReadEchoRef.current = false;
    });
  }, [conversationId]);

  useEffect(() => {
    // Once messages have loaded for this conversation, mark it read (once).
    if (!timeline.loading && !markReadRef.current && conversationId.length > 0) {
      markReadRef.current = true;
      doMarkRead();
    }
  }, [timeline.loading, conversationId, doMarkRead]);

  useEffect(() => {
    markReadRef.current = false;
    selfReadEchoRef.current = false;
  }, [conversationId]);

  useEffect(() => {
    const onFocus = (): void => {
      // Only re-mark on focus if the on-open pass ran AND there is unread —
      // avoids racing the on-open mark-read and refiring /read when already read.
      if (markReadRef.current && unreadRef.current > 0) doMarkRead();
    };
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
      // Relay (M1.7): the event carries the live roster — apply it in place so a
      // member add/remove reflects WITHOUT a /members refetch. (Status + pool
      // number live on the conversation header, refetched just below.)
      if (event.members != null) {
        relay.ingestRoster(event.members);
      }
      // Skip exactly the self-echo from THIS client's markRead (unread → 0): it
      // carries no header/assignment/type change we don't already have, so the
      // refetch would be redundant. Consume the latch once; any later unread→0
      // (e.g. another dashboard) still refetches.
      if (selfReadEchoRef.current && event.unread_count === 0) {
        selfReadEchoRef.current = false;
        return;
      }
      // Header/assignment/type — and, for a relay, status + pool number — may
      // have changed; refetch the header so the closed/reopen state is live.
      refetchConversation();
    },
    [conversationId, refetchConversation, relay],
  );

  // M2: only stream while authenticated, so a mid-session session expiry stops
  // the EventSource reconnect loop instead of hammering a 401'd /api/events.
  useEventStream({
    onMessagePersisted,
    onConversationUpdated,
    enabled: authStatus === 'authenticated',
  });

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

  // --- Relay close / reopen (M1.7) -------------------------------------------
  const [togglingClosed, setTogglingClosed] = useState(false);
  const handleToggleClosed = useCallback(
    (closed: boolean) => {
      if (conversationId.length === 0) return;
      setTogglingClosed(true);
      setRelayClosed(conversationId, closed)
        .then(() => {
          toast.success(closed ? 'Relay group closed' : 'Relay group reopened');
          // The server emits conversation.updated, but refetch directly too so
          // the header reflects the new status/pool immediately for this client.
          refetchConversation();
        })
        .catch((err: unknown) => {
          const msg =
            err instanceof ApiError
              ? err.code === 'pool_number_unavailable'
                ? 'No phone number is available to reopen — try again shortly.'
                : err.message
              : 'Could not update the relay group';
          toast.error(msg);
        })
        .finally(() => setTogglingClosed(false));
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
      // tenant/landlord_1to1) — refetch the conversation so the header badge
      // updates, AND refetch the contact so the lifted header identity picks up
      // the new name/type. Close the mobile sheet.
      refetchConversation();
      refetchContact();
      setSheetOpen(false);
    },
    [refetchConversation, refetchContact],
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

  // Relay (M1.7): the roster forwarded to the timeline drives bubble attribution
  // + per-recipient delivery chips. Undefined for 1:1 → 1:1 bubbles unchanged.
  const timelineRoster = isRelay ? relay.members : undefined;

  // Relay members panel — shared between the desktop side column and the sheet.
  const relayPanel = (
    <RelayMembersList
      members={relay.members}
      loading={relay.loading}
      error={relay.error}
      closed={Boolean(relayClosed)}
      onAdd={relay.add}
      onRemove={relay.remove}
    />
  );
  // 1:1 contact panel — shared between the desktop side column and the sheet.
  const contactPanel = (
    <ContactPanel
      contactId={contactId}
      contact={contact}
      loading={contactLoading}
      error={contactError}
      onResolved={handleContactResolved}
    />
  );

  return (
    <section className={styles.thread}>
      {isRelay ? (
        <RelayThreadHeader
          conversation={conversation}
          memberCount={relay.members.length}
          toggling={togglingClosed}
          onToggleClosed={handleToggleClosed}
          onOpenMembers={() => setSheetOpen(true)}
          onBack={() => navigate('/')}
        />
      ) : (
        <ThreadHeader
          conversation={conversation}
          identity={identity}
          meUserId={meUserId}
          onSetAssignment={handleSetAssignment}
          assigning={assigning}
          onOpenContact={() => setSheetOpen(true)}
          onBack={() => navigate('/')}
        />
      )}

      {relayClosed && <ClosedThreadBanner />}

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
                description={
                  isRelay
                    ? 'Send the first message to relay it to every member.'
                    : 'Send the first message to start this conversation.'
                }
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
              {...(timelineRoster !== undefined && { roster: timelineRoster })}
            />
          )}

          <SendBox
            onSend={timeline.send}
            optedOut={optedOut}
            {...(relayClosed && {
              disabledNote: 'This relay group is closed — reopen it to send.',
            })}
          />
        </div>

        {/* Side column on wide screens. */}
        <aside className={styles.side}>{isRelay ? relayPanel : contactPanel}</aside>
      </div>

      {/* Bottom sheet on mobile. */}
      <Sheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title={isRelay ? 'Members' : 'Contact'}
      >
        {isRelay ? relayPanel : contactPanel}
      </Sheet>
    </section>
  );
}
