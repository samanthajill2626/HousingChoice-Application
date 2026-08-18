import { describe, expect, it } from 'vitest';
import { messageMediaSrc, messageSid, toCommsMediaItem } from './media.js';

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
