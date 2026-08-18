// useMarkContactRead — marks a contact's comms READ while the contact page is
// OPEN and the tab is VISIBLE (the Slack / iMessage model). It calls the C8
// fan-out `POST /api/inbox/:contactId/read`, which resets unread on every one of
// the contact's threads AND emits conversation.updated, so any open Inbox (and
// the nav badge) clears live.
//
// Fires: on open (mount / contact change), when the tab becomes visible again
// while on this page, and when a new message lands while we're looking. The
// server endpoint is idempotent (it no-ops a thread that's already read), so
// redundant calls are cheap. Gated on document.visibilityState so a contact page
// left open in a BACKGROUND tab does NOT silently swallow incoming unreads.
//
// Returns an AutoReadHandle. A mark-UNREAD action must await
// `suppressAndDrain()` before its POST, or this auto-read can re-read the very
// thread the operator just flagged.
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { markInboxRead, useEventStream } from '../../api/index.js';

/** The handle every auto-read hook hands back so a mark-UNREAD action can win a
 *  race it would otherwise lose. `useMarkThreadRead` returns the same shape. */
export interface AutoReadHandle {
  /** Suppress auto-read for the CURRENT identity, then wait for any in-flight
   *  auto-read to settle. Await BEFORE issuing a mark-unread POST. */
  suppressAndDrain: () => Promise<void>;
  /** Undo `suppressAndDrain`'s latch for the CURRENT identity.
   *
   *  Call it whenever a mark-unread attempt terminates WITHOUT navigating away.
   *  The latch is a one-way door otherwise: both surfaces deliberately STAY on
   *  the page when the mark-unread POST fails, and a page that keeps its
   *  auto-read latched off stops marking read for the rest of the visit - a new
   *  inbound stays unread while the operator is looking straight at it, which is
   *  the exact regression the auto-read exists to prevent. */
  release: () => void;
}

/** Upper bound on how long a drain waits for an in-flight auto-read.
 *
 *  AWAIT, DO NOT ABORT: a client abort does not stop the server committing the
 *  resetUnread, so aborting would hide the race rather than close it. But
 *  `api/client.ts` sets no timeout and the auto-read passes no signal, so an
 *  unbounded await makes the button look dead - worse, and likelier, than the
 *  narrow tail race.
 *
 *  WHAT THE TIMEOUT ACTUALLY COSTS, stated plainly because an earlier revision
 *  of this comment overclaimed: on timeout we proceed, and the latch suppresses
 *  the late response's CLIENT-SIDE follow-on (the trailing re-fire, and any
 *  further trigger for this identity). It does NOT and cannot stop the
 *  already-dispatched server-side `resetUnread` from committing after our
 *  mark-unread - no client-side state reaches that write. So a drain that times
 *  out leaves exactly the ordering hazard the drain exists to close, for the
 *  tail beyond 2s. That is the accepted trade, not an eliminated risk. */
export const AUTO_READ_DRAIN_TIMEOUT_MS = 2000;

/** Await `promise`, giving up after AUTO_READ_DRAIN_TIMEOUT_MS. Never rejects -
 *  a failed auto-read is a settled auto-read as far as the drain is concerned.
 *
 *  Exported for `routes/conversation/useMarkThreadRead`: the two auto-read hooks
 *  implement ONE contract and this file is its home (it is the older, canonical
 *  auto-read). Two copies of a timeout bound would drift. */
export function drainWithBound(promise: Promise<unknown>): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, AUTO_READ_DRAIN_TIMEOUT_MS);
    void promise.then(finish, finish);
  });
}

