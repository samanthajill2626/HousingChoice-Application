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
 *     callId?, conversationId?, actions?: [{ action, title }], url? }
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
  const options = {
    body: data.body || '',
    // The icons ship in the manifest set; reuse the maskable icon.
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    // Carry routing info to notificationclick.
    data: {
      kind: data.kind,
      callId: data.callId,
      conversationId: data.conversationId,
      url: data.url,
    },
    // Android shows action buttons; iOS ignores them (tap deep-links instead).
    actions: Array.isArray(data.actions) ? data.actions.slice(0, 2) : undefined,
    // A missed call is time-sensitive — keep it on screen until acted on.
    requireInteraction: data.kind === 'missed_call',
    tag: data.callId || data.conversationId || undefined,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data = event.notification.data || {};
  const targetUrl = resolveTargetUrl(data, event.action);

  event.waitUntil(focusOrOpen(targetUrl, data, event.action));
});

/* Decide where a click should land. Action-button clicks (Android) and plain
 * taps (iOS) both route to the same deep link; the action id is forwarded to
 * the page (via the URL hash) so the quick-reply view can pre-select / auto-send
 * the chosen canned reply. */
function resolveTargetUrl(data, action) {
  if (data.url) return data.url;
  if (data.kind === 'missed_call' && data.callId) {
    const base = `/quick-reply/${encodeURIComponent(data.callId)}`;
    return action ? `${base}#action=${encodeURIComponent(action)}` : base;
  }
  if (data.conversationId) {
    return `/conversations/${encodeURIComponent(data.conversationId)}`;
  }
  return '/';
}

/* Focus an existing PWA window if one is open (navigating it to the target),
 * else open a new one. */
async function focusOrOpen(targetUrl, data, action) {
  const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const absolute = new URL(targetUrl, self.location.origin).href;

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
