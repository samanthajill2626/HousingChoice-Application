// SW push DISPLAY building - the PURE, testable core of how a pushed payload
// becomes a Notification (title + options), which tag it carries, and which
// earlier notifications it makes stale.
//
// WHY per-kind tags (fixed 2026-08-16, observed live on prod): pre_ring,
// missed_call and voicemail for one call all used the bare CallSid as their
// tag, so each later push REPLACED the earlier one in place. A pre-ring that
// arrived fine looked like it never came, and an Android deferred-push flush
// collapsed a whole call into one shade entry. Tags are now "<kind>:<id>", so
// one call's alerts coexist the way a native phone app shows incoming-call,
// missed-call and voicemail as separate entries. A `message` push coalesces
// per conversation ("message:<conversationId>") like a native SMS thread.
//
// The one deliberate replacement left: a missed_call/voicemail push CLOSES the
// call's pre_ring notification (staleTagsFor). "Incoming call" is transient -
// once the call resolved it is pure noise, and its requireInteraction would
// otherwise pin it to the shade forever.
//
// NOTE: public/sw.js is a CLASSIC service worker (served statically, NOT
// bundled). It cannot `import` this ES module, so sw.js inlines a verbatim
// copy of these functions with a comment pointing here. THIS module is the
// source of truth and is unit-tested (display.test.ts); keep the two in sync.

/** The push payload fields the display builder reads (a subset of the JSON). */
export interface PushDisplayData {
  title?: string;
  body?: string;
  kind?: string;
  callId?: string;
  conversationId?: string;
  actions?: Array<{ action: string; title: string }>;
}

/** The notification options shape we build. Typed locally because lib.dom's
 * NotificationOptions omits the Android-only members (vibrate, renotify,
 * actions) this worker relies on. */
export interface BuiltNotification {
  title: string;
  options: {
    body: string;
    icon: string;
    badge: string;
    data: { kind?: string; callId?: string; conversationId?: string };
    actions?: Array<{ action: string; title: string }>;
    vibrate: number[];
    renotify: boolean;
    requireInteraction: boolean;
    tag?: string;
  };
}

/**
 * The notification tag for a payload: "<kind>:<id>" so different kinds about
 * the same call/conversation get their OWN shade entries, while repeats of the
 * SAME kind (e.g. more texts in one thread) coalesce in place. Bare id when
 * the payload has no kind; undefined (no coalescing) when it has no id.
 */
export function notificationTag(data: PushDisplayData | null | undefined): string | undefined {
  const d = data ?? {};
  const id = d.callId || d.conversationId || undefined;
  if (!id) return undefined;
  return d.kind ? `${d.kind}:${id}` : id;
}

/**
 * Build the Notification title + options for a pushed payload. Pre-ring and
 * missed-call alerts are time-sensitive (the founder must see them BEFORE or
 * around a live call), so they get the strongest on-screen treatment we can
 * ask for: renotify (peek again on a same-tag repeat) and requireInteraction
 * (stay on screen until acted on). Every push vibrates - the vibration
 * pattern is the key nudge that makes Android surface a heads-up banner
 * instead of filing the notification silently into the shade.
 */
export function buildNotificationOptions(data: PushDisplayData | null | undefined): BuiltNotification {
  const d = data ?? {};
  const timeSensitive = d.kind === 'missed_call' || d.kind === 'pre_ring';
  const tag = notificationTag(d);
  return {
    title: d.title || 'HousingChoice',
    options: {
      body: d.body || '',
      // The icons ship in the manifest set; reuse the maskable icon.
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-72.png',
      // Carry ONLY the known routing fields to notificationclick - never a
      // payload-supplied url (C1: no open-redirect sink).
      data: {
        kind: d.kind,
        callId: d.callId,
        conversationId: d.conversationId,
      },
      // Android shows action buttons; iOS ignores them (tap deep-links instead).
      actions: Array.isArray(d.actions) ? d.actions.slice(0, 2) : undefined,
      vibrate: [200, 100, 200],
      // `renotify` REQUIRES a tag - setting it tagless throws - so gate it.
      renotify: timeSensitive && Boolean(tag),
      requireInteraction: timeSensitive,
      tag,
    },
  };
}

/**
 * Tags of notifications this push makes STALE: a missed_call or voicemail push
 * means the call is over, so the call's "Incoming call" (pre_ring) alert is
 * noise and should be closed. Everything else closes nothing - missed-call and
 * voicemail entries deliberately coexist, like a native phone app's.
 */
export function staleTagsFor(data: PushDisplayData | null | undefined): string[] {
  const d = data ?? {};
  if ((d.kind === 'missed_call' || d.kind === 'voicemail') && d.callId) {
    return [`pre_ring:${d.callId}`];
  }
  return [];
}
