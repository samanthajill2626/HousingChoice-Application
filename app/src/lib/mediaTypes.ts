// One source of truth for the THREE media-type tiers, shared by the WRITE side
// (services/mediaMirror.ts for inbound MMS and services/inboundEmail.ts for
// inbound email, both of which normalize the sender-supplied type before
// storing) and the READ side (routes/api.ts media-serve). MMS
// MediaContentType{i} and an email part's Content-Type are attacker-controlled,
// so the tier - never the caller's string - decides what is emitted:
//   INLINE     rendered same-origin (INLINE_MEDIA_TYPES below),
//   DECLARABLE served with its TRUE type but ALWAYS as a download,
//   OPAQUE     everything else, collapsed to application/octet-stream.
// Nothing off the first two lists is ever rendered same-origin (stored-XSS
// guard). See resolveMediaTier below, which is where all three are decided.
//
// THE INLINE TIER, in detail (the declarable one is documented at its own set):
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
 * Types served with their TRUE Content-Type but ALWAYS as a download
 * (Content-Disposition: attachment) - never rendered same-origin. None is
 * script-capable, which is the whole entry criterion: a browser handed one of
 * these cannot execute anything in the dashboard origin.
 *
 * DELIBERATELY EXCLUDED, permanently: text/html, application/xhtml+xml,
 * image/svg+xml, text/xml, application/xml, application/javascript. Those DO
 * run script on top-level navigation and stay on the opaque tier forever.
 */
export const DECLARABLE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'video/mp4',
  'video/quicktime',
  'video/3gpp',
  'video/3gpp2',
  'video/webm',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/ogg',
  'audio/amr',
  'audio/wav',
  'image/heic',
  'image/heif',
  'image/bmp',
  'image/tiff',
  'text/vcard',
  'text/x-vcard',
  'text/plain',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

/**
 * The EMISSION map: canonical type -> the ONE extension we synthesize for it.
 * Do NOT build the accepted-extension set below out of these values - see the
 * comment there for why that is a defect rather than a shortcut.
 *
 * Duplicated by design with EMAIL_EXTENSIONS (services/sendEmailMessage.ts),
 * which names an OUTBOUND MIME part rather than a download we offer. Neither
 * feeds a security decision, so the divergence is cosmetic and merging them is
 * out of scope (spec non-goal 4).
 */
const MEDIA_TYPE_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
  ['application/pdf', '.pdf'],
  ['video/mp4', '.mp4'],
  ['video/quicktime', '.mov'],
  ['video/3gpp', '.3gp'],
  ['video/3gpp2', '.3g2'],
  ['video/webm', '.webm'],
  ['audio/mpeg', '.mp3'],
  ['audio/mp4', '.m4a'],
  ['audio/aac', '.aac'],
  ['audio/ogg', '.ogg'],
  ['audio/amr', '.amr'],
  ['audio/wav', '.wav'],
  ['image/heic', '.heic'],
  ['image/heif', '.heif'],
  ['image/bmp', '.bmp'],
  ['image/tiff', '.tiff'],
  ['text/vcard', '.vcf'],
  ['text/x-vcard', '.vcf'],
  ['text/plain', '.txt'],
  ['text/csv', '.csv'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
]);

/**
 * Extensions we will KEEP off a stored filename when the type itself is
 * unrecoverable (the opaque tier). Wider than the emission map on purpose: the
 * map emits `.jpg`, so a set derived from its values would reject `photo.jpeg`
 * and produce `photo.bin` - exactly the outcome the opaque-tier rule exists to
 * prevent. Hand-written, exhaustive, and containing no active extension EVER:
 * this set decides what reaches an operator's filesystem.
 */
const ACCEPTED_EXTENSIONS: ReadonlySet<string> = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.heif',
  '.mp4', '.m4v', '.mov', '.3gp', '.3g2', '.webm',
  '.mp3', '.m4a', '.aac', '.oga', '.ogg', '.amr', '.wav',
  '.pdf', '.txt', '.csv', '.vcf', '.docx', '.xlsx',
]);

export type MediaTier = 'inline' | 'declarable' | 'opaque';

export interface ResolvedMediaType {
  tier: MediaTier;
  /** The allowlist's OWN string - never the caller's. */
  canonical: string;
  /** The extension we synthesize for `canonical`. `.bin` on the opaque tier. */
  ext: string;
}

/** Fresh object per call - never a shared mutable constant a caller could
 *  alter for everyone else. */
function opaque(): ResolvedMediaType {
  return { tier: 'opaque', canonical: 'application/octet-stream', ext: '.bin' };
}

/**
 * THE one tier decision. Every caller - the serve route, the write-side
 * normalizer - goes through this, so the tier, the response Content-Type and
 * the synthesized extension can never disagree with each other.
 *
 * Matches on the media-type ESSENCE (everything before the first `;`) because
 * `text/plain; charset=utf-8` and `video/3gpp; codecs=...` are ordinary wire
 * forms; an exact-string lookup drops them to the opaque tier and silently
 * defeats the feature for the types it adds.
 *
 * SECURITY: this NEWLY ADMITS the parameterized forms of ALLOWLISTED types -
 * `image/png; charset=x` now reaches the inline tier. That is safe because of
 * the CANONICAL OUTPUT, not the matching: the response header is our own
 * constant, so a caller-supplied parameterized string never reaches a header.
 * Non-allowlisted types are unaffected - `text/html; charset=x` has essence
 * `text/html` and still fails both sets.
 */
