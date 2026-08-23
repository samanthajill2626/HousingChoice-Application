import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const iconDir = path.resolve(import.meta.dirname, '../../dashboard/public/icons');
const variants = [
  { source: 'icon-source.svg', prefix: 'icon' },
  { source: 'icon-nonprod-source.svg', prefix: 'icon-nonprod' },
] as const;
const targets = [
  { file: '192', size: 192 },
  { file: '512', size: 512 },
  { file: 'maskable-512', size: 512 },
] as const;

await mkdir(iconDir, { recursive: true });
for (const variant of variants) {
  for (const target of targets) {
    await sharp(path.join(iconDir, variant.source))
      .resize(target.size, target.size, { fit: 'fill' })
      .png({ compressionLevel: 9 })
      .toFile(path.join(iconDir, `${variant.prefix}-${target.file}.png`));
  }
}
