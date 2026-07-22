import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { PDFDocument, rgb } from 'pdf-lib';
import { transcodeForMms, transcodeForUnitPhoto, pdfRenderScale } from '../src/adapters/mediaTranscode.js';
import { TRANSCODE_TARGET_MAX_EDGE, TRANSCODE_TARGET_MAX_BYTES } from '../src/lib/outboundMediaLimits.js';
import {
  UNIT_PHOTO_TRANSCODE_MAX_EDGE,
  UNIT_PHOTO_TRANSCODE_TARGET_BYTES,
} from '../src/lib/unitPhotoLimits.js';

describe('pdfRenderScale (memory bound: large pages must scale BELOW 1)', () => {
  it('caps upscale at 3x for a tiny page', () => {
    expect(pdfRenderScale(100)).toBe(3);
  });
  it('renders a Letter page near the target edge', () => {
    expect(pdfRenderScale(792)).toBeCloseTo(TRANSCODE_TARGET_MAX_EDGE / 792, 5);
  });
  it('DOWNSCALES a large/hostile page below 1 so the raster stays ~target px (no OOM)', () => {
    // A 14400pt max-mediabox page at scale 1 would be a ~830MB raster. The scale
    // must drop below 1 and keep the rendered long edge near the target.
    const scale = pdfRenderScale(14400);
    expect(scale).toBeLessThan(1);
    expect(14400 * scale).toBeCloseTo(TRANSCODE_TARGET_MAX_EDGE, 0);
  });
  it('falls back to Letter for degenerate zero dims', () => {
    expect(pdfRenderScale(0)).toBeCloseTo(TRANSCODE_TARGET_MAX_EDGE / 792, 5);
  });
});

async function makePdf(nPages: number, fill?: { r: number; g: number; b: number }): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < nPages; i++) {
    const p = doc.addPage([200, 200]);
    if (fill) p.drawRectangle({ x: 0, y: 0, width: 200, height: 200, color: rgb(fill.r, fill.g, fill.b) });
  }
  return Buffer.from(await doc.save());
}

describe('transcodeForMms', () => {
  it('webp -> valid jpeg, dims preserved', async () => {
    const webp = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 200, g: 30, b: 30 } } }).webp().toBuffer();
    const out = await transcodeForMms(webp, 'image/webp');
    expect(out.contentType).toBe('image/jpeg');
    expect(out.transcodedFrom).toBe('image/webp');
    const meta = await sharp(out.bytes).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(640);
    expect(meta.height).toBe(480);
  });

  it('oversized image is downscaled to the max edge', async () => {
    const big = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: { r: 10, g: 10, b: 10 } } }).png().toBuffer();
    const out = await transcodeForMms(big, 'image/png');
    const meta = await sharp(out.bytes).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(TRANSCODE_TARGET_MAX_EDGE);
    expect(out.bytes.length).toBeLessThanOrEqual(TRANSCODE_TARGET_MAX_BYTES);
  });

  it('pdf -> page count + page 1 rasterized to a COLOR-ACCURATE jpeg', async () => {
    const out = await transcodeForMms(await makePdf(3, { r: 1, g: 0, b: 0 }), 'application/pdf');
    expect(out.contentType).toBe('image/jpeg');
    expect(out.pdfPageCount).toBe(3);
    const { data, info } = await sharp(out.bytes).raw().toBuffer({ resolveWithObject: true });
    const mid = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels;
    expect(data[mid]).toBeGreaterThan(200);      // red channel high
    expect(data[mid + 2]).toBeLessThan(60);       // blue channel low -> not BGRA-swapped
  });

  it('single-page pdf reports pageCount 1', async () => {
    const out = await transcodeForMms(await makePdf(1), 'application/pdf');
    expect(out.pdfPageCount).toBe(1);
  });

  it('corrupt pdf throws', async () => {
    await expect(transcodeForMms(Buffer.from('NOT A PDF'), 'application/pdf')).rejects.toThrow();
  });

  it('non-image bytes throw', async () => {
    await expect(transcodeForMms(Buffer.from('NOT AN IMAGE'), 'image/webp')).rejects.toThrow();
  });
});

describe('transcodeForUnitPhoto (photo profile - gentler than MMS)', () => {
  it('downscales an oversized photo to the 2560 max edge as jpeg under the soft target', async () => {
    const big = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: { r: 40, g: 90, b: 200 } } }).png().toBuffer();
    const out = await transcodeForUnitPhoto(big, 'image/png');
    expect(out.contentType).toBe('image/jpeg');
    const meta = await sharp(out.bytes).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(UNIT_PHOTO_TRANSCODE_MAX_EDGE);
    expect(out.bytes.length).toBeLessThanOrEqual(UNIT_PHOTO_TRANSCODE_TARGET_BYTES);
  });

  it('never enlarges a small source', async () => {
    const small = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 10, g: 10, b: 10 } } }).webp().toBuffer();
    const out = await transcodeForUnitPhoto(small, 'image/webp');
    const meta = await sharp(out.bytes).metadata();
    expect(meta.width).toBe(640);
    expect(meta.height).toBe(480);
  });

  it('accepts a 27MP source the MMS 24MP cap rejects (per-profile pixel caps)', async () => {
    // 6000x4500 = 27,000,000 px: over SHARP_MAX_INPUT_PIXELS (24MP), under the
    // photo profile's 50MP.
    const huge = await sharp({ create: { width: 6000, height: 4500, channels: 3, background: { r: 128, g: 128, b: 128 } } }).png().toBuffer();
    await expect(transcodeForMms(huge, 'image/png')).rejects.toThrow();
    const out = await transcodeForUnitPhoto(huge, 'image/png');
    expect(out.contentType).toBe('image/jpeg');
  });

  it('corrupt photo input throws (confirm route maps it to 400)', async () => {
    await expect(transcodeForUnitPhoto(Buffer.from('not an image'), 'image/jpeg')).rejects.toThrow();
  });
});
