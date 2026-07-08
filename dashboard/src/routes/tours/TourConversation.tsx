// TourConversation - the tour page's LEFT pane: a three-channel switcher (Group
// text / Tenant 1:1 / Landlord-or-PM 1:1). All three tabs always render; the
// initial tab is Group when the tour already has a group thread, else Tenant, and
// it NEVER auto-switches after load (only a user click moves it). Each tab shows
// an unread dot from its conversation's unread_count; viewing a tab marks that
// SINGLE conversation read (via the channels hook -> markConversationRead, never
// the contact-wide inbox fan-out).
//
// The active tab lazily mounts ONE transcript: only the active conversation's
// useRelayThread fetches (we never fetch all three up front). Transcripts reuse
// the shared <Timeline> + useRelayThread + sendMessage machinery. Empty states
// render in place: the group offers [Open group text]; a 1:1 with no thread yet
// offers a live composer that creates the conversation on the first send.
import { useEffect, useState } from 'react';
import {
  ensureContactConversation,
  getConversation,
  getConversationMembers,
  sendMessage,
  type Contact,
  type ConversationParticipant,
  type Tour,
} from '../../api/index.js';
import { Button } from '../../ui/index.js';
import { Timeline } from '../contact/Timeline.js';
import { contactDisplayName } from '../contact/format.js';
import { useRelayThread } from '../conversation/useRelayThread.js';
import { type TourChannelKey, type TourChannelsState } from './useTourChannels.js';
import styles from './TourDetail.module.css';

export interface TourConversationProps {
  tour: Tour;
  tenant: Contact | null;
  landlord: Contact | null;
  /** The unit's landlordId - the landlord/PM 1:1 target (may be unresolved). */
  landlordId: string | undefined;
  channels: TourChannelsState;
  /** Provision the group thread (shared with the header kebab); errors surface in
   *  the page header banner. */
  onOpenGroup: () => void;
  openGroupBusy: boolean;
}

/** A member's first name, or null when unknown. */
function firstNameOf(c: Contact | null): string | null {
  const f = c?.firstName?.trim();
  return f && f.length > 0 ? f : null;
}

export function TourConversation({
  tour,
  tenant,
  landlord,
  landlordId,
  channels,
  onOpenGroup,
  openGroupBusy,
}: TourConversationProps): React.JSX.Element {
  // Initial tab decided ONCE from the tour at first render; never re-synced.
  const [activeKey, setActiveKey] = useState<TourChannelKey>(
    tour.groupThreadId ? 'group' : 'tenant',
  );

  const active = channels[activeKey];

  // Viewing a tab marks its SINGLE conversation read + clears the tab dot. Runs on
  // the initial tab and every switch; re-runs when the active channel resolves an
  // id or gains unread. We pass the active channel's CURRENT conversationId +
  // unread as ARGUMENTS (rather than have markRead read a ref) so the INITIAL
  // active tab marks read on the loading->ready commit: a ref would be written by
  // a parent effect that runs AFTER this child effect, so it would still be stale
  // here. markRead no-ops at unread 0, so this never loops.
  useEffect(() => {
    channels.markRead(activeKey, active.conversationId, active.unread);
  }, [activeKey, active.conversationId, active.unread, channels]);

  const isPm = tour.tourType === 'pm_team';
  const tenantFirst = firstNameOf(tenant);
  const landlordFirst = firstNameOf(landlord);
  const tabs: { key: TourChannelKey; label: string; unread: number }[] = [
    { key: 'group', label: 'Group text', unread: channels.group.unread },
    {
      key: 'tenant',
      label: tenantFirst ? `Tenant - ${tenantFirst}` : 'Tenant',
      unread: channels.tenant.unread,
    },
    {
      key: 'landlord',
      label: isPm
        ? landlordFirst
          ? `PM - ${landlordFirst}`
          : 'PM'
        : landlordFirst
          ? `Landlord - ${landlordFirst}`
          : 'Landlord',
      unread: channels.landlord.unread,
    },
  ];

  const tenantName = tenant
    ? contactDisplayName(tenant.firstName, tenant.lastName, tenant.phone)
    : 'the tenant';
  const landlordName = landlord
    ? contactDisplayName(landlord.firstName, landlord.lastName, landlord.phone)
    : isPm
      ? 'the property manager'
      : 'the landlord';

  const groupDead = tour.status === 'canceled' || tour.status === 'closed';
  const oneToOneContactId = activeKey === 'landlord' ? landlordId : tour.tenantId;
  const oneToOneName = activeKey === 'landlord' ? landlordName : tenantName;
  // The 1:1 composer footer shows WHO the reply sends to (the contact's number,
  // same as the contact page's reply box); the group tab passes none - its
  // composer matches ConversationDetail's group view.
  const oneToOnePhone = activeKey === 'landlord' ? landlord?.phone : tenant?.phone;

  return (
    <div className={styles.convo}>
      <div className={styles.tabRail} role="tablist" aria-label="Conversation channel">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={activeKey === t.key}
            className={activeKey === t.key ? styles.tabOn : styles.tab}
            onClick={() => setActiveKey(t.key)}
          >
            {t.label}
            {t.unread > 0 ? (
              <>
                <span className={styles.dot} aria-hidden="true" />
                <span className={styles.srOnly}> unread</span>
              </>
            ) : null}
          </button>
        ))}
      </div>

      <div className={styles.channelPane}>
        {activeKey === 'group' ? (
          active.conversationId !== null ? (
            <GroupChannel conversationId={active.conversationId} />
          ) : (
            <div className={styles.channelEmpty}>
              <p className={styles.emptyTitle}>No group text yet</p>
              <p className={styles.emptyNote}>
                Open a masked group text with the tenant and landlord to coordinate the visit.
              </p>
              <Button
                size="sm"
                type="button"
                onClick={onOpenGroup}
                disabled={openGroupBusy || groupDead}
              >
                {openGroupBusy ? 'Opening...' : 'Open group text'}
              </Button>
              {groupDead ? (
                <p className={styles.emptyNote}>
                  This tour is {tour.status} - a group text cannot be opened.
                </p>
              ) : null}
            </div>
          )
        ) : oneToOneContactId === undefined ? (
          <div className={styles.channelEmpty}>
            <p className={styles.emptyNote}>
              The landlord for this property is not resolved yet.
            </p>
          </div>
        ) : active.conversationId !== null ? (
          // key by conversation identity so switching the Tenant<->Landlord 1:1
          // REMOUNTS a fresh Timeline. Both tabs render <ContactThread> at the same
          // JSX position; without a key React reuses the fiber and Timeline's
          // in-progress draft survives the switch, so a Send would post it to the
          // newly-selected party. Also clears the stale-transcript flash (MINOR 3).
          <ContactThread
            key={active.conversationId}
            conversationId={active.conversationId}
            {...(oneToOnePhone !== undefined && { replyToPhone: oneToOnePhone })}
          />
        ) : (
          // key by channel so a create-on-demand Tenant/Landlord tab also remounts
          // on switch (conversationId is null here, so it cannot key the pane).
          <NewContactThread
            key={activeKey}
            contactId={oneToOneContactId}
            name={oneToOneName}
            {...(oneToOnePhone !== undefined && { replyToPhone: oneToOnePhone })}
            onCreated={(id) => channels.setConversationId(activeKey, id)}
          />
        )}
      </div>
    </div>
  );
}

