// TourConversation - the tour page's LEFT pane: a channel switcher over the relay
// group plus ONE 1:1 tab per person the page put on this tour (`channels.people`,
// keyed by contactId and labelled with that person's DISPLAY NAME - no role
// words, no PM/Landlord branch: the page owns WHO is on the tour, this component
// only renders them). The initial tab is Group when the tour already has a group
// thread, else the tenant's, and it NEVER auto-switches after load (only a user
// click moves it) - except that a selection pointing at a person who is no longer
// on the tour falls back to Group (spec 6.6).
//
// The 1:1 tabs are the SHARED person-centric comms pane (ContactCommsTab ->
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
// inbox fan-out, contact-page parity). Only the GROUP mark runs here. The 1:1
// fan-out runs inside ContactCommsTab, which gates it on the operator actually
// being able to see the pane (commsVisible + a loaded contact + a READY timeline
// + a foreground browser tab) - see that file's effect for why.
//
// The active tab lazily mounts ONE pane: only the active channel fetches (we
// never fetch every tab up front). Empty states render in place: the group offers
// [Open relay group]; a 1:1 whose contact record failed to load says so (the pane
// requires a LOADED Contact), and a contact with no thread yet gets a live
// composer that creates the conversation on the first send.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { useRelayThread } from '../conversation/useRelayThread.js';
import { type TourChannelsState } from './useTourChannels.js';
import styles from './TourDetail.module.css';

/** The GROUP tab's key. Every other tab keys on a contactId, which can never
 *  collide with it (contact ids are minted with an id prefix). */
const GROUP_KEY = 'group';

