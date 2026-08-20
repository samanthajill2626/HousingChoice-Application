/* HousingChoice service worker (M1.4; RESTORED 2026-08-15). Plain JS, served
 * statically from the dashboard build at /sw.js (Vite copies public/ to the
 * dist root, and app.ts mounts express.static(distDir) BEFORE the SPA
 * fallback, so this is served as a file and not as index.html). Same-origin,
 * so it is allowed under the app CSP's script-src 'self' / default worker-src
 * fallback. Registered from main.tsx (guarded to https or localhost).
 *
 * WHY IT WAS GONE: this file and the manifest lived in dashboard/public and
 * were deleted wholesale with the dashboard-legacy workspace (6c821b5a); the
 * rebuilt dashboard never got its own copies. Nothing failed loudly because an
 * already-installed phone keeps running its cached worker - so dev looked fine
 * while prod, a fresh origin, could only ever make a browser shortcut and push
 * could not work at all (useNotifications awaits navigator.serviceWorker.ready,
 * which never resolves with no worker registered).
 *
 * Responsibilities (foundation plumbing; Feature Agent 4 wires the UI to the
 * push module that talks to this):
 *   - install/activate: take control immediately (skipWaiting + clients.claim).
 *     NO precaching — the app shell is served fresh by the Express static layer;
 *     this SW exists for PUSH, not offline caching (kept simple & CSP-safe).
 *   - push: show a notification from the pushed JSON. On Android, render the
 *     provided action buttons; iOS ignores actions and the tap deep-links.
 *   - notificationclick: focus/open the PWA and route to
 *     /quick-reply/<callId> for a missed call (the one-tap canned-reply sheet;
 *     an action-button tap adds #action=<id> so it sends without another tap),
 *     /conversations/<conversationId> for a message or voicemail, or /email for
 *     an unmatched-email push (no conversation exists). See
 *     PHASE1_CHANGE_ORDER_2.md for the founder-triage intent.
 *
 * Pushed payload shape (server sends JSON):
 *   { title, body,
 *     kind: 'missed_call' | 'pre_ring' | 'voicemail' | 'message'
 *         | 'unmatched_email' | 'test' | string,
 *     callId?, conversationId?, actions?: [{ action, title }] }
 *
 * SECURITY (C1): we NEVER navigate to a payload-supplied URL — that would be an
 * open-redirect / phishing sink (`new URL(absolute, origin)` does not constrain
 * an absolute off-origin url). The click target is derived ONLY from known
 * fields (kind + callId/conversationId + action) into a fixed same-origin
 * allow-list of paths, then re-asserted same-origin before navigate/openWindow.
 * The routing/validation logic below is a VERBATIM MIRROR of the tested ES
 * module src/sw/route.ts (resolveSafePath / isPlausibleId /
 * assertSameOriginPath) — this classic worker can't import it, so keep the two
 * in sync (see route.test.ts for the security cases this locks).
 */

self.addEventListener('install', () => {
  // Activate this version immediately rather than waiting for old tabs to close.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Start controlling open clients right away.
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch {
      data = { title: 'HousingChoice', body: event.data.text() };
    }
  }

  // Title + options come from the tested builder (mirror of src/sw/display.ts).
  // Per-kind tags keep one call's pre_ring / missed_call / voicemail alerts as
  // SEPARATE shade entries (they used to share the bare CallSid and replace
  // each other - fixed 2026-08-16); closing stale tags first drops the now-
  // pointless "Incoming call" alert once the call resolved to missed/voicemail.
  const built = buildNotificationOptions(data);
  event.waitUntil(
    closeStaleNotifications(data).then(() =>
      self.registration.showNotification(built.title, built.options),
    ),
  );
});

/* Close notifications this push makes stale (mirror-driven: staleTagsFor). */
async function closeStaleNotifications(data) {
  for (const tag of staleTagsFor(data)) {
    const stale = await self.registration.getNotifications({ tag });
    for (const n of stale) n.close();
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data = event.notification.data || {};
  // Derive a SAFE same-origin path from known fields only (never data.url),
  // then re-assert it is same-origin + allow-listed before any navigation.
  const safePath = assertSameOriginPath(resolveSafePath(data, event.action), self.location.origin);

  event.waitUntil(focusOrOpen(safePath, data, event.action));
});

/* ===========================================================================
 * MIRROR of src/sw/display.ts (tested in display.test.ts). Keep in sync.
 * A classic service worker can't import the ES module, so these pure functions
 * are duplicated here (minus TS types). They decide the notification's title,
 * options and TAG - per-kind tags ("<kind>:<id>") keep one call's alerts as
 * separate shade entries - and which earlier notifications a push closes.
 * ======================================================================== */

/* The notification tag: "<kind>:<id>" so different kinds about the same
 * call/conversation get their own shade entries, while repeats of the SAME
 * kind (e.g. more texts in one thread) coalesce in place. Bare id when the
 * payload has no kind; undefined (no coalescing) when it has no id.
 * `unmatched_email` is the one QUEUE-level exception, checked first: every
 * unmatched-email push shares the bare tag, so the triage queue owns ONE
 * shade entry that each new arrival replaces in place. */
function notificationTag(data) {
  const d = data || {};
  if (d.kind === 'unmatched_email') return 'unmatched_email';
  const id = d.callId || d.conversationId || undefined;
  if (!id) return undefined;
  return d.kind ? `${d.kind}:${id}` : id;
}

