// useNotificationAction — surfaces the notification action id that brought the
// user here, from EITHER channel the service worker uses (see public/sw.js):
//
//   1. URL hash `#action=<id>` — the SW appends this when an Android action
//      button is tapped and it navigates/opens the PWA at
//      `/quick-reply/<callId>#action=<id>`. Present synchronously on mount.
//   2. A `navigator.serviceWorker` 'message' of shape
//      `{ type: 'notificationclick', action, data }` — the SW postMessages this
//      to an ALREADY-FOCUSED client (so it can act without a reload). This may
//      arrive after mount.
//
// We capture the FIRST action id seen from either channel and never change it
// thereafter (a ref-backed latch). The caller (QuickReply) uses it to auto-send
// the matching canned reply exactly once — see useAutoSend for the send-once
// guard. We also strip the `#action=` from the URL after reading so a manual
// refresh doesn't replay the auto-send.
import { useEffect, useRef, useState } from 'react';

/** Parse `#action=<id>` out of a location hash. Returns null when absent. */
export function parseActionHash(hash: string): string | null {
  // hash looks like "#action=qr-1" (or "" / "#"). Tolerate extra hash params.
  const match = /(?:^#|&)action=([^&]+)/.exec(hash);
  const raw = match?.[1];
  if (raw === undefined) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

interface NotificationClickMessage {
  type: 'notificationclick';
  action: string | null;
  data?: unknown;
}

function isNotificationClickMessage(value: unknown): value is NotificationClickMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'notificationclick'
  );
}

/**
 * Returns the (latched) notification action id for the CURRENT callId, or null
 * if the view was opened without one. Reads the URL hash synchronously on first
 * render and also listens for the SW postMessage for the focused-client case.
 *
 * M4: the latch is keyed by `callId`. Navigating between two missed-call
 * deep-links within one client (the component stays mounted, only :callId
 * changes) RESETS the latch and re-reads the hash, so the second call's action
 * is honoured instead of being swallowed by the first call's stale latch.
 */
export function useNotificationAction(callId: string | undefined): string | null {
  // Latch: the action that opened THIS callId's view; reset when callId changes.
  const latched = useRef<string | null>(parseActionHash(window.location.hash));
  // Remember which callId the latch belongs to.
  const latchedCallId = useRef<string | undefined>(callId);
  const [action, setAction] = useState<string | null>(latched.current);

  // When the callId changes, reset the latch and re-read the hash for the new
  // deep-link (a fresh #action=<id> the SW navigated us to).
  useEffect(() => {
    if (latchedCallId.current !== callId) {
      latchedCallId.current = callId;
      const next = parseActionHash(window.location.hash);
      latched.current = next;
      setAction(next);
    }
  }, [callId]);

  // Clear the #action from the URL so a refresh can't replay the auto-send.
  // Re-runs per callId so the new deep-link's hash is stripped after capture.
  useEffect(() => {
    if (latched.current !== null && window.location.hash !== '') {
      const url = window.location.pathname + window.location.search;
      window.history.replaceState(null, '', url);
    }
  }, [callId]);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return undefined;
    const onMessage = (event: MessageEvent): void => {
      if (!isNotificationClickMessage(event.data)) return;
      const incoming = event.data.action;
      if (incoming === null || incoming === '') return;
      // Only the first action for the current callId wins; later messages are
      // ignored until the callId changes (which resets the latch above).
      if (latched.current === null) {
        latched.current = incoming;
        setAction(incoming);
      }
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, []);

  return action;
}
