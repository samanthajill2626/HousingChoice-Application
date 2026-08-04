// TourConversation - the tour page's LEFT pane: a three-channel switcher (Group
// text / Tenant 1:1 / Landlord-or-PM 1:1). All three tabs always render; the
// initial tab is Group when the tour already has a group thread, else Tenant, and
// it NEVER auto-switches after load (only a user click moves it).
//
// The two 1:1 tabs are the SHARED person-centric comms pane (ContactCommsTab ->
// ContactCommsPane, the same component the contact page renders), not a
// single-conversation relay transcript: they show the PERSON's whole feed - every
// number's thread, email, calls and the lifecycle pins the server writes - and
// they own reply-target resolution, create-on-demand sending, retry, the
// just-in-time consent gate and the deleted-contact composer lock. The GROUP tab
// stays a relay transcript (useRelayThread + roster + closed state) with THIS
// tour's milestones interleaved.
//
// Unread + mark-read follow the same split: a tab's dot is its channel's unread,
// and viewing it marks read through the channels hook - the group by its SINGLE
// conversation (markConversationRead), a 1:1 by the PERSON (the contact-wide
// inbox fan-out, contact-page parity).
//
// The active tab lazily mounts ONE pane: only the active channel fetches (we
// never fetch all three up front). Empty states render in place: the group offers
// [Open group text]; a 1:1 whose contact is unresolved says so (the pane requires
// a LOADED Contact), and a contact with no thread yet gets a live composer that
// creates the conversation on the first send.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  getConversation,
  getConversationMembers,
  sendMessage,
  type Contact,
  type ConversationParticipant,
  type TimelineItem,
  type TimelineMilestone,
  type Tour,
} from '../../api/index.js';
import { Button } from '../../ui/index.js';
import { Timeline } from '../contact/Timeline.js';
import { ContactCommsTab } from '../contact/ContactCommsTab.js';
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
  /** THIS tour's lifecycle events as shared-Timeline milestone pins (oldest ->
   *  newest), interleaved into the GROUP transcript so it shows tour activity,
   *  not just comms. The 1:1 tabs get their pins from the PERSON feed instead
   *  (the server writes them per-party), so nothing is injected there. */
  tourMilestones?: TimelineMilestone[];
  /** "Send no-show check-in" from the tour header: when nonce bumps to a new
   *  positive value, switch to the Tenant tab and PREFILL its composer with body
   *  (the editable no_show_checkin template). The tenant pane is remounted so the
   *  seed lands via the Timeline initialDraft initializer. */
  noShowDraft?: { body: string; nonce: number };
}

/** A pane's stream: its messages + the tour milestone pins, oldest→newest. Both
 *  inputs are already sorted; a plain merge-sort by `at` keeps ties stable
 *  (messages first — the sort is stable and messages come first in the input). */