/* Build the Notification title + options. Two distinct sets, deliberately
 * split. ALERTING kinds re-alert on a same-tag replacement (renotify; REQUIRES
 * a tag - setting it tagless throws): a same-tag replacement is otherwise
 * SILENT, so the second message in a thread would land without a peep, the
 * opposite of native messaging - `message` and `unmatched_email` join the
 * time-sensitive kinds here. TIME-SENSITIVE kinds (missed_call, pre_ring)
 * additionally pin themselves to the screen (requireInteraction) because the
 * founder must see them BEFORE/around a live call; a message must NOT pin.
 * Every push vibrates - the vibration pattern is the key nudge that makes
 * Android surface a heads-up banner instead of filing the notification
 * silently into the shade. (iOS ignores `vibrate` but honors the banner per
 * the user's per-PWA notification settings - no code lever for heads-up on
 * iOS; see PHASE1_CHANGE_ORDER_3 notes.) */
function buildNotificationOptions(data) {
  const d = data || {};
  const timeSensitive = d.kind === 'missed_call' || d.kind === 'pre_ring';
  const alerting = timeSensitive || d.kind === 'message' || d.kind === 'unmatched_email';
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
      renotify: alerting && Boolean(tag),
      requireInteraction: timeSensitive,
      tag,
    },
  };
}

/* Tags of notifications this push makes STALE: missed_call/voicemail mean the
 * call is over, so its "Incoming call" (pre_ring) alert is noise - close it.
 * Missed-call and voicemail entries deliberately coexist, like a native
 * phone app's. */
function staleTagsFor(data) {
  const d = data || {};
  if ((d.kind === 'missed_call' || d.kind === 'voicemail') && d.callId) {
    return [`pre_ring:${d.callId}`];
  }
  return [];
}

/* ===========================================================================
 * MIRROR of src/sw/route.ts (tested in route.test.ts). Keep in sync.
 * A classic service worker can't import the ES module, so these pure functions
 * are duplicated here verbatim. They guarantee the click target is same-origin
 * and on a fixed allow-list - see the C1 note in the header comment.
 * ======================================================================== */

/* True when `id` is a plausible opaque id safe to embed in a path segment:
 * non-empty, length-bounded, no slash/backslash/scheme-colon/whitespace/control. */
function isPlausibleId(id) {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= 256 &&
    // \x7f (DEL) is in the module's class too - it was missing here, which made
    // "VERBATIM MIRROR" false for one character. Harmless in practice (DEL
    // percent-encodes and the path stays single-segment) but the two must agree.
    !/[/\\:\s\x00-\x1f\x7f]/.test(id)
  );
}

/* Resolve a same-origin, allow-listed in-app PATH from the untrusted payload.
 * A missed call deep-links to the one-tap quick-reply sheet, addressed by callId
 * ALONE (the sheet resolves the recipient server-side - nothing here may name
 * one); an Android action-button tap rides along as `#action=<id>` so that reply
 * sends with no further tap, while a plain tap (iOS, where actions are
 * unsupported) lands on the same sheet and waits. Everything else routes to the
 * conversation. */
function resolveSafePath(data, action) {
  const d = data || {};
  if (d.kind === 'missed_call' && isPlausibleId(d.callId)) {
    const path = `/quick-reply/${encodeURIComponent(d.callId)}`;
    // The action id is as untrusted as the ids - same plausibility gate, and an
    // implausible one is DROPPED rather than carried.
    return isPlausibleId(action) ? `${path}#action=${encodeURIComponent(action)}` : path;
  }
  if (isPlausibleId(d.conversationId)) {
    return `/conversations/${encodeURIComponent(d.conversationId)}`;
  }
  // An unmatched email has NO conversation to open - the tap lands on the
  // triage queue page. Checked AFTER conversationId so a payload that does
  // carry a thread still wins.
  if (d.kind === 'unmatched_email') {
    return '/email';
  }
  return '/';
}

/* Last gate before navigate/openWindow: assert same-origin + allow-listed path,
 * else fall back to '/'. The allow-list mirrors routes that ACTUALLY EXIST in
 * App.tsx: '/', '/email', '/quick-reply/<callId>', '/conversations/<id>'.
 * '/email' is an EXACT match on purpose - '/email/quarantine' is a separate tab
 * and never a push target. Both dynamic patterns are single-segment. */
function assertSameOriginPath(path, origin) {
  try {
    const url = new URL(path, origin);
    if (url.origin !== origin) return '/';
    if (
      url.pathname === '/' ||
      url.pathname === '/email' ||
      /^\/quick-reply\/[^/]+$/.test(url.pathname) ||
      /^\/conversations\/[^/]+$/.test(url.pathname)
    ) {
      return `${url.pathname}${url.search}${url.hash}`;
    }
    return '/';
  } catch {
    return '/';
  }
}

/* Focus an existing PWA window if one is open (navigating it to the target),
 * else open a new one. `safePath` is already validated same-origin. */
async function focusOrOpen(safePath, data, action) {
  const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  // Resolve against our own origin; safePath is a validated leading-'/' path.
  const absolute = new URL(safePath, self.location.origin).href;

  for (const client of allClients) {
    if ('focus' in client) {
      // Tell the focused page the action so it can act without a reload, then
      // navigate (navigate may be unsupported on some engines — guarded).
      client.postMessage({ type: 'notificationclick', action: action || null, data });
      await client.focus();
      if ('navigate' in client) {
        try {
          await client.navigate(absolute);
        } catch {
          /* navigation not allowed (cross-origin / unsupported) — ignore */
        }
      }
      return;
    }
  }

  if (self.clients.openWindow) {
    await self.clients.openWindow(absolute);
  }
}
