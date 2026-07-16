// Outbound MMS limits (design Sec 9). Carrier reality, deliberately tighter
// than the 25MB inbound-mirror cap (which is unrelated and unchanged). Shared by
// the upload endpoint (per-file cap) and the send route (count + total cap). The
// content-type allowlist lives in lib/mediaTypes.ts (isInlineMediaType) and is
// reused verbatim on both surfaces - it is NOT duplicated here.

/** Max number of media attachments on a single outbound send. */
export const OUTBOUND_MMS_MAX_MEDIA = 10;

/** Max bytes for a single uploaded file (per-file cap on the upload endpoint). */
export const OUTBOUND_MMS_MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Max summed bytes across all attachments on one send (carrier MMS budget). */
export const OUTBOUND_MMS_MAX_TOTAL_BYTES = 5 * 1024 * 1024;

/** Regex the send route uses to reject any key not minted by our upload endpoint. */
export const UPLOAD_KEY_PATTERN = /^uploads\/[0-9a-f-]+$/;

/** A deliverable jpeg/png at or under this flows through untouched; over it, auto-fit. */
export const PASSTHROUGH_MAX_BYTES = 1_000_000;

/** Longest-edge cap (px) for a transcoded MMS rendition. */
export const TRANSCODE_TARGET_MAX_EDGE = 1600;

/** Per-file soft target the JPEG quality ladder aims to get under. */
export const TRANSCODE_TARGET_MAX_BYTES = 1_500_000;

/** JPEG qualities tried in order until the encoded result is <= TRANSCODE_TARGET_MAX_BYTES. */
export const TRANSCODE_JPEG_QUALITY_LADDER = [82, 72, 62, 52, 42] as const;

/** Presign cap on the ORIGINAL upload (MMS-era ceiling; RCS may raise it). */
export const MMS_UPLOAD_SOURCE_MAX_BYTES = 20 * 1024 * 1024;

/** Max concurrent confirm-time transcodes process-wide (memory bound). */
export const MMS_TRANSCODE_MAX_CONCURRENT = 2;

/** How long a queued confirm waits for a transcode slot before 503. */
export const MMS_TRANSCODE_WAIT_TIMEOUT_MS = 20_000;

/** sharp input-pixel cap: reject absurd dimensions before a full raster decode. */
export const SHARP_MAX_INPUT_PIXELS = 24_000_000;
