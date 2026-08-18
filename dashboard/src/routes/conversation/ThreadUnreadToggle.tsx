// ThreadUnreadToggle - the header's Mark read / Mark unread affordance for a
// MULTI-PARTY thread, shared by BOTH group views (RelayGroupView, a local
// function inside ConversationDetail.tsx, and GroupTextView).
//
// D6: exactly ONE of the two actions is offered, chosen by a LIVE unread count.
// Never both, and never "Mark unread" on a thread that is already unread. The
// labels mirror the delivered inbox row, INCLUDING the deliberate "as" in
// `Mark <name> as unread` - it keeps the two accessible names from being
// substrings of each other for assistive tech and for selectors.
//
// ONE copy on purpose. The two headers must behave identically down to the
// ordering of suppressAndDrain -> POST -> navigate, and a second copy of that
// order is exactly the drift lib/groupThread.ts records for the naming rule.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  markConversationRead,
  markConversationUnread,
  useEventStream,
  type ConversationHeader,
  type ConversationUpdatedEvent,
} from '../../api/index.js';
import type { AutoReadHandle } from './useMarkThreadRead.js';
import styles from './ConversationDetail.module.css';

/** Retryable, not diagnostic. A 409 here is the participant-GSI-lag path, which
 *  is EXPECTED and clears on a retry - so the copy asks for one and the action
 *  stays available. Every other failure gets the same treatment: there is
 *  nothing an operator can do with a status code. */
export const MARK_UNREAD_ERROR = 'Could not mark unread - try again';
/** The same treatment for the other direction (this half is new UI too). */
export const MARK_READ_ERROR = 'Could not mark read - try again';

/** The mount seed for the live count.
 *
 *  `unread_count` is NOT a typed field on `ConversationHeader` - it rides the
 *  interface's `[key: string]: unknown` index signature, and the attribute is
 *  genuinely SPARSE server-side (a thread that never received an inbound has
 *  never had it written). So it reads back as `unknown` and is absent more often
 *  than not. `Number(raw)` would turn that absence into NaN, and `NaN > 0` is
 *  false - the same label a real 0 produces, which is what makes the bug
 *  invisible on screen. Exported so a test can pin the 0. */
export function seedUnreadCount(header: ConversationHeader): number {
  const raw = header['unread_count'];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
}

/** The thread's LIVE unread count: seeded once from the mount header, then owned
 *  by `conversation.updated`.
 *
 *  THE SEED IS NOT ENOUGH AND GATING ON IT ALONE IS THE BUG THIS AVOIDS. The
 *  header is fetched once per conversationId (ConversationDetail's `[conversationId]`
 *  effect) and NOTHING re-reads it - the only other writer is `onHeader`, which
 *  spreads the stale header - so the seed is deterministically PRE-auto-read and
 *  never refreshed. The mount auto-read emits `conversation.updated` itself,
 *  which is how this page learns its post-read count with no re-fetch at all.
 *
 *  FILTERED to this thread: `/api/events` is one org-wide firehose, and nothing
 *  about another conversation is news here. */
export function useThreadUnreadCount(conversationId: string, header: ConversationHeader): number {
  const [count, setCount] = useState<number>(() => seedUnreadCount(header));

  const onConversationUpdated = useCallback(
    (event: ConversationUpdatedEvent) => {
      if (event.conversationId !== conversationId) return;
      const next = event.unread_count;
      // Required and a plain number on the wire - guarded anyway, because a
      // malformed payload must leave the last known count alone rather than
      // render NaN-driven nonsense.
      if (typeof next !== 'number' || !Number.isFinite(next)) return;
      setCount(next);
    },
    [conversationId],
  );

  useEventStream({ onConversationUpdated });

  return count;
}

export interface ThreadUnreadToggleProps {
  conversationId: string;
  /** The mount header - the seed for the live count, nothing more. */
  header: ConversationHeader;
  /** The accessible-name subject: `Mark <name> as unread`, as the row spells it. */
  name: string;
  /** This view's auto-read handle. Awaited BEFORE the mark-unread POST: the
   *  mount auto-read fires uncancelled, so without the drain the operator's
   *  request can be silently re-read by one already in flight - a no-op with a
   *  success response, the worst failure shape for a to-do affordance. */
  autoRead: AutoReadHandle;
}

