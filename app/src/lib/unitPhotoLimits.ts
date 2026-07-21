// Unit-photo upload limits (design 2026-07-21-unit-photo-transcode). Gentler
// than the carrier-tight MMS targets in outboundMediaLimits.ts: photos are
// DISPLAY assets (staff gallery + public flyer), so the rendition targets
// full-screen quality - and only sources OVER the old 5MB cap are touched at
// all. Shared by the photo presign/confirm routes and the transcode adapter.

/** Presign policy cap on the ORIGINAL upload (S3-enforced content-length-range). */
export const UNIT_PHOTO_SOURCE_MAX_BYTES = 20 * 1024 * 1024;

/**
 * At/under this a source is stored byte-identical (every previously-working
 * upload keeps today's behavior); only sources OVER it are transcoded. Also
 * the size invariant every STORED photo must satisfy (renditions re-checked).
 */
export const UNIT_PHOTO_PASSTHROUGH_MAX_BYTES = 5 * 1024 * 1024;

/** Longest-edge cap (px) for a transcoded photo rendition. */
export const UNIT_PHOTO_TRANSCODE_MAX_EDGE = 2560;

/** JPEG qualities tried in order until the encode is <= the soft target. */
export const UNIT_PHOTO_TRANSCODE_QUALITY_LADDER = [85, 78, 70] as const;

/** Soft byte target the ladder aims under (lowest-quality result kept if none
 *  qualifies, then re-checked against the 5MB stored-photo invariant). */
export const UNIT_PHOTO_TRANSCODE_TARGET_BYTES = 3 * 1024 * 1024;

/** sharp input-pixel cap for photo sources: 48MP-class phone photos decode
 *  (~200MB peak RGBA raster per gate slot, bounded by the SHARED 2-slot gate
 *  on the 2GB box). MMS keeps its tighter 24MP cap. */
export const UNIT_PHOTO_SHARP_MAX_INPUT_PIXELS = 50_000_000;

/**
 * Max >5MB sources ONE confirm request may transcode. The dashboard sends each
 * oversize file in its OWN confirm (D5 chunking), so a real client submits 1;
 * this bounds the WORST case a hand-crafted body can impose on the SHARED 2-slot
 * transcode gate. Without it a single 100-big-key body would hold a gate slot
 * for tens of minutes (up to 100 serial downloads + sharp runs), starving MMS
 * confirm and every other photo confirm. Over this -> 400 too_many_large_photos,
 * rejected BEFORE any download/transcode.
 */
export const UNIT_PHOTO_TRANSCODE_MAX_PER_REQUEST = 4;
