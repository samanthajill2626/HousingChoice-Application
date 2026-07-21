// MediaTranscode -- the ONLY place sharp and @hyzyla/pdfium are imported (adapter
// rule). Converts an uploaded source (webp / oversized jpeg-png / pdf) into a
// Twilio-deliverable JPEG. Verified pipeline (spike 2026-07-16): pdfium renders a
// page to a RAW RGBA buffer via render:'bitmap' (NOT 'sharp' -- that string does
// not exist in 2.1.13), then sharp encodes with explicit raw geometry. Throws on
// a corrupt / undecodable input so the confirm route can return 400.
import sharp, { type Sharp } from 'sharp';
import { PDFiumLibrary } from '@hyzyla/pdfium';
import {
  TRANSCODE_TARGET_MAX_EDGE,
  TRANSCODE_TARGET_MAX_BYTES,
  TRANSCODE_JPEG_QUALITY_LADDER,
  SHARP_MAX_INPUT_PIXELS,
} from '../lib/outboundMediaLimits.js';
import {
  UNIT_PHOTO_TRANSCODE_MAX_EDGE,
  UNIT_PHOTO_TRANSCODE_QUALITY_LADDER,
  UNIT_PHOTO_TRANSCODE_TARGET_BYTES,
  UNIT_PHOTO_SHARP_MAX_INPUT_PIXELS,
} from '../lib/unitPhotoLimits.js';

// Configure sharp ONCE at module load: single libvips thread (no per-op thread
// pool each holding buffers) so the semaphore is the only concurrency knob.
sharp.concurrency(1);

export interface TranscodeResult {
  bytes: Buffer;
  contentType: 'image/jpeg';
  pdfPageCount?: number;
  transcodedFrom: string;
}

/** The per-consumer knobs of the shared image pipeline. MMS outputs must stay
 *  byte-identical, so its profile is built verbatim from the MMS constants. */
export interface TranscodeProfile {
  maxEdge: number;
  qualityLadder: readonly number[];
  targetMaxBytes: number;
  maxInputPixels: number;
}

const MMS_PROFILE: TranscodeProfile = {
  maxEdge: TRANSCODE_TARGET_MAX_EDGE,
  qualityLadder: TRANSCODE_JPEG_QUALITY_LADDER,
  targetMaxBytes: TRANSCODE_TARGET_MAX_BYTES,
  maxInputPixels: SHARP_MAX_INPUT_PIXELS,
};

const UNIT_PHOTO_PROFILE: TranscodeProfile = {
  maxEdge: UNIT_PHOTO_TRANSCODE_MAX_EDGE,
  qualityLadder: UNIT_PHOTO_TRANSCODE_QUALITY_LADDER,
  targetMaxBytes: UNIT_PHOTO_TRANSCODE_TARGET_BYTES,
  maxInputPixels: UNIT_PHOTO_SHARP_MAX_INPUT_PIXELS,
};

// pdfium is a heavy WASM init; keep one library instance for the process.
let pdfiumLib: Awaited<ReturnType<typeof PDFiumLibrary.init>> | undefined;
async function getPdfium(): Promise<Awaited<ReturnType<typeof PDFiumLibrary.init>>> {
  if (pdfiumLib === undefined) pdfiumLib = await PDFiumLibrary.init();
  return pdfiumLib;
}

/** Resize (never enlarge) to the max edge, then walk the quality ladder to land
 *  under the target bytes; if none qualifies, keep the lowest-quality result. */
async function encodeJpeg(pipeline: Sharp, profile: TranscodeProfile): Promise<Buffer> {
  const base = pipeline
    .rotate() // honor EXIF orientation before metadata is stripped
    .resize({ width: profile.maxEdge, height: profile.maxEdge, fit: 'inside', withoutEnlargement: true });
  let last: Buffer | undefined;
  for (const quality of profile.qualityLadder) {
    last = await base.clone().jpeg({ quality, mozjpeg: true }).toBuffer();
    if (last.length <= profile.targetMaxBytes) return last;
  }
  return last as Buffer;
}

async function transcodeImage(bytes: Buffer, transcodedFrom: string, profile: TranscodeProfile): Promise<TranscodeResult> {
  const pipeline = sharp(bytes, { limitInputPixels: profile.maxInputPixels });
  await pipeline.metadata(); // throws on a non-image / over-limit input
  return { bytes: await encodeJpeg(pipeline, profile), contentType: 'image/jpeg', transcodedFrom };
}

/**
 * Points-to-pixels render scale for a PDF page whose longest edge is `longestPoints`.
 * Targets a raster ~TRANSCODE_TARGET_MAX_EDGE px on the long edge, capped at 3x so a
 * tiny page never balloons. CRITICAL: there is NO lower floor - a large page (poster /
 * hostile 14400pt mediabox) MUST scale BELOW 1 so pdfium allocates a ~1600px raster,
 * not the page's full point dimensions (a 14400pt page at scale 1 is a ~830MB raster
 * that OOMs the 2GB box before sharp's limitInputPixels can catch it). Degenerate/zero
 * dims fall back to Letter.
 */
export function pdfRenderScale(longestPoints: number): number {
  const longest = longestPoints > 0 ? longestPoints : 792;
  return Math.min(3, TRANSCODE_TARGET_MAX_EDGE / longest);
}

async function transcodePdf(bytes: Buffer): Promise<TranscodeResult> {
  const lib = await getPdfium();
  const doc = await lib.loadDocument(bytes); // throws on a corrupt pdf
  try {
    const pdfPageCount = doc.getPageCount();
    const page = doc.getPage(0);
    // getOriginalSize() is the PUBLIC size accessor in 2.1.13 (points; getSize is
    // private and takes render options). Fall back to Letter if degenerate.
    const { originalWidth, originalHeight } = page.getOriginalSize();
    const scale = pdfRenderScale(Math.max(originalWidth || 612, originalHeight || 792));
    const r = await page.render({ scale, render: 'bitmap' });
    const pipeline = sharp(Buffer.from(r.data), { raw: { width: r.width, height: r.height, channels: 4 }, limitInputPixels: SHARP_MAX_INPUT_PIXELS });
    return { bytes: await encodeJpeg(pipeline, MMS_PROFILE), contentType: 'image/jpeg', pdfPageCount, transcodedFrom: 'application/pdf' };
  } finally {
    // doc.destroy() frees the whole document incl. its pages (PDFiumPage has no
    // own destroy in 2.1.13) - this is the complete cleanup.
    doc.destroy();
  }
}

/** Convert an uploaded source to a Twilio-deliverable JPEG. Caller decides WHICH
 *  sources reach here (planMmsMedia); this handles image vs pdf by content-type. */
export async function transcodeForMms(bytes: Buffer, sourceType: string): Promise<TranscodeResult> {
  const t = sourceType.trim().toLowerCase();
  if (t === 'application/pdf') return transcodePdf(bytes);
  return transcodeImage(bytes, t, MMS_PROFILE);
}

/** Convert a >5MB unit-photo source into the display rendition (2560/q-ladder
 *  jpeg). Images only - the photo allowlist has no pdf. A >5MB animated gif (or
 *  transparent png) flattens to a single jpeg still - accepted for listing
 *  photos per the design (spec D4); <=5MB sources never reach here (the confirm
 *  route passes them through untouched). */
export async function transcodeForUnitPhoto(bytes: Buffer, sourceType: string): Promise<TranscodeResult> {
  return transcodeImage(bytes, sourceType.trim().toLowerCase(), UNIT_PHOTO_PROFILE);
}
