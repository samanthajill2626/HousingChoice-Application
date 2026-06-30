/**
 * Return `url` ONLY when it is an http(s) URL — otherwise `null`. Guards a
 * user-set link (e.g. a unit's `video_url`, set via the listing edit form and
 * ALSO shown on the public flyer reveal) against script-bearing schemes
 * (`javascript:`, `data:`, `vbscript:`, …) that would execute on click in the
 * page's own origin (XSS). Render an `<a>` only when this returns a value, and
 * use the returned (parsed, normalized) URL as the href.
 */
export function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    // Not an absolute, parseable URL (relative path, garbage, etc.) — reject.
    return null;
  }
}
