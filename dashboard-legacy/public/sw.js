/* HousingChoice service worker (M1.4). Plain JS, served statically from
 * dashboard/dist at /sw.js (same-origin — allowed under the app CSP's
 * script-src 'self' / default worker-src fallback). Registered from main.tsx
 * (guarded to prod/https or localhost).
 *
 * Responsibilities (foundation plumbing; Feature Agent 4 wires the UI to the
 * push module that talks to this):
 *   - install/activate: take control immediately (skipWaiting + clients.claim).
 *     NO precaching — the app shell is served fresh by the Express static layer;
 *     this SW exists for PUSH, not offline caching (kept simple & CSP-safe).
 *   - push: show a notification from the pushed JSON. On Android, render the
 *     provided action buttons; iOS ignores actions and the tap deep-links.
 *   - notificationclick: focus/open the PWA and route — a missed-call push to
 *     /quick-reply/<callId>, a message push to /conversations/<conversationId>.
 *     Action-button clicks (Android) carry the action id; a plain tap (iOS)
 *     deep-links to the canned-reply sheet. See PHASE1_CHANGE_ORDER_2.md.
 *
 * Pushed payload shape (server sends JSON):
 *   { title, body, kind: 'missed_call' | 'message' | 'test' | string,
 *     callId?, conversationId?, actions?: [{ action, title }] }
 *
 * SECURITY (C1): we NEVER navigate to a payload-supplied URL — that would be an
 * open-redirect / phishing sink (`new URL(absolute, origin)` does not constrain
 * an absolute off-origin url). The click target is derived ONLY from known
 * fields (kind + callId/conversationId + action) into a fixed same-origin
 * allow-list of paths, then re-asserted same-origin before navigate/openWindow.
 * The routing/validation logic below is a VERBATIM MIRROR of the tested ES
 * module dashboard/src/sw/route.ts (resolveSafePath / isPlausibleId /
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

  const title = data.title || 'HousingChoice';
  // Pre-ring and missed-call alerts are time-sensitive (the founder must see
  // them BEFORE/around a live call), so they get the strongest on-screen
  // treatment we can ask for.
  const timeSensitive = data.kind === 'missed_call' || data.kind === 'pre_ring';
  const tag = data.callId || data.conversationId || undefined;
  const options = {
    body: data.body || '',
    // The icons ship in the manifest set; reuse the maskable icon.
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    // Carry ONLY the known routing fields to notificationclick — never a
    // payload-supplied url (C1: no open-redirect sink).
    data: {
      kind: data.kind,
      callId: data.callId,
      conversationId: data.conversationId,
    },
    // Android shows action buttons; iOS ignores them (tap deep-links instead).
    actions: Array.isArray(data.actions) ? data.actions.slice(0, 2) : undefined,
    // HEADS-UP / "bubble" treatment: a vibration pattern is the key nudge that
    // makes Android surface the notification as an on-screen banner (a "peek")
    // instead of filing it silently into the shade. (iOS ignores `vibrate` but
    // honors the banner per the user's per-PWA notification settings — there is
    // no code lever for heads-up on iOS; see PHASE1_CHANGE_ORDER_3 notes.)
    vibrate: [200, 100, 200],
    // `renotify` re-alerts (peeks again) when a later push reuses the same tag,
    // instead of swapping the existing one in place silently. It REQUIRES a tag
    // — setting it without one throws — so gate it on tag presence.
    renotify: timeSensitive && Boolean(tag),
    // Time-sensitive alerts stay on screen until acted on.
    requireInteraction: timeSensitive,
    tag,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data = event.notification.data || {};
  // Derive a SAFE same-origin path from known fields only (never data.url),
  // then re-assert it is same-origin + allow-listed before any navigation.
  const safePath = assertSameOriginPath(resolveSafePath(data, event.action), self.location.origin);

  event.waitUntil(focusOrOpen(safePath, data, event.action));
});

/* ===========================================================================
 * MIRROR of dashboard/src/sw/route.ts (tested in route.test.ts). Keep in sync.
 * A classic service worker can't import the ES module, so these pure functions
 * are duplicated here verbatim. They guarantee the click target is same-origin
 * and on a fixed allow-list — see the C1 note in the header comment.
 * ======================================================================== */

/* True when `id` is a plausible opaque id safe to embed in a path segment:
 * non-empty, length-bounded, no slash/backslash/scheme-colon/whitespace/control. */
function isPlausibleId(id) {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= 256 &&
    !/[/\\:\s\x00-\x1f]/.test(id)
  );
}

/* Resolve a same-origin, allow-listed in-app PATH from the untrusted payload.
 * Action-button clicks (Android) and plain taps (iOS) both route to the same
 * deep link; the action id is forwarded via the URL hash so the quick-reply
 * view can pre-select / auto-send the chosen canned reply. */
function resolveSafePath(data, action) {
  const d = data || {};
  if (d.kind === 'missed_call' && isPlausibleId(d.callId)) {
    const base = `/quick-reply/${encodeURIComponent(d.callId)}`;
    return action ? `${base}#action=${encodeURIComponent(action)}` : base;
  }
  if (isPlausibleId(d.conversationId)) {
    return `/conversations/${encodeURIComponent(d.conversationId)}`;
  }
  return '/';
}

/* Last gate before navigate/openWindow: assert same-origin + allow-listed path,
 * else fall back to '/'. */
function assertSameOriginPath(path, origin) {
  try {
    const url = new URL(path, origin);
    if (url.origin !== origin) return '/';
    if (
      url.pathname === '/' ||
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
