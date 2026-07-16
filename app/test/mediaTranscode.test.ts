import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { PDFDocument, rgb } from 'pdf-lib';
import { transcodeForMms } from '../src/adapters/mediaTranscode.js';
import { TRANSCODE_TARGET_MAX_EDGE, TRANSCODE_TARGET_MAX_BYTES } from '../src/lib/outboundMediaLimits.js';

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
