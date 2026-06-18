import { describe, expect, it } from 'vitest';
import type { TimelineItem } from '../../api/index.js';
import { commsMedia, messageMediaSrc, messageSid } from './media.js';

function msg(over: Partial<TimelineItem> & { id: string; at: string }): TimelineItem {
  return {
    kind: 'message',
    conversationId: 'c1',
    tsMsgId: `${over.at}#MM${over.id}`,
    direction: 'inbound',
    author: 'tenant',
    type: 'mms',
    delivery_status: 'delivered',
    ...over,
  } as TimelineItem;
}

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

describe('commsMedia', () => {
  it('flattens attachments newest-first; skips non-messages, empties, and sid-less rows', () => {
    const items: TimelineItem[] = [
      msg({
        id: 'a',
        at: '2026-06-17T10:00:00Z',
        media_attachments: [
          { s3Key: 'k0', contentType: 'image/png' },
          { s3Key: 'k1', contentType: 'image/jpeg' },
        ],
      }),
      msg({
        id: 'b',
        at: '2026-06-17T11:00:00Z', // newer
        media_attachments: [{ s3Key: 'k2', contentType: 'application/pdf' }],
      }),
      msg({ id: 'c', at: '2026-06-17T12:00:00Z' }), // no attachments → skipped
      // attachment but tsMsgId has no '#' → no servable sid → skipped
      {
        ...msg({ id: 'd', at: '2026-06-17T13:00:00Z', media_attachments: [{ s3Key: 'k', contentType: 'image/png' }] }),
        tsMsgId: 'no-hash',
      } as TimelineItem,
      { kind: 'call', id: 'call1', at: '2026-06-17T14:00:00Z', call_outcome: 'answered' } as TimelineItem,
    ];

    const media = commsMedia(items);

    // Newest message first; multiple attachments keep their order within a message.
    expect(media.map((m) => m.key)).toEqual(['MMb:0', 'MMa:0', 'MMa:1']);
    expect(media[0]).toMatchObject({
      key: 'MMb:0',
      src: '/api/messages/MMb/media/0',
      contentType: 'application/pdf',
    });
    expect(media[1]?.src).toBe('/api/messages/MMa/media/0');
  });

  it('returns an empty list when there is no media', () => {
    expect(commsMedia([])).toEqual([]);
  });
});
