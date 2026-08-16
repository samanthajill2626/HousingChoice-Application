// SW notification-click routing — the PURE, testable core of how a pushed
// notification maps to a SAME-ORIGIN in-app destination.
//
// SECURITY (C1): the service worker MUST NOT trust a payload-supplied URL.
// `new URL(absolute, origin)` does NOT constrain an absolute off-origin URL
// (e.g. "https://evil.example/phish") — so navigating/openWindow-ing to a
// payload `url` is an open-redirect / phishing sink. Instead we derive the
// target ONLY from known fields (kind + callId/conversationId + action) into a
// fixed same-origin allow-list of paths:
//     '/'                         (fallback)
//     '/quick-reply/<callId>'     (missed_call; optional #action=<id>)
//     '/conversations/<id>'       (message)
// ids are validated as plausible (no slashes, no scheme/control chars) and
// URL-encoded; anything off-list or unparseable falls back to '/'.
//
// NOTE: public/sw.js is a CLASSIC service worker (served statically, NOT
// bundled). It cannot `import` this ES module, so sw.js inlines a verbatim copy
// of resolveSafePath + isPlausibleId + assertSameOriginPath with a comment
// pointing here. THIS module is the source of truth and is unit-tested
// (route.test.ts); keep the two in sync.
//
// RESTORED 2026-08-15 with the missed-call target CHANGED. The original routed
// `missed_call` to `/quick-reply/<callId>` (plus an `#action=` hash for Android
// action buttons). That surface existed in the legacy dashboard and was NOT
// rebuilt - the current router has no `quick-reply` route at all, so the old
// target would land every missed-call tap on the NotFound catch-all. The push
// payload carries `conversationId` alongside `callId`
// (routes/webhooks/voice.ts), so a missed-call tap now opens the caller's
// conversation, which is a real destination and the thread the call entry lives
// in. Action-button taps degrade to the same place rather than auto-sending a
// canned reply. Tracked in docs/issues/quick-reply-surface-not-rebuilt.md;
// re-add the branch here AND in sw.js when that surface returns.

/** The push payload fields this router reads (a subset of the pushed JSON). */
export interface NotificationRouteData {
  kind?: string;
  callId?: string;
  conversationId?: string;
}

// Disallowed id characters: path separators, a scheme colon, whitespace, and
// ASCII control chars (built from a code-point range so the source carries no
// literal control bytes).
const UNSAFE_ID_CHARS = new RegExp('[/\\\\:\\s\\u0000-\\u001f\\u007f]');

/**
 * True when `id` is a plausible opaque identifier safe to embed in a path
 * segment: a non-empty string with no slash, no whitespace, no control chars,
 * and no ':' (which would let a "javascript:"/"data:" scheme slip through when
 * the value is mis-used). Length-bounded to reject absurd inputs.
 */
export function isPlausibleId(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= 256 &&
    !UNSAFE_ID_CHARS.test(id)
  );
}

/**
 * Resolve a SAME-ORIGIN, allow-listed in-app path from the (untrusted) push
 * payload. Never returns an off-origin or absolute URL — only a leading-'/'
 * path. Falls back to '/' for anything it cannot map safely.
 *
 * @param data   the notification's routing data (kind + ids)
 * @param action the action-button id (Android) tapped, if any — appended as a
 *               URL hash so the quick-reply view can pre-select/auto-send it.
 */
export function resolveSafePath(
  data: NotificationRouteData | null | undefined,
  _action?: string | null,
): string {
  const d = data ?? {};

  // `missed_call` deliberately shares the conversation target below: the
  // quick-reply surface does not exist in this dashboard (see the header note),
  // and routing to a path with no route is worse than routing to the thread.
  // `_action` is retained in the signature so re-adding the quick-reply branch
  // later is a pure addition, not a call-site change.
  if (isPlausibleId(d.conversationId)) {
    return `/conversations/${encodeURIComponent(d.conversationId)}`;
  }

  return '/';
}

/**
 * Assert a candidate path resolves to a same-origin URL under the given origin
 * AND its pathname matches the allow-list. Returns the same path when safe,
 * else '/'. This is the LAST gate before client.navigate / clients.openWindow —
 * defence in depth on top of resolveSafePath.
 */
export function assertSameOriginPath(path: string, origin: string): string {
  try {
    const url = new URL(path, origin);
    if (url.origin !== origin) return '/';
    // Allow-list mirrors routes that ACTUALLY EXIST in App.tsx. `/quick-reply/`
    // was removed with the branch above - leaving it here would let a path with
    // no route pass the last gate.
    if (url.pathname === '/' || /^\/conversations\/[^/]+$/.test(url.pathname)) {
      // Re-serialise as a leading-'/' path (drop any host the candidate carried).
      return `${url.pathname}${url.search}${url.hash}`;
    }
    return '/';
  } catch {
    return '/';
  }
}
