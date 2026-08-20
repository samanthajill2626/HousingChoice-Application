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
//     '/email'                    (unmatched_email; EXACT match, not a prefix)
//     '/quick-reply/<callId>'     (missed_call)
//     '/conversations/<id>'       (message, voicemail)
// ids are validated as plausible (no slashes, no scheme/control chars) and
// URL-encoded; anything off-list or unparseable falls back to '/'.
//
// NOTE: public/sw.js is a CLASSIC service worker (served statically, NOT
// bundled). It cannot `import` this ES module, so sw.js inlines a verbatim copy
// of resolveSafePath + isPlausibleId + assertSameOriginPath with a comment
// pointing here. THIS module is the source of truth and is unit-tested
// (route.test.ts); keep the two in sync.
//
// MISSED-CALL TARGET, 2026-08-20. Between the dashboard rebuild and now, this
// router sent `missed_call` to the caller's conversation because the quick-reply
// surface had not been rebuilt (docs/issues/quick-reply-surface-not-rebuilt.md).
// That surface now exists again at routes/quickReply, so the branch is back:
// `missed_call` deep-links to `/quick-reply/<callId>`, and an Android
// action-button tap rides along as `#action=<id>` so the sheet sends that canned
// reply with no further tap.
//
// The target names a CALL and nothing else. The sheet sends a real SMS on
// arrival with no user gesture, so it resolves the recipient server-side from
// the callId; putting a conversation id in this path or its query would make
// any link the founder opens able to choose who gets texted.

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
 * @param action the action-button id (Android) tapped, if any - appended as a
 *               URL hash so the quick-reply view can auto-send that reply.
 */
export function resolveSafePath(
  data: NotificationRouteData | null | undefined,
  action?: string | null,
): string {
  const d = data ?? {};

  // A MISSED CALL deep-links to the one-tap quick-reply sheet, addressed by
  // callId ALONE. The conversation is deliberately NOT carried here: the sheet
  // sends a real SMS on arrival, so it resolves the recipient from the server's
  // record of the call (GET /api/calls/:callId) rather than from a URL that
  // anyone could hand the founder. Nothing in this path names a recipient.
  if (d.kind === 'missed_call' && isPlausibleId(d.callId)) {
    const path = `/quick-reply/${encodeURIComponent(d.callId)}`;
    // The action id comes from the same untrusted payload as the ids, so it goes
    // through the same plausibility gate and is URL-encoded. An implausible
    // action is DROPPED rather than carried: the sheet then waits for a tap.
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
    // Allow-list mirrors routes that ACTUALLY EXIST in App.tsx: '/', '/email',
    // '/quick-reply/<callId>', '/conversations/<id>'. Nothing goes on this list
    // that does not resolve to a real route - a path with no route would pass
    // the last gate and land the user on the NotFound catch-all. '/email' is an
    // EXACT match on purpose: '/email/quarantine' is a separate tab and never a
    // push target. Both dynamic patterns are single-segment ([^/]+), so a
    // deeper path cannot ride in under an allowed prefix.
    if (
      url.pathname === '/' ||
      url.pathname === '/email' ||
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
