// One source of truth for which MMS media Content-Types are safe to render
// INLINE in the dashboard, shared by the WRITE side (webhooks/twilio.ts mirror,
// which normalizes the sender-supplied type before storing) and the READ side
// (routes/api.ts media-serve, which only serves these inline). MMS
// MediaContentType{i} is attacker-controlled, so anything off this list is
// treated as an opaque download — never rendered same-origin (stored-XSS guard).
//
// Raster images + PDF. A browser's built-in PDF viewer runs PDF content in its
// own sandbox: embedded PDF JS cannot reach the SERVING ORIGIN's DOM or cookies,
// so a malicious PDF can't achieve same-origin XSS here (combined with nosniff,
// which stops it being reinterpreted as HTML). PDF is still richer than an image
// (it can attempt outbound navigation/phishing within the viewer), an accepted
// trade-off since the bytes are already authed-staff-only. SVG / HTML / XHTML stay
// DELIBERATELY EXCLUDED — they DO run script on top-level navigation. Pure, no I/O.

/**
 * The raster image Content-Types (the single source of truth for "is an image").
 * Property-photo uploads (routes/units.ts) allow EXACTLY these - narrower than
 * the inline allowlist below, which also tolerates PDF for inbound MMS.
 */
export const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

/** Content-Types served inline (everything else -> octet-stream download). */
export const INLINE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  ...IMAGE_MEDIA_TYPES,
  'application/pdf',
]);

/** True when `type` is an allowlisted inline type (case-insensitive). */
export function isInlineMediaType(type: string | undefined): boolean {
  return typeof type === 'string' && INLINE_MEDIA_TYPES.has(type.trim().toLowerCase());
}

/**
 * True when `type` is an allowlisted raster IMAGE (case-insensitive) - the
 * property-photo upload guard (images only: jpeg/png/gif/webp, no PDF).
 */
export function isImageMediaType(type: string | undefined): boolean {
  return typeof type === 'string' && IMAGE_MEDIA_TYPES.has(type.trim().toLowerCase());
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
