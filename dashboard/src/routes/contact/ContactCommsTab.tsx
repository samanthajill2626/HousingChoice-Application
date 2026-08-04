// ContactCommsTab - the tour/placement page's 1:1 tab body: run the PERSON's
// timeline hook, then render the shared ContactCommsPane over it. A component
// (not a bare hook call in the conversation files) for one reason: hooks cannot
// be conditional, and those pages must NOT fetch a timeline for the group tab or
// for a contact that has not loaded yet.
//
// HARD RULE (spec section 3 / review B2): useContactTimeline is NEVER called with
// an empty or unresolved contactId - `useContactTimeline('')` falls into the
// fetch-the-whole-inbox fallback. That is enforced structurally: this component
// takes a LOADED Contact, so the caller has to gate on it (the tour/placement
// tabs render an empty state until both the id and the Contact object resolve),
// and the component is mounted only while its tab is active (lazy single-tab
// mount preserved).
//
// The contact page does NOT use this wrapper: it owns useContactTimeline itself
// (it also derives "Media from comms" from the items and refetches after its own
// mutations) and mounts ContactCommsPane directly.
//
// It also owns the 1:1 MARK-READ fan-out for those tabs (not the pages), because
// the last gate is this component's own timeline status - see the effect.
import { useEffect, useState } from 'react';
import { ContactCommsPane } from './ContactCommsPane.js';
import { useContactTimeline } from './useContactTimeline.js';
import type { Contact } from '../../api/index.js';

export interface ContactCommsTabProps {
  /** The tab's contact - REQUIRED and loaded; the caller gates on null. */
  contact: Contact;
  /** Ready-but-empty copy ("No messages with <name> yet"), always supplied here
   *  so a tour/placement tab never falls back to the bare "No messages yet.". */
  emptyLabel: string;
  /** Seed the composer on mount (the tour page's "Send no-show check-in"). */
  initialDraft?: string;
  /** Fired once when initialDraft seeded, so the caller can clear its seed. */
  onDraftSeeded?: () => void;
  /** "Comms only" filter - a REQUIRED controlled pair here. The page holds the
   *  value ABOVE this component (it is remounted per tab / per seed nonce), so
   *  the filter survives a tab switch instead of resetting with the mount. */
  commsOnly: boolean;
  onCommsOnlyChange: (v: boolean) => void;
  /** Is this pane actually ON SCREEN? The PAGE owns the answer (its Details /
   *  Conversation pane state + the shell breakpoint) - at <=860px the comms
   *  column is display:none but still MOUNTED, so this component cannot tell.
   *  Gates the mark-read fan-out below. */
  commsVisible: boolean;
  /** This person's summed unread across their non-relay threads (the tab dot). */
  unread: number;
  /** Mark the PERSON read - the contact-wide inbox fan-out. Called with the
   *  unread this component was handed, and ONLY once every gate below passes. */
  onMarkRead: (unread: number) => void;
}

