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
}

export function ContactCommsTab({
  contact,
  emptyLabel,
  initialDraft,
  onDraftSeeded,
  commsOnly,
  onCommsOnlyChange,
}: ContactCommsTabProps): React.JSX.Element {
  const timeline = useContactTimeline(contact.contactId);
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
      // the locked composer shows the note WITHOUT a dead button. No
      // onContactUpdated either: these pages hold no contact state to sync, and
      // the pane's local override already keeps its own send gates fresh.
    />
  );
}
