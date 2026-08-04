// PlacementConversation - the placement page's LEFT pane: a three-channel switcher
// (Group text / Tenant 1:1 / Landlord 1:1). Structural mirror of
// tours/TourConversation.tsx. All three tabs always render; the initial tab is
// Group when the placement already has a group thread, else Tenant, and it NEVER
// auto-switches after load (only a user click moves it).
//
// The two 1:1 tabs are the SHARED person-centric comms pane (ContactCommsTab ->
// ContactCommsPane, the same component the contact page renders), not a
// single-conversation relay transcript: they show the PERSON's whole feed - every
// number's thread, email, calls and the lifecycle pins the server writes - and
// they own reply-target resolution, create-on-demand sending, retry, the
// just-in-time consent gate and the deleted-contact composer lock. The GROUP tab
// stays a relay transcript (useRelayThread + roster + closed state).
//
// Unread + mark-read follow the same split: a tab's dot is its channel's unread,
// and viewing it marks read through the channels hook - the group by its SINGLE
// conversation (markConversationRead), a 1:1 by the PERSON (the contact-wide
// inbox fan-out, contact-page parity). The 1:1 fan-out only fires when the
// operator can actually see the pane (commsVisible + a loaded contact + a
// foreground tab) - see the mark-read effect for why.
//
// The active tab lazily mounts ONE pane: only the active channel fetches (we
// never fetch all three up front). Empty states render in place: the group offers
// [Open group text] (which provisions the masked relay via
// provisionPlacementRelay and mounts the fresh thread at once); a 1:1 whose
// contact is unresolved says so (the pane requires a LOADED Contact), and a
// contact with no thread yet gets a live composer that creates the conversation
// on the first send.
//
// Differences from the tour template, and ONLY these: the channel SOURCES are
// placement.* (group = placement.group_thread; tenant = placement.tenantId;
// landlord = unit.landlordId, derived HERE rather than passed as a prop); there
// is no pm_team label branch (labels are exactly Group text / Tenant - {first} /
// Landlord - {first}); the group empty-state button provisions the relay
// INTERNALLY (provisionPlacementRelay -> setGroupConversationId) rather than
// delegating to a parent onOpenGroup; there is no no-show check-in seed; and no
// milestones are interleaved on ANY tab (the group transcript renders its thread
// items raw). A placement has no `status` field, so the group "dead" guard keys
// on TERMINAL_STAGES (moved_in / lost) instead of tour.status.
import { useEffect, useState } from 'react';
import {
  getConversation,
  getConversationMembers,
  provisionPlacementRelay,
  sendMessage,
  STAGE_LABELS,
  TERMINAL_STAGES,
  type Contact,
  type ConversationParticipant,
  type PlacementItem,
  type UnitItem,
} from '../../api/index.js';
import { Button } from '../../ui/index.js';
import { Timeline } from '../contact/Timeline.js';
import { ContactCommsTab } from '../contact/ContactCommsTab.js';
import { contactDisplayName } from '../contact/format.js';
import { useRelayThread } from '../conversation/useRelayThread.js';
import { type PlacementChannelKey, type PlacementChannelsState } from './usePlacementChannels.js';
// Reuse the tour page's comms CSS verbatim (scoped CSS module, tokens only) - the
// pill rail / pane / empty-state styling is identical for both hubs.
import styles from '../tours/TourDetail.module.css';

export interface PlacementConversationProps {
  placement: PlacementItem;
  /** The placement's unit - its landlordId is the landlord 1:1 target. */
  unit: UnitItem | null;
  tenant: Contact | null;
  landlord: Contact | null;
  channels: PlacementChannelsState;
  /** Is this pane actually ON SCREEN? The page owns the answer (its Details /
   *  Conversation pane state + the shell breakpoint); we are always MOUNTED, so
   *  we cannot tell. Gates the 1:1 mark-read fan-out only - see the effect. */
  commsVisible: boolean;
}

/** A member's first name, or null when unknown. */
function firstNameOf(c: Contact | null): string | null {
  const f = c?.firstName?.trim();
  return f && f.length > 0 ? f : null;
}

