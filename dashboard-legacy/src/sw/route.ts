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
// bundled — see vite.config.ts / dashboard-legacy/public/). It cannot `import` this
// ES module, so sw.js inlines a verbatim copy of resolveSafePath +
// isPlausibleId + assertSameOriginPath with a comment pointing here. THIS
// module is the source of truth and is unit-tested (route.test.ts); keep the
// two in sync.

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
  action?: string | null,
): string {
  const d = data ?? {};

  if (d.kind === 'missed_call' && isPlausibleId(d.callId)) {
    const base = `/quick-reply/${encodeURIComponent(d.callId)}`;
    if (typeof action === 'string' && action.length > 0) {
      return `${base}#action=${encodeURIComponent(action)}`;
    }
    return base;
  }

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
    if (
      url.pathname === '/' ||
      /^\/quick-reply\/[^/]+$/.test(url.pathname) ||
      /^\/conversations\/[^/]+$/.test(url.pathname)
    ) {
      // Re-serialise as a leading-'/' path (drop any host the candidate carried).
      return `${url.pathname}${url.search}${url.hash}`;
    }
    return '/';
  } catch {
    return '/';
  }
}