export function useMarkContactRead(contactId: string): AutoReadHandle {
  // Coalesce overlapping calls (the fan-out does a phone->conversations lookup):
  // ONE request in flight, and a trigger that lands meanwhile schedules exactly
  // ONE trailing re-mark once it settles. Without the trailing re-fire, a second
  // event inside one round trip (a missed call's terminal summary right behind
  // its ring, two texts in quick succession) was DROPPED, and the read that was
  // in flight had been issued against a thread that was still read - leaving the
  // thread unread while the operator was looking straight at it. The server is
  // idempotent, so the trailing call is cheap when it turns out redundant.
  const inFlight = useRef(false);
  const trailing = useRef(false);
  // The in-flight/trailing pair belongs to ONE contact. ContactDetail is
  // rendered unkeyed under `contacts/:contactId`, so /contacts/A -> /contacts/B
  // re-renders the SAME hook instance: a generation counter bumped per contact
  // lets a request that A started settle without touching B's flags (else B's
  // mount read would be swallowed as "in flight" and A re-marked instead), and
  // a mounted ref stops a trailing re-mark from firing after the page is gone
  // (that would zero an unread the operator never looked at - one-way, there
  // is no mark-unread).
  const generation = useRef(0);
  const mounted = useRef(true);
  const ownerContactId = useRef<string | undefined>(undefined);
  // Mark-unread suppression (S6). Marking a thread unread races this page's OWN
  // auto-read: all three triggers below fire uncancelled, so the operator's
  // request could be silently re-read by one already in flight - a no-op with a
  // success response, the worst failure shape for a to-do affordance. The latch
  // names the contact it suppresses (never a bare boolean) so it can only ever
  // silence the contact the operator acted on.
  const suppressedFor = useRef<string | null>(null);
  // The auto-read a drain must wait out, KEYED BY CONTACT so /contacts/A ->
  // /contacts/B never leaves B's drain awaiting A's request.
  const inFlightPromise = useRef<{ id: string; promise: Promise<unknown> } | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Declared BEFORE the mount-read effect below so a contact switch resets the
  // flags before the new contact's first read is attempted. Keyed on an ACTUAL
  // change of contact (not on effect re-runs): React StrictMode replays effects
  // for the same contact in dev, and a blind reset there would clear the
  // in-flight guard and issue the mount read twice.
  //
  // This is the latch's IDENTITY-CHANGE reset: a new contact starts unlatched.
  // The only other clear is the handle's explicit `release()`, which the caller
  // invokes when a mark-unread attempt ends without navigating away - the case
  // this effect cannot see, because the contact never changes.
  useEffect(() => {
    if (ownerContactId.current === contactId) return;
    ownerContactId.current = contactId;
    generation.current += 1;
    inFlight.current = false;
    trailing.current = false;
    suppressedFor.current = null;
  }, [contactId]);

  const markRead = useCallback(() => {
    // ONE early return at the TOP kills all three triggers below AND the
    // trailing re-fire inside the `finally` (which re-enters markRead). Without
    // it the coalescing machinery would re-mark the thread read at the exact
    // moment the operator asked for unread.
    if (suppressedFor.current === contactId) return;
    if (contactId.length === 0) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    if (inFlight.current) {
      trailing.current = true;
      return;
    }
    inFlight.current = true;
    const myGeneration = generation.current;
    const request: Promise<void> = markInboxRead({ contactId })
      .catch(() => {
        /* best-effort — a failed mark-read just leaves the badge until next time */
      })
      .finally(() => {
        // Release the drain handle for THIS request only - a later contact may
        // already own the ref. Done BEFORE the guards below: the drain must see
        // the request settle even when the page is gone or a newer contact has
        // taken over.
        if (inFlightPromise.current?.promise === request) inFlightPromise.current = null;
        // A newer contact owns the flags now, or the page is gone: this
        // request's settle must not release or re-fire anything.
        if (!mounted.current || myGeneration !== generation.current) return;
        inFlight.current = false;
        if (trailing.current) {
          trailing.current = false;
          markRead();
        }
      });
    inFlightPromise.current = { id: contactId, promise: request };
    void request;
  }, [contactId]);

  // Latch the auto-read off for THIS contact, then wait out whatever is already
  // in flight, so the mark-unread POST the caller issues next lands last.
  const suppressAndDrain = useCallback(async (): Promise<void> => {
    suppressedFor.current = contactId;
    const pending = inFlightPromise.current;
    if (pending === null || pending.id !== contactId) return;
    await drainWithBound(pending.promise);
  }, [contactId]);

  // Release the latch for THIS contact only: a later contact may already own
  // the ref, and clearing that would un-suppress an action the operator took on
  // a page they have since left.
  const release = useCallback((): void => {
    if (suppressedFor.current === contactId) suppressedFor.current = null;
  }, [contactId]);

  // Memoized: this handle flows into consumer effect deps, and a churning
  // identity there POST-loops (the hazard UnreadContext records for
  // noteRowsCleared/rollbackRowsCleared).
  const handle = useMemo<AutoReadHandle>(
    () => ({ suppressAndDrain, release }),
    [suppressAndDrain, release],
  );

  // Opening the contact (or switching contacts) while visible = reading it.
  useEffect(() => {
    markRead();
  }, [markRead]);

  // Returning to the tab while parked on this page marks it read.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') markRead();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [markRead]);

  // A new message landed while we're looking → it's read.
  useEventStream({ onMessagePersisted: markRead });

  return handle;
}