export function resolveMediaTier(raw: string | undefined): ResolvedMediaType {
  if (typeof raw !== 'string') return opaque();
  const essence = raw.split(';')[0]!.trim().toLowerCase();
  if (essence.length === 0) return opaque();
  const tier: MediaTier | undefined = INLINE_MEDIA_TYPES.has(essence)
    ? 'inline'
    : DECLARABLE_MEDIA_TYPES.has(essence)
      ? 'declarable'
      : undefined;
  if (tier === undefined) return opaque();
  return { tier, canonical: essence, ext: MEDIA_TYPE_EXTENSIONS.get(essence) ?? '.bin' };
}

/** True when `ext` (leading dot included) is one we are willing to emit. */
export function isAcceptedExtension(ext: string): boolean {
  return ACCEPTED_EXTENSIONS.has(ext.trim().toLowerCase());
}

/**
 * Declarable types the browser should HAND OFF rather than save: video and
 * audio. These are served `Content-Disposition: inline`, which does NOT mean
 * we render anything - it means "browser, this is yours", and the browser or
 * phone opens it in its own native player, exactly as it already does for the
 * PDFs on the inline tier. We build no viewer.
 *
 * Why only these two. A HEIC or TIFF handed to a browser inline is a broken
 * image on most platforms (they are on the declarable tier precisely BECAUSE
 * the browser cannot decode them), and a vCard or spreadsheet rendered in a
 * tab is worse than a saved file the OS can route to the right app. Video and
 * audio are the types where "open it" is unambiguously better than "save it",
 * and their decoders execute no script - which is why widening the disposition
 * for them does not widen the stored-XSS surface the way an active type would.
 */
const HANDOFF_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'video/mp4',
  'video/quicktime',
  'video/3gpp',
  'video/3gpp2',
  'video/webm',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/ogg',
  'audio/amr',
  'audio/wav',
]);

/**
 * True for the VIDEO AND AUDIO hand-off set specifically - NOT the inline tier.
 * Kept separate from `isHandoffMediaType` because these two families are the
 * only ones that need a relaxed CSP (see `mediaCspFor`): images and PDF already
 * render correctly under the strict one and must keep it.
 */
export function isPlayableMediaType(resolved: ResolvedMediaType): boolean {
  return HANDOFF_MEDIA_TYPES.has(resolved.canonical);
}

/**
 * True when a resolved type should be served `inline` rather than `attachment`.
 * The inline TIER always is (images + PDF); on the declarable tier only the
 * hand-off types above are. Everything else keeps `attachment`.
 */
export function isHandoffMediaType(resolved: ResolvedMediaType): boolean {
  return resolved.tier === 'inline' || isPlayableMediaType(resolved);
}

/**
 * The Content-Security-Policy for one media response.
 *
 * EVERYTHING keeps `default-src 'none'`, so no script, frame, or subresource
 * can ever load from one of these documents. What differs is video and audio,
 * and BOTH differences were proven necessary by a real browser (dev, 2026-08-31)
 * rather than reasoned about:
 *
 *   "Loading media ... violates ... default-src 'none'. Note that 'media-src'
 *    was not explicitly set, so 'default-src' is used as a fallback."
 *   "Blocked script execution ... because the document's frame is sandboxed
 *    and the 'allow-scripts' permission is not set."
 *
 * So a video needs (a) `media-src` to permit its own bytes, and (b) no
 * `sandbox`, because the browser's built-in player UI is script-driven. The two
 * are coupled: `sandbox` puts the document in an OPAQUE ORIGIN, in which
 * `'self'` matches nothing, so adding `media-src 'self'` while keeping
 * `sandbox` fails exactly as before.
 *
 * Dropping `sandbox` for these two families is safe, and narrowly so:
 *  - the type is from a closed allowlist, so only video and audio arrive here;
 *  - `default-src 'none'` still blocks every script, frame and subresource, so
 *    nothing in the document can load or execute code;
 *  - a video or audio container cannot carry script the way HTML or SVG can,
 *    which is the whole reason these types are declarable in the first place.
 *
 * Images, PDF, every other declarable type and the opaque tier keep the
 * original strict policy untouched - they already work under it.
 */
export function mediaCspFor(resolved: ResolvedMediaType): string {
  return isPlayableMediaType(resolved)
    ? "default-src 'none'; media-src 'self'"
    : "default-src 'none'; sandbox";
}

/**
 * Normalize a sender-supplied Content-Type for STORAGE: keep the CANONICAL
 * allowlist member when the type resolves to the inline OR the declarable tier,
 * otherwise collapse to `application/octet-stream` - so an attacker-controlled
 * type (text/html, image/svg+xml, ...) is never persisted as the object's
 * Content-Type. Layer 1 of the stored-XSS defense; routes/api.ts re-checks at
 * serve time (layer 2).
 *
 * WIDENED: it used to keep only the inline set, which destroyed the real type
 * of every video, audio clip, vCard and office document at mirror time. The
 * declarable tier is served truthfully but ALWAYS as a download, so nothing
 * script-capable gained ground - see resolveMediaTier.
 */
export function normalizeStoredMediaType(raw: string | undefined): string {
  return resolveMediaTier(raw).canonical;
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