export function ThreadUnreadToggle({
  conversationId,
  header,
  name,
  autoRead,
}: ThreadUnreadToggleProps): React.JSX.Element {
  const navigate = useNavigate();
  const unreadCount = useThreadUnreadCount(conversationId, header);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unread = unreadCount > 0;
  // Does this press still own the page? The mark-unread await chain runs for up
  // to the 2s drain bound plus a round trip, and `navigate` OUTLIVES this
  // component: react-router's useNavigate sets its `activeRef` in a layout
  // effect and never clears it on unmount, so a resolution that lands after the
  // operator has moved on still moves the page - yanking them to /inbox for a
  // press they made on a thread they have left.
  //
  // MOUNTED, NOT A conversationId GENERATION - deliberately, and the identity
  // counter the contact page uses would be the WRONG instrument here.
  // ConversationDetail calls setStatus('loading') on every conversationId change
  // and its loading branch renders a spinner INSTEAD of the group view, so a
  // thread switch UNMOUNTS this component rather than re-rendering it
  // (useMarkThreadRead.ts:27-35 records that same property, and depends on it).
  // An identity counter therefore could only ever fire in the single commit
  // before that unmount, and only by relying on React running child effects
  // before parent ones - while missing every OTHER departure, where the operator
  // leaves for a contact page or the inbox and conversationId never changes at
  // all. "The instance that made the press is gone" is the fact that actually
  // distinguishes them; useMarkContactRead carries the same ref for the same
  // hazard.
  const stillMounted = useRef(true);
  useEffect(() => {
    stillMounted.current = true;
    return () => {
      stillMounted.current = false;
    };
  }, []);

  const onMarkRead = (): void => {
    // NO NAVIGATION. Marking a thread read while reading it is not a departure -
    // the operator is still here. (D2 sends only the unread direction to /inbox.)
    void markConversationRead(conversationId)
      .catch(() => {
        setError(MARK_READ_ERROR);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const onMarkUnread = async (): Promise<void> => {
    try {
      await autoRead.suppressAndDrain();
      await markConversationUnread(conversationId);
    } catch {
      // The view is GONE: nothing below may run. The two setStates are inert on
      // an unmounted component anyway; `release()` is the load-bearing half, and
      // skipping it is right rather than merely harmless - the auto-read hook
      // lives in the group view that just unmounted with us, so its latch died
      // with its refs, and the handle is keyed to the thread it was minted for
      // either way (useMarkThreadRead.ts:77-79).
      if (!stillMounted.current) return;
      // The attempt ended WITHOUT navigating, so hand the auto-read back: a
      // latch that outlives a failed attempt silences this thread's auto-read
      // for the rest of the visit.
      autoRead.release();
      setError(MARK_UNREAD_ERROR);
      setBusy(false);
      return;
    }
    // The write STANDS - it was correct for the thread the operator pressed on,
    // and that thread's inbox row is unread, which is where this navigation
    // would have taken them anyway. What must not happen is moving a page they
    // have already moved on from.
    if (!stillMounted.current) return;
    // Deliberately no busy reset on the success path: navigating unmounts this
    // component, and a setState into the gap is a warning with no purpose.
    navigate('/inbox');
  };

  const onClick = (): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    if (unread) {
      onMarkRead();
      return;
    }
    void onMarkUnread();
  };

  return (
    <>
      <button
        type="button"
        className={styles.actionBtn}
        disabled={busy}
        // The aria-label does NOT change while pending, so a selector that found
        // the action still finds it mid-flight (and after a failure).
        aria-label={unread ? `Mark ${name} read` : `Mark ${name} as unread`}
        onClick={onClick}
      >
        {busy
          ? unread
            ? 'Marking read...'
            : 'Marking unread...'
          : unread
            ? 'Mark read'
            : 'Mark unread'}
      </button>
      {error !== null ? (
        <span role="alert" className={styles.error}>
          {error}
        </span>
      ) : null}
    </>
  );
}
