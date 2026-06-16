import { describe, expect, test } from 'vitest';
import { cannedAssets, cannedLabelFor, isImageAsset } from './index.js';

// Regression: the canned assets used to be Vite `import`s of sub-4KB SVGs, which
// Vite inlined as `data:image/svg+xml;base64,…` URIs. The engine's media guard
// (sendAsParty → isHttpUrl, `new URL(s)` + http/https check) rejected those, so
// picking a canned image errored the send. They are now committed PNG/PDF static
// files at real, absolute http(s) URLs the guard accepts, the inbound mirror can
// fetch, and the dashboard's allowlist (raster + PDF) renders.
const EXT: Record<string, string> = { room: 'png', kitchen: 'png', 'lease-doc': 'pdf' };

describe('canned assets', () => {
  test('every asset url is an absolute http(s) URL (not a data: URI)', () => {
    expect(cannedAssets.length).toBeGreaterThan(0);
    for (const asset of cannedAssets) {
      // Mirrors the engine's isHttpUrl(): a bare path or data: URI fails here.
      const u = new URL(asset.url);
      expect(['http:', 'https:']).toContain(u.protocol);
      expect(asset.url).not.toMatch(/^data:/);
      expect(u.pathname).toBe(`/canned/${asset.id}.${EXT[asset.id]}`);
    }
  });

  test('asset types are raster images except the lease-doc PDF', () => {
    expect(isImageAsset(cannedAssets.find((a) => a.id === 'room')!.url)).toBe(true);
    expect(isImageAsset(cannedAssets.find((a) => a.id === 'kitchen')!.url)).toBe(true);
    expect(isImageAsset(cannedAssets.find((a) => a.id === 'lease-doc')!.url)).toBe(false);
  });

  test('cannedLabelFor resolves a known url back to its label, else falls back', () => {
    const room = cannedAssets.find((a) => a.id === 'room')!;
    expect(cannedLabelFor(room.url)).toBe(room.label);
    expect(cannedLabelFor('http://example.com/unknown.png')).toBe('Attachment');
  });
});
