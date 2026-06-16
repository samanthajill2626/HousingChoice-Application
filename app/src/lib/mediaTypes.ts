// One source of truth for which MMS media Content-Types are safe to render
// INLINE in the dashboard, shared by the WRITE side (webhooks/twilio.ts mirror,
// which normalizes the sender-supplied type before storing) and the READ side
// (routes/api.ts media-serve, which only serves these inline). MMS
// MediaContentType{i} is attacker-controlled, so anything off this list is
// treated as an opaque download — never rendered same-origin (stored-XSS guard).
//
// Raster images only. SVG is DELIBERATELY EXCLUDED: it is an image but can carry
// script and execute it on top-level navigation. Pure, no I/O.

/** Content-Types served inline (everything else → octet-stream download). */
export const INLINE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

/** True when `type` is an allowlisted inline raster image (case-insensitive). */
export function isInlineMediaType(type: string | undefined): boolean {
  return typeof type === 'string' && INLINE_MEDIA_TYPES.has(type.trim().toLowerCase());
}

/**
 * Normalize a sender-supplied MMS Content-Type for STORAGE: keep it (lowercased)
 * only when it's an allowlisted inline image, otherwise collapse to
 * `application/octet-stream` — so an attacker-controlled type (text/html,
 * image/svg+xml, …) is never persisted as the object's Content-Type. Layer 1 of
 * the stored-XSS defense; routes/api.ts re-checks at serve time (layer 2).
 */
export function normalizeStoredMediaType(raw: string | undefined): string {
  return isInlineMediaType(raw) ? raw!.trim().toLowerCase() : 'application/octet-stream';
}
