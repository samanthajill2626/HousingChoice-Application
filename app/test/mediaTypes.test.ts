// Unit tests for the shared MMS media-type allowlist (the stored-XSS guard used
// by BOTH the mirror write path and the media-serve read path).
import { describe, expect, it } from 'vitest';
import {
  INLINE_MEDIA_TYPES,
  isInlineMediaType,
  normalizeStoredMediaType,
} from '../src/lib/mediaTypes.js';

describe('isInlineMediaType', () => {
  it('accepts the allowlisted types (case-insensitive, trimmed)', () => {
    for (const t of INLINE_MEDIA_TYPES) expect(isInlineMediaType(t)).toBe(true);
    expect(isInlineMediaType('IMAGE/JPEG')).toBe(true);
    expect(isInlineMediaType('  image/png  ')).toBe(true);
  });

  it('accepts application/pdf (browser viewer sandboxes embedded JS)', () => {
    expect(isInlineMediaType('application/pdf')).toBe(true);
    expect(isInlineMediaType('APPLICATION/PDF')).toBe(true);
  });

  it('rejects script-capable / non-image / absent types', () => {
    expect(isInlineMediaType('text/html')).toBe(false);
    expect(isInlineMediaType('image/svg+xml')).toBe(false); // image, but scriptable
    expect(isInlineMediaType('application/xhtml+xml')).toBe(false);
    expect(isInlineMediaType('application/octet-stream')).toBe(false);
    expect(isInlineMediaType(undefined)).toBe(false);
    expect(isInlineMediaType('')).toBe(false);
  });
});

describe('normalizeStoredMediaType', () => {
  it('keeps an allowlisted type (lowercased)', () => {
    expect(normalizeStoredMediaType('image/jpeg')).toBe('image/jpeg');
    expect(normalizeStoredMediaType('IMAGE/PNG')).toBe('image/png');
    expect(normalizeStoredMediaType('application/pdf')).toBe('application/pdf');
  });

  it('collapses everything else to application/octet-stream', () => {
    expect(normalizeStoredMediaType('text/html')).toBe('application/octet-stream');
    expect(normalizeStoredMediaType('image/svg+xml')).toBe('application/octet-stream');
    expect(normalizeStoredMediaType('application/xhtml+xml')).toBe('application/octet-stream');
    expect(normalizeStoredMediaType(undefined)).toBe('application/octet-stream');
  });
});
