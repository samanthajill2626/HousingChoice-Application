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
import { useCallback, useEffect, useRef } from 'react';
import { markInboxRead, useEventStream } from '../../api/index.js';

export function useMarkContactRead(contactId: string): void {
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

  const markRead = useCallback(() => {
    if (contactId.length === 0) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    if (inFlight.current) {
      trailing.current = true;
      return;
    }
    inFlight.current = true;
    void markInboxRead({ contactId })
      .catch(() => {
        /* best-effort — a failed mark-read just leaves the badge until next time */
      })
      .finally(() => {
        inFlight.current = false;
        if (trailing.current) {
          trailing.current = false;
          markRead();
        }
      });
  }, [contactId]);

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
}
