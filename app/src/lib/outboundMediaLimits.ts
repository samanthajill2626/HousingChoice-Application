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
