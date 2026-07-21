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

import { PASSTHROUGH_MAX_BYTES } from './outboundMediaLimits.js';

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

/**
 * The Twilio-carrier-deliverable MMS image types. Narrower than IMAGE_MEDIA_TYPES
 * (which includes webp): Twilio rejects a non-deliverable Content-Type with error
 * 12300. Everything sent to Twilio must be in THIS set.
 */
export const TWILIO_DELIVERABLE_MMS_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
]);

/** True when `type` is a Twilio-deliverable MMS type (case-insensitive). */
export function isTwilioDeliverableType(type: string | undefined): boolean {
  return typeof type === 'string' && TWILIO_DELIVERABLE_MMS_TYPES.has(type.trim().toLowerCase());
}

/** What confirm must do with an uploaded source file to make it MMS-deliverable. */
export type MmsMediaPlan = 'deliver' | 'transcode-image' | 'transcode-pdf' | 'reject';

/**
 * Decide an uploaded file's fate from its Content-Type + size ALONE (no download):
 *  - pdf                      -> rasterize page 1 (transcode-pdf)
 *  - gif                      -> pass through (preserves animation; gif is deliverable)
 *  - small jpeg/png           -> pass through (no needless re-encode)
 *  - webp / oversized jpeg-png-> transcode-image (auto-fit to a deliverable jpeg)
 *  - anything else            -> reject (unreachable; the upload allowlist gates first)
 * The GUARDRAIL test pins that every uploadable type maps to a non-reject plan, so a
 * future uploadable type that Twilio cannot carry fails CI until given a branch.
 */
export function planMmsMedia(sourceType: string, sizeBytes: number): MmsMediaPlan {
  const t = sourceType.trim().toLowerCase();
  if (t === 'application/pdf') return 'transcode-pdf';
  if (t === 'image/gif') return 'deliver';
  if (t === 'image/webp') return 'transcode-image';
  if (t === 'image/jpeg' || t === 'image/png') {
    return sizeBytes <= PASSTHROUGH_MAX_BYTES ? 'deliver' : 'transcode-image';
  }
  return 'reject';
}

// --- Email channel v1 (attachments) -----------------------------------------
// A SEPARATE, WIDER allowlist than the MMS one above, and DELIBERATELY not
// reused by it. Email exchanges DOCUMENTS (its core use case), so the presign +
// confirm pair for email attachments (routes/emailMedia.ts) stores the ORIGINAL
// VERBATIM - there is NO planMmsMedia/transcode step that would rasterize a PDF
// or re-encode a spreadsheet. These types are what a browser/mail client can
// render or download safely for staff-only, authed serving; SVG/HTML stay
// excluded (script-capable) exactly as they are for MMS.

/**
 * Content-Types acceptable as an OUTBOUND email attachment (email-channel v1):
 * raster images + PDF + plain text/CSV + the two OOXML office documents
 * (docx / xlsx). Distinct from INLINE_MEDIA_TYPES (MMS) - wider, and used ONLY
 * by the email attachment presign/confirm gate.
 */
export const EMAIL_ATTACHMENT_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/csv',
  // docx
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  // xlsx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

/** True when `type` is an allowlisted email-attachment type (case-insensitive). */
export function isEmailAttachmentType(type: string | undefined): boolean {
  return typeof type === 'string' && EMAIL_ATTACHMENT_TYPES.has(type.trim().toLowerCase());
}

/**
 * Max bytes for email attachments - the per-file presign cap AND the summed
 * per-message total the send service enforces (spec: 25 MB total, both
 * directions). Deliberately separate from the carrier-tight MMS caps in
 * outboundMediaLimits.ts (those are unrelated and MUST NOT be reused here).
 */
export const EMAIL_MAX_TOTAL_BYTES = 25 * 1024 * 1024;