function withMilestones(
  items: TimelineItem[],
  milestones: TimelineMilestone[] | undefined,
): TimelineItem[] {
  if (milestones === undefined || milestones.length === 0) return items;
  return [...items, ...milestones].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
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
  tourMilestones,
  noShowDraft,
}: TourConversationProps): React.JSX.Element {
  // Initial tab decided ONCE from the tour at first render; never re-synced.
  const [activeKey, setActiveKey] = useState<TourChannelKey>(
    tour.groupThreadId ? 'group' : 'tenant',
  );

  // "Send no-show check-in" seed: on a new nonce we (1) select the Tenant tab and
  // (2) hand seededBody to the tenant pane, bumping seedKey to REMOUNT it so the
  // Timeline initialDraft initializer picks up the copy. seededBody is cleared
  // once the pane reports it consumed the seed (onDraftSeeded), so a later manual
  // switch back to Tenant starts with an empty composer.
  const [seededBody, setSeededBody] = useState<string | null>(null);
  const [seedKey, setSeedKey] = useState(0);
  const lastSeedNonce = useRef(0);
  useEffect(() => {
    const nonce = noShowDraft?.nonce ?? 0;
    if (nonce > 0 && nonce !== lastSeedNonce.current) {
      lastSeedNonce.current = nonce;
      setActiveKey('tenant');
      setSeededBody(noShowDraft?.body ?? '');
      setSeedKey((k) => k + 1);
    }
  }, [noShowDraft?.nonce, noShowDraft?.body]);

  // ONE "Comms only" filter per page visit, shared by BOTH 1:1 tabs and held
  // ABOVE their keyed remount. Timeline's own copy is per-mount state, so without
  // this the filter would reset on every tab switch and every seed nonce - and a
  // pin-heavy person feed is exactly where an operator reaches for it (spec A-M2).
  const [commsOnly, setCommsOnly] = useState(false);

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
  const oneToOneKey: 'tenant' | 'landlord' = activeKey === 'landlord' ? 'landlord' : 'tenant';
  const oneToOneContactId = activeKey === 'landlord' ? landlordId : tour.tenantId;
  const oneToOneName = activeKey === 'landlord' ? landlordName : tenantName;
  // The pane needs a LOADED Contact - it derives the numbers, addresses and the
  // deleted / opted-out send gates from it, so an id alone is not enough.
  const oneToOneContact = activeKey === 'landlord' ? landlord : tenant;
  // Two ways it can be missing, and they are different facts: the unit has no
  // landlordId at all (nothing to load), or the page's best-effort getContact
  // failed. Say which - a bare "no messages yet" would be a lie.
  const oneToOneMissingNote =
    oneToOneContactId === undefined
      ? 'The landlord for this property is not resolved yet.'
      : `We could not load ${oneToOneName}'s contact record.`;

  // The no-show check-in seed reaches the TENANT 1:1 composer ONLY: guarded by
  // isTenantChannel so the landlord/PM pane never receives it (its key carries no
  // seedKey, so a bump cannot remount it), and cleared to undefined once consumed
  // (seededBody null) so a later Tenant remount is empty.
  const isTenantChannel = oneToOneKey === 'tenant';
  const tenantSeed = isTenantChannel && seededBody !== null ? seededBody : undefined;

  // Viewing a tab marks it read + clears the tab dot. Runs on the initial tab and
  // every switch; re-runs when the active channel resolves an id or gains unread.
  // The GROUP tab reads its SINGLE conversation; a 1:1 tab reads the PERSON (the
  // contact-wide inbox fan-out), so it needs no conversationId at all. We pass the
  // active channel's CURRENT values as ARGUMENTS (rather than have the hook read a
  // ref) so the INITIAL active tab marks read on the loading->ready commit: a ref
  // would be written by a parent effect that runs AFTER this child effect, so it
  // would still be stale here. Both marks no-op at unread 0, so this never loops.
  const groupConversationId = channels.group.conversationId;
  const activeUnread = channels[activeKey].unread;
  useEffect(() => {
    if (activeKey === 'group') {
      channels.markGroupRead(groupConversationId, activeUnread);
      return;
    }
    channels.markPersonRead(activeKey, oneToOneContactId, activeUnread);
  }, [activeKey, oneToOneContactId, groupConversationId, activeUnread, channels]);

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
          groupConversationId !== null ? (
            <GroupChannel
              conversationId={groupConversationId}
              {...(tourMilestones !== undefined && { tourMilestones })}
            />
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
        ) : oneToOneContact === null ? (
          <div className={styles.channelEmpty}>
            <p className={styles.emptyNote}>{oneToOneMissingNote}</p>
          </div>
        ) : (
          // key so switching the Tenant<->Landlord 1:1 REMOUNTS a fresh pane. Both
          // tabs render <ContactCommsTab> at the same JSX position; without a key
          // React reuses the fiber and the composer's in-progress draft survives
          // the switch, so a Send would post it to the newly-selected party.
          // The TENANT key also carries seedKey: initialDraft is a MOUNT-ONLY
          // initializer, so a "Send no-show check-in" fired while ALREADY on the
          // Tenant tab has to remount the pane to land (spec M1). The landlord key
          // is the contactId alone - no seed ever reaches it.
          <ContactCommsTab
            key={isTenantChannel ? `${tour.tenantId}:${seedKey}` : oneToOneContact.contactId}
            contact={oneToOneContact}
            emptyLabel={`No messages with ${oneToOneName} yet`}
            {...(tenantSeed !== undefined && { initialDraft: tenantSeed })}
            onDraftSeeded={() => setSeededBody(null)}
            commsOnly={commsOnly}
            onCommsOnlyChange={setCommsOnly}
          />
        )}
      </div>
    </div>
  );
}

/** The group-text transcript: the relay thread + roster + closed state, mirroring
 *  ConversationDetail's left pane. Sending is hard-disabled when the group is
 *  closed. Mounts only while the Group tab is active (lazy fetch). */
function GroupChannel({
  conversationId,
  tourMilestones,
}: {
  conversationId: string;
  tourMilestones?: TimelineMilestone[];
}): React.JSX.Element {
  const thread = useRelayThread(conversationId);
  const items = useMemo(
    () => withMilestones(thread.items, tourMilestones),
    [thread.items, tourMilestones],
  );
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
  const onSend = (
    body: string,
    attachmentKeys?: string[],
    attachmentOriginalKeys?: string[],
  ): Promise<void> => {
    const tempId = thread.addOptimistic(conversationId, body, undefined, attachmentKeys);
    return sendMessage(conversationId, {
      body,
      ...(attachmentKeys !== undefined && attachmentKeys.length > 0 && { attachmentKeys }),
      ...(attachmentOriginalKeys !== undefined &&
        attachmentOriginalKeys.length > 0 && { attachmentOriginalKeys }),
    })
      .then((result) => thread.resolveOptimistic(tempId, result))
      .catch((err: unknown) => {
        thread.failOptimistic(tempId);
        throw err;
      });
  };

  return (
    <Timeline
      status={thread.status}
      items={items}
      upcoming={thread.upcoming}
      source="server"
      canSend={canSend}
      {...(canSend && { onSend })}
      relayRoster={members}
      relayClosed={closed}
      resetScrollKey={conversationId}
    />
  );
}
