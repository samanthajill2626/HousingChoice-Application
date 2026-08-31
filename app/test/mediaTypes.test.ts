// Unit tests for the shared MMS media-type allowlist (the stored-XSS guard used
// by BOTH the mirror write path and the media-serve read path).
import { describe, expect, it } from 'vitest';
import {
  DECLARABLE_MEDIA_TYPES,
  INLINE_MEDIA_TYPES,
  isAcceptedExtension,
  isHandoffMediaType,
  mediaCspFor,
  isInlineMediaType,
  normalizeStoredMediaType,
  resolveMediaTier,
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

describe('resolveMediaTier', () => {
  it('classifies the inline allowlist and returns the canonical type + extension', () => {
    expect(resolveMediaTier('image/png')).toEqual({
      tier: 'inline',
      canonical: 'image/png',
      ext: '.png',
    });
    expect(resolveMediaTier('application/pdf').tier).toBe('inline');
  });

  it('classifies the declarable allowlist', () => {
    expect(resolveMediaTier('video/mp4')).toEqual({
      tier: 'declarable',
      canonical: 'video/mp4',
      ext: '.mp4',
    });
    expect(resolveMediaTier('image/heic').tier).toBe('declarable');
    expect(resolveMediaTier('text/vcard').tier).toBe('declarable');
  });

  it('matches on the media-type ESSENCE, so parameterized wire forms are not lost', () => {
    // The whole feature is defeated for text/plain and video/3gpp without this.
    expect(resolveMediaTier('text/plain; charset=utf-8')).toEqual({
      tier: 'declarable',
      canonical: 'text/plain',
      ext: '.txt',
    });
    expect(resolveMediaTier('IMAGE/PNG ; charset=x').canonical).toBe('image/png');
  });

  it('refuses every script-capable type regardless of parameters', () => {
    for (const raw of [
      'text/html',
      'text/html; charset=utf-8',
      'image/svg+xml',
      'application/xhtml+xml',
      'text/xml',
      'application/xml',
      'application/javascript',
    ]) {
      expect(resolveMediaTier(raw)).toEqual({
        tier: 'opaque',
        canonical: 'application/octet-stream',
        ext: '.bin',
      });
    }
  });

  it('treats unknown and absent as opaque', () => {
    expect(resolveMediaTier('application/x-made-up').tier).toBe('opaque');
    expect(resolveMediaTier(undefined).tier).toBe('opaque');
    expect(resolveMediaTier('').tier).toBe('opaque');
  });
});

describe('the emission map covers every allowlisted type', () => {
  it('never falls through to .bin for a type we claim to serve truthfully', () => {
    // GUARDRAIL: resolveMediaTier ends in `?? '.bin'`, so a type added to
    // either allowlist without an extension would be served truthfully AND
    // named .bin - silently, and only noticed by an operator.
    for (const type of [...INLINE_MEDIA_TYPES, ...DECLARABLE_MEDIA_TYPES]) {
      expect(resolveMediaTier(type).ext).not.toBe('.bin');
    }
  });

  it('emits only extensions the accepted set also recognises', () => {
    for (const type of [...INLINE_MEDIA_TYPES, ...DECLARABLE_MEDIA_TYPES]) {
      expect(isAcceptedExtension(resolveMediaTier(type).ext)).toBe(true);
    }
  });
});

describe('isAcceptedExtension', () => {
  it('accepts spelling variants the emission map does not emit', () => {
    // REGRESSION GUARD: deriving this set from the emission map's values
    // rejects .jpeg and turns photo.jpeg into photo.bin - the exact outcome
    // the opaque-tier extension rule exists to prevent.
    expect(isAcceptedExtension('.jpg')).toBe(true);
    expect(isAcceptedExtension('.jpeg')).toBe(true);
    expect(isAcceptedExtension('.tif')).toBe(true);
    expect(isAcceptedExtension('.3gp')).toBe(true);
    expect(isAcceptedExtension('.vcf')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isAcceptedExtension('.XLSX')).toBe(true);
  });

  it('never accepts an executable or script extension', () => {
    for (const ext of ['.exe', '.js', '.html', '.htm', '.svg', '.bat', '.sh', '.ps1']) {
      expect(isAcceptedExtension(ext)).toBe(false);
    }
  });
});

describe('normalizeStoredMediaType (widened)', () => {
  it('keeps declarable types now, not just inline ones', () => {
    expect(normalizeStoredMediaType('video/mp4')).toBe('video/mp4');
    expect(normalizeStoredMediaType('image/heic')).toBe('image/heic');
  });

  it('still collapses script-capable and unknown types', () => {
    expect(normalizeStoredMediaType('text/html')).toBe('application/octet-stream');
    expect(normalizeStoredMediaType('image/svg+xml')).toBe('application/octet-stream');
    expect(normalizeStoredMediaType(undefined)).toBe('application/octet-stream');
  });

  it('returns the canonical member for a parameterized type', () => {
    expect(normalizeStoredMediaType('text/csv; charset=utf-8')).toBe('text/csv');
  });
});

describe('isHandoffMediaType', () => {
  it('hands off every video and audio type', () => {
    for (const t of ['video/mp4', 'video/quicktime', 'video/webm', 'audio/mpeg', 'audio/wav']) {
      expect(isHandoffMediaType(resolveMediaTier(t))).toBe(true);
    }
  });

  it('hands off the whole inline tier, which already behaved this way', () => {
    for (const t of ['image/png', 'image/jpeg', 'application/pdf']) {
      expect(isHandoffMediaType(resolveMediaTier(t))).toBe(true);
    }
  });

  it('does NOT hand off declarable types a browser cannot usefully open', () => {
    // HEIC/TIFF are declarable BECAUSE the browser cannot decode them; a
    // vCard or spreadsheet is more useful saved than rendered.
    for (const t of [
      'image/heic',
      'image/tiff',
      'text/vcard',
      'text/csv',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ]) {
      expect(isHandoffMediaType(resolveMediaTier(t))).toBe(false);
    }
  });

  it('NEVER hands off an opaque or script-capable type', () => {
    for (const t of ['text/html', 'image/svg+xml', 'application/x-made-up', undefined]) {
      expect(isHandoffMediaType(resolveMediaTier(t))).toBe(false);
    }
  });

  it('matches on the ESSENCE, like every other decision here', () => {
    expect(isHandoffMediaType(resolveMediaTier('video/mp4; codecs=avc1'))).toBe(true);
  });
});

describe('mediaCspFor', () => {
  it('lets video and audio load their own bytes, and drops sandbox for the player', () => {
    // Both proven necessary by a real browser, not reasoned about: media-src
    // falls back to default-src 'none' and blocks the video; and sandbox
    // without allow-scripts blocks the built-in player UI. They are coupled -
    // sandbox makes the origin OPAQUE, in which 'self' matches nothing.
    for (const t of ['video/mp4', 'audio/mpeg']) {
      expect(mediaCspFor(resolveMediaTier(t))).toBe("default-src 'none'; media-src 'self'");
    }
  });

  it('KEEPS the strict policy for images and PDF, which already work under it', () => {
    for (const t of ['image/png', 'image/jpeg', 'application/pdf']) {
      expect(mediaCspFor(resolveMediaTier(t))).toBe("default-src 'none'; sandbox");
    }
  });

  it('KEEPS the strict policy for every non-playable declarable type', () => {
    for (const t of ['image/heic', 'text/vcard', 'text/csv']) {
      expect(mediaCspFor(resolveMediaTier(t))).toBe("default-src 'none'; sandbox");
    }
  });

  it('KEEPS the strict policy for opaque and script-capable types', () => {
    for (const t of ['text/html', 'image/svg+xml', 'application/x-made-up', undefined]) {
      expect(mediaCspFor(resolveMediaTier(t))).toBe("default-src 'none'; sandbox");
    }
  });

  it('never omits default-src none, whatever the type', () => {
    for (const t of ['video/mp4', 'image/png', 'text/html', 'image/heic', undefined]) {
      expect(mediaCspFor(resolveMediaTier(t))).toContain("default-src 'none'");
    }
  });
});

describe('isInlineMediaType is NOT widened (outbound upload gate)', () => {
  it('still refuses declarable types', () => {
    // routes/mmsMedia.ts:78 gates staff uploads on this. Widening it would
    // silently let video and documents through to Twilio, which cannot carry
    // them (error 12300).
    expect(isInlineMediaType('video/mp4')).toBe(false);
    expect(isInlineMediaType('text/vcard')).toBe(false);
  });

  it('keeps its exact-match semantics', () => {
    expect(isInlineMediaType('image/png; charset=x')).toBe(false);
  });
});