export function ContactCommsTab({
  contact,
  emptyLabel,
  initialDraft,
  onDraftSeeded,
  commsOnly,
  onCommsOnlyChange,
  commsVisible,
  unread,
  onMarkRead,
}: ContactCommsTabProps): React.JSX.Element {
  const timeline = useContactTimeline(contact.contactId);

  // Returning to a foregrounded browser tab is a READ. Nothing re-renders a React
  // tree because the browser tab was foregrounded, so the visibility gate below
  // would otherwise hold unread forever on a quiescent page (the operator reads
  // the pane, the dot stays). Same shape as useMarkContactRead.ts:40-47, except
  // that hook re-invokes its marker directly while we bump a counter the effect
  // depends on - the effect, not the listener, owns the gate order.
  const [visibleTick, setVisibleTick] = useState(0);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') setVisibleTick((t) => t + 1);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  // Viewing a 1:1 tab marks the PERSON read (the contact-wide inbox fan-out,
  // contact-page parity). It lives HERE rather than in TourConversation /
  // PlacementConversation because the deciding input is this component's own
  // timeline status, and threading a child's async status up into a parent effect
  // would need a per-tab reset in both pages to keep a stale 'ready' from leaking
  // across a tab switch. Mounting is that reset: the pages key this component on
  // the active 1:1 contact, so every gate below is re-evaluated from scratch for
  // each person. The GROUP tab's single-conversation read stays in the pages.
  //
  // The fan-out clears unread on EVERY thread that person owns and the product
  // has no mark-unread anywhere, so it is one-way data loss. "Viewing a 1:1 tab"
  // (spec s5) therefore has to mean the operator could actually SEE it -
  //   1. commsVisible: merely landing on /tours/:id from a phone opens on
  //      Details with this column display:none behind it. Not reading.
  //   2. timeline.status === 'ready': the pane's own transcript is a DIFFERENT
  //      request from the unread count the tab dot came from. While it is still
  //      loading there is nothing on screen to read, and when it fails the pane
  //      renders "We couldn't load this timeline." and nothing else - so a 500 on
  //      GET /api/contacts/:id/timeline must not consume the person's whole inbox
  //      row. 'loading' and 'error' both block; only 'ready' opens the gate.
  //   3. document.visibilityState: the contact page's own gate
  //      (useMarkContactRead.ts:22) - a page parked in a BACKGROUND tab must not
  //      silently swallow arriving unreads. visibleTick above is what re-fires it
  //      when the operator comes back.
  // A LOADED contact is the fourth gate and it is structural: this component
  // takes a required Contact, so a page whose best-effort getContact failed
  // renders its "we could not load ..." note INSTEAD of mounting us, and no mark
  // can be attempted from a tab with no transcript and no composer.
  // DELETED contacts are deliberately NOT gated - useMarkContactRead marks a
  // soft-deleted contact read exactly like any other, and this pane's whole
  // contract is parity with it (spec s5's resurfacing note, pinned in
  // app/test/inboxApi.test.ts).
  // onMarkRead itself no-ops at unread <= 0 and zeroes the count LOCALLY before
  // it POSTs, so re-running this effect on every render cannot loop or double-POST.
  const timelineReady = timeline.status === 'ready';
  useEffect(() => {
    if (!commsVisible) return;
    if (!timelineReady) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    onMarkRead(unread);
  }, [commsVisible, timelineReady, unread, visibleTick, onMarkRead]);

  return (
    <ContactCommsPane
      contact={contact}
      timeline={timeline}
      // The stream identity is the PERSON (the scroll reset concern); the seed
      // nonce that remounts the tenant tab rides the caller's `key` instead.
      resetScrollKey={contact.contactId}
      emptyLabel={emptyLabel}
      {...(initialDraft !== undefined && { initialDraft })}
      {...(onDraftSeeded !== undefined && { onDraftSeeded })}
      commsOnly={commsOnly}
      onCommsOnlyChange={onCommsOnlyChange}
      // No onRestore: restoring a deleted contact stays on the contact page, so
      // the locked composer shows the note WITHOUT a dead button.
      //
      // No onContactUpdated either - and the honest reason is NOT that the hubs
      // hold no contact state. They do: useTour.ts:33-42 exposes tenant/landlord
      // and refetches BOTH on every tour.updated SSE, and PlacementDetail.tsx
      // holds the same pair. What they lack is a way to APPLY one contact back
      // into that bundle without a whole refetch, and adding one would still not
      // close the race: the pane clears its local override on any new `contact`
      // identity, so a refetch that was already in flight when the operator
      // recorded consent lands STALER and reverts the pane's send gates until the
      // next refetch. Contact has no updated_at (or any monotonic stamp), so the
      // pane cannot tell staler from fresher to defend itself. Tracked in
      // docs/issues/pane-override-stale-refetch-race.md; the window is a
      // display-only revert (every send is re-checked server-side).
    />
  );
}
