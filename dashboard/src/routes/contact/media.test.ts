import { describe, expect, it } from 'vitest';
import {
  isDeclarableMediaType,
  isInlineRenderable,
  mediaKindWord,
  messageMediaSrc,
  messageSid,
  toCommsMediaItem,
} from './media.js';

describe('messageSid', () => {
  it('extracts the provider sid after the # in tsMsgId', () => {
    expect(messageSid({ tsMsgId: '2026-06-17T23:44:54.876Z#MMfake11' })).toBe('MMfake11');
  });
  it('returns empty when there is no #', () => {
    expect(messageSid({ tsMsgId: 'sid-less' })).toBe('');
  });
});

describe('messageMediaSrc', () => {
  it('builds the authed same-origin media URL', () => {
    expect(messageMediaSrc('MM1', 2)).toBe('/api/messages/MM1/media/2');
  });
});

describe('toCommsMediaItem', () => {
  it('addresses the attachment exactly as a bubble would: sid:index key, authed src', () => {
    expect(
      toCommsMediaItem({
        providerSid: 'MMb',
        index: 0,
        contentType: 'application/pdf',
        at: '2026-06-17T11:00:00Z',
        conversationId: 'c1',
      }),
    ).toEqual({
      key: 'MMb:0',
      src: '/api/messages/MMb/media/0',
      contentType: 'application/pdf',
      at: '2026-06-17T11:00:00Z',
    });
  });
  it('URL-encodes an RFC-style email message id used as a provider sid', () => {
    expect(
      toCommsMediaItem({
        providerSid: '<in-doc@sender.example.com>',
        index: 1,
        contentType: 'application/pdf',
        at: '2026-06-17T11:00:00Z',
        conversationId: 'c1',
      }).src,
    ).toBe('/api/messages/%3Cin-doc%40sender.example.com%3E/media/1');
  });
});

describe('isInlineRenderable', () => {
  it('is true for exactly the four raster types the server renders inline', () => {
    for (const t of ['image/jpeg', 'image/png', 'image/gif', 'image/webp']) {
      expect(isInlineRenderable(t)).toBe(true);
    }
  });

  it('is FALSE for image types the browser cannot decode', () => {
    // The regression this whole helper exists to prevent: startsWith('image/')
    // renders a broken <img> for HEIC once the server stores it truthfully.
    expect(isInlineRenderable('image/heic')).toBe(false);
    expect(isInlineRenderable('image/tiff')).toBe(false);
  });

  it('is false for PDF, which is a file link here even though the server serves it inline', () => {
    expect(isInlineRenderable('application/pdf')).toBe(false);
  });

  it('matches on the essence so a parameterized type is not misread', () => {
    expect(isInlineRenderable('image/png; charset=x')).toBe(true);
  });
});

describe('mediaKindWord', () => {
  it('names the kind for declarable types', () => {
    expect(mediaKindWord('video/mp4')).toBe('Video');
    expect(mediaKindWord('audio/mpeg')).toBe('Audio');
    expect(mediaKindWord('image/heic')).toBe('Image');
    expect(mediaKindWord('text/vcard')).toBe('Contact card');
    expect(mediaKindWord('text/csv')).toBe('Document');
  });

  it('isDeclarableMediaType agrees with it - one map, two views', () => {
    expect(isDeclarableMediaType('video/mp4')).toBe(true);
    expect(isDeclarableMediaType('image/jpeg')).toBe(false);
    expect(isDeclarableMediaType('application/octet-stream')).toBe(false);
  });

  it('returns undefined for the opaque tier - there is no kind word for it', () => {
    // Labelling octet-stream "Document" would break the existing fallback
    // assertions and tell the operator something we do not know.
    expect(mediaKindWord('application/octet-stream')).toBeUndefined();
    expect(mediaKindWord('application/x-made-up')).toBeUndefined();
  });

  it('does NOT use a media-type prefix test', () => {
    // A prefix test collides on application/octet-stream against the OOXML
    // application/... types, and on text/vcard against text/plain.
    expect(mediaKindWord('application/octet-stream')).toBeUndefined();
    expect(
      mediaKindWord('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
    ).toBe('Document');
  });
});
