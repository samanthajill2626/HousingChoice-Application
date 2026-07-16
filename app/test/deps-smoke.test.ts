import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { PDFiumLibrary } from '@hyzyla/pdfium';

describe('transcode deps load', () => {
  it('sharp encodes a jpeg', async () => {
    const jpg = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .jpeg()
      .toBuffer();
    const meta = await sharp(jpg).metadata();
    expect(meta.format).toBe('jpeg');
  });

  it('pdfium WASM initializes', async () => {
    const lib = await PDFiumLibrary.init();
    expect(typeof lib.loadDocument).toBe('function');
    lib.destroy();
  });
});
