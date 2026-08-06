// PlacementConversation - the placement page's LEFT pane: a channel switcher over
// the group text plus ONE 1:1 tab per person the page put on this placement
// (`channels.people`, keyed by contactId and labelled with that person's DISPLAY
// NAME - no role words). Structural mirror of tours/TourConversation.tsx. The
// initial tab is Group when the placement already has a group thread, else the
// tenant's, and it NEVER auto-switches after load (only a user click moves it) -
// except that a selection pointing at a person who is no longer on the placement
// falls back to Group (spec 6.6).
//
// The 1:1 tabs are the SHARED person-centric comms pane (ContactCommsTab ->
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
// inbox fan-out, contact-page parity). Only the GROUP mark runs here. The 1:1
// fan-out runs inside ContactCommsTab, which gates it on the operator actually
// being able to see the pane (commsVisible + a loaded contact + a READY timeline
// + a foreground browser tab) - see that file's effect for why.
//
// The active tab lazily mounts ONE pane: only the active channel fetches (we
// never fetch every tab up front). Empty states render in place: the group offers
// [Open group text] (which provisions the masked relay via
// provisionPlacementRelay and mounts the fresh thread at once); a 1:1 whose
// contact record failed to load says so (the pane requires a LOADED Contact), and
// a contact with no thread yet gets a live composer that creates the conversation
// on the first send.
//
// Differences from the tour template, and ONLY these: the channel SOURCES are
// placement.* (group = placement.group_thread; the people come from the page);
// the group empty-state button provisions the relay INTERNALLY
// (provisionPlacementRelay -> setGroupConversationId) rather than delegating to a
// parent onOpenGroup; there is no no-show check-in seed; and no milestones are
// interleaved on ANY tab (the group transcript renders its thread items raw). A
// placement has no `status` field, so the group "dead" guard keys on
// TERMINAL_STAGES (moved_in / lost) instead of tour.status.
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
} from '../../api/index.js';
import { Button } from '../../ui/index.js';
import { Timeline } from '../contact/Timeline.js';
import { ContactCommsTab } from '../contact/ContactCommsTab.js';
import { useRelayThread } from '../conversation/useRelayThread.js';
import { type PlacementChannelsState } from './usePlacementChannels.js';
// Reuse the tour page's comms CSS *and* its rail component verbatim (the CSS
// module is scoped + tokens only) - the pill rail / pane / empty-state styling
// and the overflow behavior are identical for both hubs.
import { ChannelTabRail, type ChannelTab } from '../tours/TourConversation.js';
import styles from '../tours/TourDetail.module.css';

/** The GROUP tab's key. Every other tab keys on a contactId, which can never
 *  collide with it (contact ids are minted with an id prefix). */
const GROUP_KEY = 'group';

export interface PlacementConversationProps {
  placement: PlacementItem;
  /** The contact RECORDS the page fetched, for whichever people are on the
   *  channels: the 1:1 pane needs a loaded Contact, not just an id. */
  tenant: Contact | null;
  landlord: Contact | null;
  /** The records for ROSTER members who are neither of those two - the PM on a
   *  PM-managed property, anyone added by hand (useRosterContacts). Without
   *  them those tabs would have no Contact to open a pane with (spec D6). */
  rosterContacts?: Contact[];
  channels: PlacementChannelsState;
  /** Is this pane actually ON SCREEN? The page owns the answer (its Details /
   *  Conversation pane state + the shell breakpoint); we are always MOUNTED, so
   *  we cannot tell. Gates the 1:1 mark-read fan-out only - see the effect. */
  commsVisible: boolean;
  /** Open the group text THROUGH THE PAGE. Opening sends a real intro text, so
   *  the hub routes it via the pre-open confirm (contact-rosters spec 6.3);
   *  without this prop the pane keeps its own direct provision (the standalone
   *  render path its own tests exercise). */
  onOpenGroup?: () => void;
  /** True while the page's open flow is in flight (only with onOpenGroup). */
  openGroupBusy?: boolean;
  /** Why [Open group text] is unavailable right now - today: fewer than two
   *  reachable roster members (spec 6.2). Disables the control and says so
   *  rather than failing at click time. */
  openGroupDisabledReason?: string;
}