export function PlacementConversation({
  placement,
  unit,
  tenant,
  landlord,
  channels,
  commsVisible,
}: PlacementConversationProps): React.JSX.Element {
  const landlordId = unit?.landlordId;

  // Initial tab decided ONCE from the placement at first render; never re-synced.
  const [activeKey, setActiveKey] = useState<PlacementChannelKey>(
    placement.group_thread ? 'group' : 'tenant',
  );

  // ONE "Comms only" filter per page visit, shared by BOTH 1:1 tabs and held
  // ABOVE their keyed remount. Timeline's own copy is per-mount state, so without
  // this the filter would reset on every tab switch - and a pin-heavy person feed
  // is exactly where an operator reaches for it (spec A-M2).
  const [commsOnly, setCommsOnly] = useState(false);

  const tenantFirst = firstNameOf(tenant);
  const landlordFirst = firstNameOf(landlord);
  const tabs: { key: PlacementChannelKey; label: string; unread: number }[] = [
    { key: 'group', label: 'Group text', unread: channels.group.unread },
    {
      key: 'tenant',
      label: tenantFirst ? `Tenant - ${tenantFirst}` : 'Tenant',
      unread: channels.tenant.unread,
    },
    {
      key: 'landlord',
      label: landlordFirst ? `Landlord - ${landlordFirst}` : 'Landlord',
      unread: channels.landlord.unread,
    },
  ];

  const tenantName = tenant
    ? contactDisplayName(tenant.firstName, tenant.lastName, tenant.phone)
    : 'the tenant';
  const landlordName = landlord
    ? contactDisplayName(landlord.firstName, landlord.lastName, landlord.phone)
    : 'the landlord';

  // A placement has no `status`; a group text cannot be opened once the deal is
  // terminal (moved_in / lost).
  const groupDead = TERMINAL_STAGES.has(placement.stage);
  const oneToOneContactId = activeKey === 'landlord' ? landlordId : placement.tenantId;
  const oneToOneName = activeKey === 'landlord' ? landlordName : tenantName;
  // The pane needs a LOADED Contact - it derives the numbers, addresses and the
  // deleted / opted-out send gates from it, so an id alone is not enough.
  const oneToOneContact = activeKey === 'landlord' ? landlord : tenant;
  // Two ways it can be missing, and they are different facts: the unit is
  // unloaded or has no landlordId at all (nothing to load), or the page's
  // best-effort getContact failed. Say which - a bare "no messages yet" would be
  // a lie.
  const oneToOneMissingNote =
    oneToOneContactId === undefined
      ? 'The landlord for this property is not resolved yet.'
      : `We could not load ${oneToOneName}'s contact record.`;

  // Viewing a tab marks it read + clears the tab dot. Runs on the initial tab and
  // every switch; re-runs when the active channel resolves an id or gains unread.
  // The GROUP tab reads its SINGLE conversation; a 1:1 tab reads the PERSON (the
  // contact-wide inbox fan-out), so it needs no conversationId at all. We pass the
  // active channel's CURRENT values as ARGUMENTS (rather than have the hook read a
  // ref) so the INITIAL active tab marks read on the loading->ready commit: a ref
  // would be written by a parent effect that runs AFTER this child effect, so it
  // would still be stale here. Both marks no-op at unread 0, so this never loops.
  //
  // The 1:1 fan-out carries THREE extra gates, because it is one-way data loss:
  // it clears unread on every thread that person owns and the product has no
  // mark-unread anywhere. "Viewing a 1:1 tab" (spec s5) has to mean the operator
  // could actually SEE it, so we require -
  //   1. commsVisible: at <=860px the shell hides the non-selected pane with
  //      display:none but keeps it MOUNTED, and both hubs open on Details. Merely
  //      landing on /placements/:id from a phone must not consume the tenant's
  //      inbox row; the mark fires when the operator reveals the Conversation pane.
  //   2. oneToOneContact !== null: when the page's best-effort getContact failed
  //      the tab body is a bare "we could not load ..." note - no transcript, no
  //      composer. Nothing was read, so nothing is marked read.
  //   3. document.visibilityState: the contact page's own gate
  //      (useMarkContactRead.ts:22) - a page parked in a BACKGROUND tab must not
  //      silently swallow arriving unreads. Unlike that hook we do NOT re-fire on
  //      visibilitychange: the channels hook's SSE refetch raises unread again
  //      and re-runs this effect, which is the same convergence by another route.
  // DELETED contacts are deliberately NOT gated - useMarkContactRead marks a
  // soft-deleted contact read exactly like any other, and this pane's whole
  // contract is parity with it (spec s5's resurfacing note, pinned in
  // app/test/inboxApi.test.ts).
  // The GROUP branch is untouched: markGroupRead is a single-conversation read
  // that predates this pane, and gating it is out of scope.
  const groupConversationId = channels.group.conversationId;
  const activeUnread = channels[activeKey].unread;
  useEffect(() => {
    if (activeKey === 'group') {
      channels.markGroupRead(groupConversationId, activeUnread);
      return;
    }
    if (!commsVisible) return;
    if (oneToOneContact === null) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    channels.markPersonRead(activeKey, oneToOneContactId, activeUnread);
  }, [
    activeKey,
    oneToOneContactId,
    oneToOneContact,
    commsVisible,
    groupConversationId,
    activeUnread,
    channels,
  ]);

  // Group provisioning lives HERE (not delegated to a parent onOpenGroup like the
  // tour page): [Open group text] calls provisionPlacementRelay, then injects the
  // fresh conversationId so the relay thread mounts immediately.
  const [openGroupBusy, setOpenGroupBusy] = useState(false);
  const [groupError, setGroupError] = useState<string | null>(null);
  function onOpenGroup(): void {
    if (openGroupBusy) return;
    setOpenGroupBusy(true);
    setGroupError(null);
    void provisionPlacementRelay(placement.placementId)
      .then(({ conversationId }) => channels.setGroupConversationId(conversationId))
      .catch(() => setGroupError('Could not open the group text. Please try again.'))
      .finally(() => setOpenGroupBusy(false));
  }

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
            <GroupChannel conversationId={groupConversationId} />
          ) : (
            <div className={styles.channelEmpty}>
              <p className={styles.emptyTitle}>No group text yet</p>
              <p className={styles.emptyNote}>
                Open a masked group text with the tenant and landlord to coordinate this placement.
              </p>
              <Button
                size="sm"
                type="button"
                onClick={onOpenGroup}
                disabled={openGroupBusy || groupDead}
              >
                {openGroupBusy ? 'Opening...' : 'Open group text'}
              </Button>
              {groupError !== null ? <p className={styles.emptyNote}>{groupError}</p> : null}
              {groupDead ? (
                <p className={styles.emptyNote}>
                  This placement is {STAGE_LABELS[placement.stage]} - a group text cannot be opened.
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
          // (No seed nonce rides this key - the placement page has no no-show
          // check-in.)
          <ContactCommsTab
            key={oneToOneContact.contactId}
            contact={oneToOneContact}
            emptyLabel={`No messages with ${oneToOneName} yet`}
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
      items={thread.items}
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