export interface TourConversationProps {
  tour: Tour;
  /** The contact RECORDS the page fetched, for whichever people are on the
   *  channels: the 1:1 pane needs a loaded Contact, not just an id. */
  tenant: Contact | null;
  landlord: Contact | null;
  /** The records for ROSTER members who are neither of those two - the PM on a
   *  PM-managed property, anyone added by hand (useRosterContacts). Without
   *  them those tabs would have no Contact to open a pane with (spec D6). */
  rosterContacts?: Contact[];
  channels: TourChannelsState;
  /** Provision the group thread (shared with the header kebab); errors surface in
   *  the page header banner. */
  onOpenGroup: () => void;
  openGroupBusy: boolean;
  /** Why [Open relay group] is unavailable RIGHT NOW even though the tour could
   *  otherwise take one - today: the roster has fewer than two reachable
   *  members (contact-rosters spec 6.2). Present -> the control is disabled and
   *  carries this sentence, instead of failing at click time with the route's
   *  400 relay_member_unresolvable. */
  openGroupDisabledReason?: string;
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
  /** Is this pane actually ON SCREEN? The page owns the answer (its Details /
   *  Conversation pane state + the shell breakpoint); we are always MOUNTED, so
   *  we cannot tell. Gates the 1:1 mark-read fan-out only - see the effect. */
  commsVisible: boolean;
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

export function TourConversation({
  tour,
  tenant,
  landlord,
  rosterContacts,
  channels,
  onOpenGroup,
  openGroupBusy,
  openGroupDisabledReason,
  tourMilestones,
  noShowDraft,
  commsVisible,
}: TourConversationProps): React.JSX.Element {
  // Initial tab decided ONCE from the tour at first render; never re-synced.
  // 'group', else a contactId - here the tenant's.
  const [activeKey, setActiveKey] = useState<string>(
    tour.groupThreadId ? GROUP_KEY : tour.tenantId,
  );

  // "Send no-show check-in" seed: on a new nonce we (1) select the TENANT's tab
  // (by their contactId - the tab keys are people now) and (2) hand seededBody to
  // the tenant pane, bumping seedKey to REMOUNT it so the Timeline initialDraft
  // initializer picks up the copy. seededBody is cleared once the pane reports it
  // consumed the seed (onDraftSeeded), so a later manual switch back to the
  // tenant starts with an empty composer.
  const [seededBody, setSeededBody] = useState<string | null>(null);
  const [seedKey, setSeedKey] = useState(0);
  const lastSeedNonce = useRef(0);
  useEffect(() => {
    const nonce = noShowDraft?.nonce ?? 0;
    if (nonce > 0 && nonce !== lastSeedNonce.current) {
      lastSeedNonce.current = nonce;
      setActiveKey(tour.tenantId);
      setSeededBody(noShowDraft?.body ?? '');
      setSeedKey((k) => k + 1);
    }
  }, [noShowDraft?.nonce, noShowDraft?.body, tour.tenantId]);

  // ONE "Comms only" filter per page visit, shared by EVERY 1:1 tab and held
  // ABOVE their keyed remount. Timeline's own copy is per-mount state, so without
  // this the filter would reset on every tab switch and every seed nonce - and a
  // pin-heavy person feed is exactly where an operator reaches for it (spec A-M2).
  const [commsOnly, setCommsOnly] = useState(false);

  // The rail: the relay group, then one tab per person - label verbatim from the
  // channel (the page resolved the display name; no role word is derived here).
  const people = channels.people;
  const tabs: ChannelTab[] = [
    { key: GROUP_KEY, label: 'Relay group', unread: channels.group.unread },
    ...people.map((p) => ({ key: p.contactId, label: p.label, unread: p.unread })),
  ];

  // Selection-on-remove (spec 6.6): an activeKey that is not one of THIS tour's
  // people - they were dropped from the roster while their tab was selected -
  // lands on the GROUP tab, which always exists. Derived, never re-synced state:
  // activeKey itself is untouched, so nothing has to be undone if they return.
  const activePerson = people.find((p) => p.contactId === activeKey);
  const isGroupTab = activePerson === undefined;
  const effectiveKey = isGroupTab ? GROUP_KEY : activeKey;

  const groupDead = tour.status === 'canceled' || tour.status === 'closed';
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

  // The no-show check-in seed reaches the TENANT 1:1 composer ONLY: guarded by
  // isTenantChannel so no other person's pane can receive it (their key carries
  // no seedKey, so a bump cannot remount it), and cleared to undefined once
  // consumed (seededBody null) so a later tenant remount is empty.
  const isTenantChannel = activePerson !== undefined && activePerson.contactId === tour.tenantId;
  const tenantSeed = isTenantChannel && seededBody !== null ? seededBody : undefined;

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

  return (
    <div className={styles.convo}>
      <ChannelTabRail tabs={tabs} activeKey={effectiveKey} onSelect={setActiveKey} />

      <div className={styles.channelPane}>
        {isGroupTab ? (
          groupConversationId !== null ? (
            <GroupChannel
              conversationId={groupConversationId}
              {...(tourMilestones !== undefined && { tourMilestones })}
            />
          ) : (
            <div className={styles.channelEmpty}>
              <p className={styles.emptyTitle}>No relay group yet</p>
              <p className={styles.emptyNote}>
                Open a masked relay group with the tenant and landlord to coordinate the visit.
              </p>
              <Button
                size="sm"
                type="button"
                onClick={onOpenGroup}
                disabled={openGroupBusy || groupDead || openGroupDisabledReason !== undefined}
              >
                {openGroupBusy ? 'Opening...' : 'Open relay group'}
              </Button>
              {openGroupDisabledReason !== undefined && !groupDead ? (
                <p className={styles.emptyNote}>{openGroupDisabledReason}</p>
              ) : null}
              {groupDead ? (
                <p className={styles.emptyNote}>
                  This tour is {tour.status} - a relay group cannot be opened.
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
          // The TENANT key also carries seedKey: initialDraft is a MOUNT-ONLY
          // initializer, so a "Send no-show check-in" fired while ALREADY on the
          // tenant's tab has to remount the pane to land (spec M1). Every other
          // key is the contactId alone - no seed ever reaches those.
          <ContactCommsTab
            key={isTenantChannel ? `${tour.tenantId}:${seedKey}` : oneToOneContact.contactId}
            contact={oneToOneContact}
            emptyLabel={`No messages with ${oneToOneName} yet`}
            {...(tenantSeed !== undefined && { initialDraft: tenantSeed })}
            onDraftSeeded={() => setSeededBody(null)}
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

/** How wide the overflow fade is. MIRRORED in TourDetail.module.css's
 *  `.tabRailFaded` mask - change both. */
const RAIL_FADE_PX = 24;

export interface ChannelTab {
  /** 'group', or the person's contactId. */
  key: string;
  label: string;
  unread: number;
}

/** The channel rail, shared by the tour AND placement conversation panes (like
 *  the CSS module it styles itself from - PlacementConversation imports both from
 *  here). ONE row that scrolls horizontally when the tabs overflow, with the
 *  overflow marked by a right-edge fade; if a tab hidden past that edge has
 *  unread, the edge CARRIES its dot, so a reply can never hide off-screen
 *  (contact-rosters spec 6.6).
 *
 *  Geometry is measured from the DOM (there is no layout information in React)
 *  on mount, on scroll and on window resize, rAF-throttled because a scroll fires
 *  far faster than a dot needs repainting. KNOWN LIMIT: only the RIGHT edge
 *  carries - the rail starts at scroll 0 and an operator who scrolls right can
 *  see for themselves what they scrolled past. */
export function ChannelTabRail({
  tabs,
  activeKey,
  onSelect,
}: {
  tabs: ChannelTab[];
  activeKey: string;
  onSelect: (key: string) => void;
}): React.JSX.Element {
  const railRef = useRef<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState({ scrollable: false, carriedUnread: false });

  const measure = useCallback(() => {
    const rail = railRef.current;
    if (rail === null) return;
    // 1px of tolerance: a sub-pixel content width must not read as "there is
    // more to scroll to" and fade a rail that fits.
    const scrollable = rail.scrollWidth - rail.clientWidth > 1;
    const edge = rail.getBoundingClientRect().right - RAIL_FADE_PX;
    const carriedUnread =
      scrollable &&
      Array.from(rail.querySelectorAll<HTMLElement>('[data-unread]')).some(
        (el) => el.getBoundingClientRect().right > edge,
      );
    setOverflow((prev) =>
      prev.scrollable === scrollable && prev.carriedUnread === carriedUnread
        ? prev
        : { scrollable, carriedUnread },
    );
  }, []);

  // Re-measured whenever the tabs themselves change (a person joined, left, or
  // gained unread) as well as on scroll / resize - the DOM it reads changed.
  const tabsKey = tabs.map((t) => `${t.key}:${t.unread > 0 ? '1' : '0'}`).join(',');
  useEffect(() => {
    const rail = railRef.current;
    if (rail === null) return;
    let frame = 0;
    const schedule = (): void => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    measure();
    rail.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    // The rail's own BOX can change with no window event at all: at phone
    // widths the hubs mount on the Details pane with this rail display:none
    // (0x0 - "fits"), and the [Conversation] pane toggle just flips
    // visibility. Observe the element itself so the fade/carried dot are
    // right on pane ENTRY, not first-scroll. (jsdom has no ResizeObserver -
    // the listeners above still cover those tests.)
    const observer =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    observer?.observe(rail);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      rail.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      observer?.disconnect();
    };
  }, [measure, tabsKey]);

  return (
    <div className={styles.tabRailWrap}>
      <div
        ref={railRef}
        className={overflow.scrollable ? `${styles.tabRail} ${styles.tabRailFaded}` : styles.tabRail}
        role="tablist"
        aria-label="Conversation channel"
      >
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={activeKey === t.key}
            className={activeKey === t.key ? styles.tabOn : styles.tab}
            onClick={() => onSelect(t.key)}
            // A LAYOUT marker, not a test hook: measure() asks the DOM which
            // unread tabs sit past the edge, so it needs to find them without
            // re-deriving the tab list.
            {...(t.unread > 0 && { 'data-unread': 'true' })}
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
      {overflow.carriedUnread ? (
        <span className={styles.carriedDot}>
          <span className={styles.dot} aria-hidden="true" />
          <span className={styles.srOnly}>Unread messages past the edge of the channel list</span>
        </span>
      ) : null}
    </div>
  );
}

/** The relay-group transcript: the relay thread + roster + closed state, mirroring
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