export function PlacementConversation({
  placement,
  tenant,
  landlord,
  rosterContacts,
  channels,
  commsVisible,
  onOpenGroup: onOpenGroupFromPage,
  openGroupBusy: pageOpenGroupBusy,
  openGroupDisabledReason,
}: PlacementConversationProps): React.JSX.Element {
  // Initial tab decided ONCE from the placement at first render; never re-synced.
  // 'group', else a contactId - here the tenant's.
  const [activeKey, setActiveKey] = useState<string>(
    placement.group_thread ? GROUP_KEY : placement.tenantId,
  );

  // ONE "Comms only" filter per page visit, shared by EVERY 1:1 tab and held
  // ABOVE their keyed remount. Timeline's own copy is per-mount state, so without
  // this the filter would reset on every tab switch - and a pin-heavy person feed
  // is exactly where an operator reaches for it (spec A-M2).
  const [commsOnly, setCommsOnly] = useState(false);

  // The rail: the group text, then one tab per person - label verbatim from the
  // channel (the page resolved the display name; no role word is derived here).
  const people = channels.people;
  const tabs: ChannelTab[] = [
    { key: GROUP_KEY, label: 'Group text', unread: channels.group.unread },
    ...people.map((p) => ({ key: p.contactId, label: p.label, unread: p.unread })),
  ];

  // Selection-on-remove (spec 6.6): an activeKey that is not one of THIS
  // placement's people - they were dropped from the roster while their tab was
  // selected - lands on the GROUP tab, which always exists. Derived, never
  // re-synced state: activeKey itself is untouched, so nothing has to be undone
  // if they return.
  const activePerson = people.find((p) => p.contactId === activeKey);
  const isGroupTab = activePerson === undefined;
  const effectiveKey = isGroupTab ? GROUP_KEY : activeKey;

  // A placement has no `status`; a group text cannot be opened once the deal is
  // terminal (moved_in / lost).
  const groupDead = TERMINAL_STAGES.has(placement.stage);
  const oneToOneContactId = activePerson?.contactId;
  const oneToOneName = activePerson?.label ?? '';
  // The pane needs a LOADED Contact - it derives the numbers, addresses and the
  // deleted / opted-out send gates from it, so an id alone is not enough. The
  // page hands us the records it fetched (its tenant/landlord joins) PLUS the
  // records it fetched for the rest of the roster; match the active person
  // against all of them - a roster member is never only the tenant or the
  // unit's landlord-of-record (spec D6: the PM on a PM-managed property).
  const oneToOneContact =
    activePerson === undefined
      ? null
      : ([tenant, landlord, ...(rosterContacts ?? [])].find(
          (c) => c !== null && c.contactId === activePerson.contactId,
        ) ?? null);
  // Only ONE way a tab can be missing its record now: the best-effort getContact
  // behind it failed (the page's own join, or the roster-member fetch). A person
  // with no id gets no tab at all, so the old "landlord not resolved yet"
  // dead-end tab is gone with the fixed slots.
  const oneToOneMissingNote = `We could not load ${oneToOneName}'s contact record.`;

  // Viewing the GROUP tab marks its SINGLE conversation read + clears the tab dot.
  // Runs on the initial tab and every switch; re-runs when the channel resolves an
  // id or gains unread. We pass the channel's CURRENT values as ARGUMENTS (rather
  // than have the hook read a ref) so the INITIAL active tab marks read on the
  // loading->ready commit: a ref would be written by a parent effect that runs
  // AFTER this child effect, so it would still be stale here. markGroupRead no-ops
  // at unread 0, so this never loops.
  //
  // The 1:1 tabs read the PERSON instead (the contact-wide inbox fan-out), and
  // that mark deliberately does NOT live here: it is one-way data loss - it clears
  // unread on every thread the person owns and the product has no mark-unread
  // anywhere - so it is gated on the PANE's own timeline actually being ready,
  // which only ContactCommsTab can see. It runs there, over the same commsVisible
  // and unread values this component holds; see that file's effect for the full
  // gate list and why each one exists. This branch is untouched by that split:
  // markGroupRead is a single-conversation read that predates the pane, and gating
  // it is out of scope.
  const groupConversationId = channels.group.conversationId;
  const activeUnread = activePerson === undefined ? channels.group.unread : activePerson.unread;
  useEffect(() => {
    if (!isGroupTab) return;
    channels.markGroupRead(groupConversationId, activeUnread);
  }, [isGroupTab, groupConversationId, activeUnread, channels]);

  // Group provisioning lives HERE (not delegated to a parent onOpenGroup like the
  // tour page): [Open group text] calls provisionPlacementRelay, then injects the
  // fresh conversationId so the relay thread mounts immediately.
  const [openGroupBusy, setOpenGroupBusy] = useState(false);
  const [groupError, setGroupError] = useState<string | null>(null);
  // The page's flow wins when it owns the open (its confirm dialog is the gate).
  const busyOpening = pageOpenGroupBusy ?? openGroupBusy;
  function onOpenGroup(): void {
    if (onOpenGroupFromPage !== undefined) {
      onOpenGroupFromPage();
      return;
    }
    if (openGroupBusy) return;
    setOpenGroupBusy(true);
    setGroupError(null);
    void provisionPlacementRelay(placement.placementId)
      .then((result) => {
        // Quiet hours DEFER the open (202): nothing was provisioned, so there is
        // no thread to mount - say when it will happen instead of injecting an
        // id that does not exist. (The page-owned flow, which is what the real
        // app renders, carries the full pending banner + its two ways out.)
        if (result.deferred) {
          setGroupError('This group text opens when quiet hours end.');
          return;
        }
        channels.setGroupConversationId(result.conversationId);
      })
      .catch(() => setGroupError('Could not open the group text. Please try again.'))
      .finally(() => setOpenGroupBusy(false));
  }

  return (
    <div className={styles.convo}>
      <ChannelTabRail tabs={tabs} activeKey={effectiveKey} onSelect={setActiveKey} />

      <div className={styles.channelPane}>
        {isGroupTab ? (
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
                disabled={busyOpening || groupDead || openGroupDisabledReason !== undefined}
              >
                {busyOpening ? 'Opening...' : 'Open group text'}
              </Button>
              {openGroupDisabledReason !== undefined && !groupDead ? (
                <p className={styles.emptyNote}>{openGroupDisabledReason}</p>
              ) : null}
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
          // key so switching from one person's 1:1 to another's REMOUNTS a fresh
          // pane. Every tab renders <ContactCommsTab> at the same JSX position;
          // without a key React reuses the fiber and the composer's in-progress
          // draft survives the switch, so a Send would post it to the
          // newly-selected party.
          // (No seed nonce rides this key - the placement page has no no-show
          // check-in.)
          <ContactCommsTab
            key={oneToOneContact.contactId}
            contact={oneToOneContact}
            emptyLabel={`No messages with ${oneToOneName} yet`}
            commsOnly={commsOnly}
            onCommsOnlyChange={setCommsOnly}
            commsVisible={commsVisible}
            unread={activeUnread}
            onMarkRead={(u) => channels.markPersonRead(oneToOneContactId, u)}
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
      upcomingTimezone={thread.upcomingTimezone}
      source="server"
      canSend={canSend}
      {...(canSend && { onSend })}
      relayRoster={members}
      relayClosed={closed}
      resetScrollKey={conversationId}
    />
  );
}
