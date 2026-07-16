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

// Configure sharp ONCE at module load: single libvips thread (no per-op thread
// pool each holding buffers) so the semaphore is the only concurrency knob.
sharp.concurrency(1);

export interface TranscodeResult {
  bytes: Buffer;
  contentType: 'image/jpeg';
  pdfPageCount?: number;
  transcodedFrom: string;
}

// pdfium is a heavy WASM init; keep one library instance for the process.
let pdfiumLib: Awaited<ReturnType<typeof PDFiumLibrary.init>> | undefined;
async function getPdfium(): Promise<Awaited<ReturnType<typeof PDFiumLibrary.init>>> {
  if (pdfiumLib === undefined) pdfiumLib = await PDFiumLibrary.init();
  return pdfiumLib;
}

/** Resize (never enlarge) to the max edge, then walk the quality ladder to land
 *  under the target bytes; if none qualifies, keep the lowest-quality result. */
async function encodeJpeg(pipeline: Sharp): Promise<Buffer> {
  const base = pipeline
    .rotate() // honor EXIF orientation before metadata is stripped
    .resize({ width: TRANSCODE_TARGET_MAX_EDGE, height: TRANSCODE_TARGET_MAX_EDGE, fit: 'inside', withoutEnlargement: true });
  let last: Buffer | undefined;
  for (const quality of TRANSCODE_JPEG_QUALITY_LADDER) {
    last = await base.clone().jpeg({ quality, mozjpeg: true }).toBuffer();
    if (last.length <= TRANSCODE_TARGET_MAX_BYTES) return last;
  }
  return last as Buffer;
}

async function transcodeImage(bytes: Buffer, transcodedFrom: string): Promise<TranscodeResult> {
  const pipeline = sharp(bytes, { limitInputPixels: SHARP_MAX_INPUT_PIXELS });
  await pipeline.metadata(); // throws on a non-image / over-limit input
  return { bytes: await encodeJpeg(pipeline), contentType: 'image/jpeg', transcodedFrom };
}

async function transcodePdf(bytes: Buffer): Promise<TranscodeResult> {
  const lib = await getPdfium();
  const doc = await lib.loadDocument(bytes); // throws on a corrupt pdf
  try {
    const pdfPageCount = doc.getPageCount();
    const page = doc.getPage(0);
    // Render page 1 near the target edge; clamp the scale to [1, 3].
    // getOriginalSize() is the PUBLIC size accessor in 2.1.13 (points; getSize
    // is private and takes render options). Fall back to Letter if degenerate.
    const { originalWidth, originalHeight } = page.getOriginalSize();
    const longest = Math.max(originalWidth || 612, originalHeight || 792);
    const scale = Math.min(3, Math.max(1, TRANSCODE_TARGET_MAX_EDGE / longest));
    const r = await page.render({ scale, render: 'bitmap' });
    const pipeline = sharp(Buffer.from(r.data), { raw: { width: r.width, height: r.height, channels: 4 }, limitInputPixels: SHARP_MAX_INPUT_PIXELS });
    return { bytes: await encodeJpeg(pipeline), contentType: 'image/jpeg', pdfPageCount, transcodedFrom: 'application/pdf' };
  } finally {
    doc.destroy();
  }
}

/** Convert an uploaded source to a Twilio-deliverable JPEG. Caller decides WHICH
 *  sources reach here (planMmsMedia); this handles image vs pdf by content-type. */
export async function transcodeForMms(bytes: Buffer, sourceType: string): Promise<TranscodeResult> {
  const t = sourceType.trim().toLowerCase();
  if (t === 'application/pdf') return transcodePdf(bytes);
  return transcodeImage(bytes, t);
}
