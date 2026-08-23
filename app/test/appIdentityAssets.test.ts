import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

const iconDir = path.resolve(import.meta.dirname, '../../dashboard/public/icons');
const cases = [
  ['icon-192.png', 192, '#1f6feb', '#ffffff'],
  ['icon-512.png', 512, '#1f6feb', '#ffffff'],
  ['icon-maskable-512.png', 512, '#1f6feb', '#ffffff'],
  ['icon-nonprod-192.png', 192, '#f4c542', '#292415'],
  ['icon-nonprod-512.png', 512, '#f4c542', '#292415'],
  ['icon-nonprod-maskable-512.png', 512, '#f4c542', '#292415'],
] as const;

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as [
    number,
    number,
    number,
  ];
}

async function digest(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(path.join(iconDir, file))).digest('hex');
}

describe('environment HC icon assets', () => {
  it.each([
    ['icon-source.svg', '#1f6feb', '#ffffff'],
    ['icon-nonprod-source.svg', '#f4c542', '#292415'],
  ] as const)('%s is reviewable path-only artwork', async (file, background, foreground) => {
    const source = await readFile(path.join(iconDir, file), 'utf8');
    expect(source).toContain(`fill="${background}"`);
    expect(source.match(new RegExp(`fill="${foreground}"`, 'g'))).toHaveLength(2);
    expect(source).not.toMatch(/<text\b|font-family|href=/i);
    expect(source.match(/<path\b/g)).toHaveLength(2);
  });

  it.each(cases)(
    '%s has the locked field, HC pixels, and geometry',
    async (file, size, backgroundHex, foregroundHex) => {
      const source = sharp(path.join(iconDir, file));
      const metadata = await source.metadata();
      expect(metadata).toMatchObject({ format: 'png', width: size, height: size });
      expect([3, 4]).toContain(metadata.channels);

      const { data, info } = await source.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const background = rgb(backgroundHex);
      const foreground = rgb(foregroundHex);
      expect([...data.subarray(0, 3)]).toEqual(background);

      const foregroundPoints: Array<[number, number]> = [];
      for (let y = 0; y < info.height; y += 1) {
        for (let x = 0; x < info.width; x += 1) {
          const offset = (y * info.width + x) * info.channels;
          if (
            data[offset] === foreground[0] &&
            data[offset + 1] === foreground[1] &&
            data[offset + 2] === foreground[2]
          ) {
            foregroundPoints.push([x, y]);
          }
        }
      }

      expect(foregroundPoints.length).toBeGreaterThan(size * size * 0.02);
      const pixelAtSourceCoordinate = (sourceX: number, sourceY: number): number[] => {
        const x = Math.round((sourceX * size) / 512);
        const y = Math.round((sourceY * size) / 512);
        const offset = (y * info.width + x) * info.channels;
        return [...data.subarray(offset, offset + 3)];
      };
      for (const point of [
        [120, 170],
        [174, 250],
        [220, 170],
        [350, 170],
        [300, 256],
        [350, 340],
      ] as const) {
        expect(
      pixelAtSourceCoordinate(point[0], point[1]),
          `${file} foreground sample ${point.join(',')}`,
        ).toEqual(foreground);
      }
      expect(
        pixelAtSourceCoordinate(390, 256),
        `${file} must keep the C aperture open`,
      ).toEqual(background);

      const minX = Math.min(...foregroundPoints.map(([x]) => x));
      const maxX = Math.max(...foregroundPoints.map(([x]) => x));
      const minY = Math.min(...foregroundPoints.map(([, y]) => y));
      const maxY = Math.max(...foregroundPoints.map(([, y]) => y));
      expect(Math.abs((minX + maxX) / 2 - (size - 1) / 2)).toBeLessThanOrEqual(size * 0.015);
      expect(Math.abs((minY + maxY) / 2 - (size - 1) / 2)).toBeLessThanOrEqual(size * 0.015);
      if (file.includes('maskable')) {
        expect(minX).toBeGreaterThanOrEqual(51);
        expect(maxX).toBeLessThanOrEqual(460);
        expect(minY).toBeGreaterThanOrEqual(51);
        expect(maxY).toBeLessThanOrEqual(460);
      }
    },
  );

  it.each([
    ['icon-192.png', 'icon-nonprod-192.png'],
    ['icon-512.png', 'icon-nonprod-512.png'],
    ['icon-maskable-512.png', 'icon-nonprod-maskable-512.png'],
  ] as const)('%s and %s are different bytes', async (production, nonProduction) => {
    expect(await digest(production)).not.toBe(await digest(nonProduction));
  });

  it('does not modify the existing monochrome notification badge', async () => {
    expect(await digest('badge-72.png')).toBe(
      'eb34bfbb34d698dd935a8756e71da9c9ae7d687acab418b0b92168d8fd84ce0e',
    );
  });
});