/** The group-text transcript: the relay thread + roster + closed state, mirroring
 *  ConversationDetail's left pane. Sending is hard-disabled when the group is
 *  closed. Mounts only while the Group tab is active (lazy fetch). */
function GroupChannel({ conversationId }: { conversationId: string }): React.JSX.Element {
  const thread = useRelayThread(conversationId);
  const [members, setMembers] = useState<ConversationParticipant[]>([]);
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    void getConversation(conversationId, ac.signal)
      .then((h) => setClosed(h.status === 'closed'))
      .catch(() => {
        /* header best-effort - default to open */
      });
    void getConversationMembers(conversationId, ac.signal)
      .then(setMembers)
      .catch(() => {
        /* roster best-effort - attribution degrades, transcript still renders */
      });
    return () => ac.abort();
  }, [conversationId]);

  const canSend = !closed;
  const onSend = (body: string): Promise<void> => {
    const tempId = thread.addOptimistic(conversationId, body);
    return sendMessage(conversationId, { body })
      .then((result) => thread.resolveOptimistic(tempId, result))
      .catch((err: unknown) => {
        thread.failOptimistic(tempId);
        throw err;
      });
  };

  return (
    <Timeline
      status={thread.status}
      items={thread.items}
      source="server"
      canSend={canSend}
      {...(canSend && { onSend })}
      relayRoster={members}
      relayClosed={closed}
      resetScrollKey={conversationId}
    />
  );
}

/** A 1:1 transcript for an EXISTING conversation. Optimistic send via the shared
 *  relay-thread trio. Mounts only while its tab is active (lazy fetch). */
function ContactThread({
  conversationId,
  replyToPhone,
}: {
  conversationId: string;
  /** The contact's number, shown in the composer footer ("Reply sends to ..."). */
  replyToPhone?: string;
}): React.JSX.Element {
  const thread = useRelayThread(conversationId);
  const onSend = (body: string): Promise<void> => {
    const tempId = thread.addOptimistic(conversationId, body);
    return sendMessage(conversationId, { body })
      .then((result) => thread.resolveOptimistic(tempId, result))
      .catch((err: unknown) => {
        thread.failOptimistic(tempId);
        throw err;
      });
  };
  return (
    <Timeline
      status={thread.status}
      items={thread.items}
      source="server"
      canSend
      onSend={onSend}
      {...(replyToPhone !== undefined && { replyToPhone })}
      resetScrollKey={conversationId}
    />
  );
}

/** A 1:1 with NO thread yet: an empty stream + a live composer. The first send
 *  creates-or-gets the contact's conversation, sends into it, then reports the
 *  new id so the parent swaps in the real ContactThread. */
function NewContactThread({
  contactId,
  name,
  replyToPhone,
  onCreated,
}: {
  contactId: string;
  name: string;
  /** The contact's number, shown in the composer footer ("Reply sends to ..."). */
  replyToPhone?: string;
  onCreated: (conversationId: string) => void;
}): React.JSX.Element {
  const onSend = async (body: string): Promise<void> => {
    const conversationId = await ensureContactConversation(contactId);
    await sendMessage(conversationId, { body });
    onCreated(conversationId);
  };
  return (
    <Timeline
      status="ready"
      items={[]}
      source="server"
      canSend
      onSend={onSend}
      {...(replyToPhone !== undefined && { replyToPhone })}
      emptyLabel={`No messages with ${name} yet`}
      resetScrollKey={`new:${contactId}`}
    />
  );
}
