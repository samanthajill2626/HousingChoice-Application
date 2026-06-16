import { describe, expect, test } from 'vitest';
import { cannedAssets, cannedLabelFor } from './index.js';

// Regression: the canned assets used to be Vite `import`s of sub-4KB SVGs, which
// Vite inlined as `data:image/svg+xml;base64,…` URIs. The engine's media guard
// (sendAsParty → isHttpUrl, `new URL(s)` + http/https check) rejected those, so
// picking a canned image errored the send. These MUST be real, absolute http(s)
// URLs the guard accepts and the dashboard browser can fetch.
describe('canned assets', () => {
  test('every asset url is an absolute http(s) URL (not a data: URI)', () => {
    expect(cannedAssets.length).toBeGreaterThan(0);
    for (const asset of cannedAssets) {
      // Mirrors the engine's isHttpUrl(): a bare path or data: URI fails here.
      const u = new URL(asset.url);
      expect(['http:', 'https:']).toContain(u.protocol);
      expect(asset.url).not.toMatch(/^data:/);
      expect(u.pathname).toBe(`/canned/${asset.id}.svg`);
    }
  });

  test('cannedLabelFor resolves a known url back to its label, else falls back', () => {
    const room = cannedAssets.find((a) => a.id === 'room')!;
    expect(cannedLabelFor(room.url)).toBe(room.label);
    expect(cannedLabelFor('http://example.com/unknown.png')).toBe('Attachment');
  });
});
