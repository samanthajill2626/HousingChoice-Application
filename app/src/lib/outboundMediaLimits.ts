// Outbound MMS limits (design Sec 9). Carrier reality, deliberately tighter
// than the 25MB inbound-mirror cap (which is unrelated and unchanged). Shared by
// the upload endpoint (per-file cap) and the send route (count + total cap). The
// content-type allowlist lives in lib/mediaTypes.ts (isInlineMediaType) and is
// reused verbatim on both surfaces - it is NOT duplicated here.

// CARRIER REALITY, measured 2026-08-20 (see
// docs/issues/outbound-mms-stalls-at-sent-with-no-receipt.md). The numbers below
// used to mirror TWILIO's API ceilings (10 files / 5MB), which is NOT what the
// destination carrier will carry. Every outbound MMS prod had ever sent:
//
//   0.13 - 1.53 MB, 1 to 7 attachments ....... 10 of 10 DELIVERED
//   2.93 MB, 7 attachments ................... 2 of 2 SILENTLY DROPPED
//
// Both failures and two of the successes went to T-Mobile numbers with the same
// 7-attachment count, so neither carrier nor attachment count explains it - only
// bytes. An over-budget MMS is discarded by the carrier with NO delivery receipt
// and NO error code (Twilio's own record stays `sent` with an empty error_code
// forever), so there is nothing to detect after the fact. The only defense is
// never building one.

/** Max attachments on a single outbound SEND (may span several messages). */
export const OUTBOUND_MMS_MAX_MEDIA = 10;

/**
 * Max attachments on ONE message. A send carrying more is SPLIT across messages
 * (planMmsBatches) rather than refused - the founder routinely sends 7-9 photos
 * at once, and refusing that would trade a silent failure for a blocked one.
 */
export const OUTBOUND_MMS_MAX_MEDIA_PER_MESSAGE = 4;

/** Max bytes for a single uploaded file (per-file cap on the upload endpoint). */
export const OUTBOUND_MMS_MAX_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Max summed bytes on ONE outbound message. 1 MB sits below the smallest
 * observed failure (2.93 MB) and below the largest observed success (1.53 MB),
 * with room for the carrier's own MIME overhead. A batch is packed to fit this;
 * it is NOT a whole-send limit any more.
 */
export const OUTBOUND_MMS_MAX_TOTAL_BYTES = 1_000_000;

/** Regex the send route uses to reject any key not minted by our upload endpoint. */
export const UPLOAD_KEY_PATTERN = /^uploads\/[0-9a-f-]+$/;

/**
 * A deliverable jpeg/png at or under this flows through untouched; over it,
 * auto-fit. Was 1 MB until 2026-08-20, which let three ~920 KB PNG screenshots
 * through untranscoded - 2.7 MB of the 2.93 MB that got dropped. A screenshot is
 * the common case here, not an edge case, so the passthrough door is now only
 * wide enough for files already at transcode size.
 */
export const PASSTHROUGH_MAX_BYTES = 250_000;

/** Longest-edge cap (px) for a transcoded MMS rendition. */
export const TRANSCODE_TARGET_MAX_EDGE = 1600;

/**
 * Per-file soft target the JPEG quality ladder aims to get under. 250 KB at the
 * 1600px edge keeps 4 photos inside OUTBOUND_MMS_MAX_TOTAL_BYTES; the ladder
 * steps quality down until it fits.
 */
export const TRANSCODE_TARGET_MAX_BYTES = 250_000;

/** JPEG qualities tried in order until the encoded result is <= TRANSCODE_TARGET_MAX_BYTES. */
export const TRANSCODE_JPEG_QUALITY_LADDER = [82, 72, 62, 52, 42] as const;

/** Presign cap on the ORIGINAL upload (MMS-era ceiling; RCS may raise it). */
export const MMS_UPLOAD_SOURCE_MAX_BYTES = 20 * 1024 * 1024;

/** Max concurrent confirm-time transcodes process-wide (memory bound). */
export const MMS_TRANSCODE_MAX_CONCURRENT = 2;

/** How long a queued confirm waits for a transcode slot before 503. */
export const MMS_TRANSCODE_WAIT_TIMEOUT_MS = 20_000;

/** sharp input-pixel cap: reject absurd dimensions before a full raster decode.
 *  50MP, the same budget as the unit-photo profile (UNIT_PHOTO_SHARP_MAX_INPUT_PIXELS):
 *  ~200MB peak raster per slot behind the SHARED 2-slot transcode gate on the 2GB
 *  box. It was 24MP until 2026-08-19, when a current phone's DEFAULT photo
 *  (5712x4284 = 24,470,208 px) missed the cap by 2% and four of nine attachments
 *  on a prod MMS were refused with "Input image exceeds pixel limit". 48MP-class
 *  camera output is the ordinary case now, not an absurd dimension. */
export const SHARP_MAX_INPUT_PIXELS = 50_000_000;
