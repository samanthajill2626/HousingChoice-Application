import { describe, expect, it } from 'vitest';
import { buildTimelineFallback } from './buildTimelineFallback.js';
import type { ConversationSummary, Message, TimelineMessage } from '../../api/index.js';

function convOf(
  partial: Partial<ConversationSummary> & Pick<ConversationSummary, 'conversationId'>,
): ConversationSummary {
  return {
    type: 'tenant_1to1',
    participant_phone: '+14040100007',
    participants: [],
    preview: null,
    last_activity_at: '2026-06-08T13:14:00Z',
    unread_count: 0,
    assignment: null,
    sms_opt_out: false,
    participant_display_name: null,
    ...partial,
  };
}

function msgOf(partial: Partial<Message> & Pick<Message, 'conversationId' | 'tsMsgId'>): Message {
  return {
    type: 'sms',
    direction: 'inbound',
    author: 'tenant',
    provider_sid: `SM-${partial.tsMsgId}`,
    provider_ts: '2026-06-08T13:14:00Z',
    delivery_status: 'delivered',
    created_at: '2026-06-08T13:14:00Z',
    ...partial,
  };
}

describe('buildTimelineFallback', () => {
  it('maps messages across conversations into TimelineMessage items, chronological', () => {
    const conversations = [convOf({ conversationId: 'c1' }), convOf({ conversationId: 'c2' })];
    const messagesByConvId = new Map<string, Message[]>([
      [
        'c1',
        [
          msgOf({ conversationId: 'c1', tsMsgId: 'b', provider_ts: '2026-06-08T10:00:00Z', body: 'second' }),
          msgOf({ conversationId: 'c1', tsMsgId: 'a', provider_ts: '2026-06-08T09:00:00Z', body: 'first' }),
        ],
      ],
      [
        'c2',
        [msgOf({ conversationId: 'c2', tsMsgId: 'c', provider_ts: '2026-06-08T11:00:00Z', body: 'third' })],
      ],
    ]);

    const items = buildTimelineFallback(conversations, messagesByConvId);

    expect(items.map((i) => (i as TimelineMessage).body)).toEqual(['first', 'second', 'third']);
    expect(items.every((i) => i.kind === 'message')).toBe(true);
    const first = items[0] as TimelineMessage;
    expect(first.id).toBe('a');
    expect(first.at).toBe('2026-06-08T09:00:00Z');
    expect(first.conversationId).toBe('c1');
  });

  it('derives fromPhone/toPhone from direction + participant phone', () => {
    const conversations = [convOf({ conversationId: 'c1', participant_phone: '+14705550148' })];
    const messagesByConvId = new Map<string, Message[]>([
      [
        'c1',
        [
          msgOf({ conversationId: 'c1', tsMsgId: 'in', direction: 'inbound' }),
          msgOf({ conversationId: 'c1', tsMsgId: 'out', direction: 'outbound', provider_ts: '2026-06-08T13:15:00Z' }),
        ],
      ],
    ]);

    const items = buildTimelineFallback(conversations, messagesByConvId) as TimelineMessage[];
    const inbound = items.find((i) => i.tsMsgId === 'in');
    const outbound = items.find((i) => i.tsMsgId === 'out');
    expect(inbound?.fromPhone).toBe('+14705550148');
    expect(inbound?.toPhone).toBeUndefined();
    expect(outbound?.toPhone).toBe('+14705550148');
    expect(outbound?.fromPhone).toBeUndefined();
  });

  it('carries body, type, author, delivery_status and media_attachments', () => {
    const conversations = [convOf({ conversationId: 'c1' })];
    const media = [{ s3Key: 'k', contentType: 'image/jpeg' }];
    const messagesByConvId = new Map<string, Message[]>([
      [
        'c1',
        [
          msgOf({
            conversationId: 'c1',
            tsMsgId: 'm',
            type: 'mms',
            author: 'teammate',
            delivery_status: 'sent',
            body: 'flyer',
            media_attachments: media,
          }),
        ],
      ],
    ]);

    const item = buildTimelineFallback(conversations, messagesByConvId)[0] as TimelineMessage;
    expect(item.type).toBe('mms');
    expect(item.author).toBe('teammate');
    expect(item.delivery_status).toBe('sent');
    expect(item.body).toBe('flyer');
    expect(item.media_attachments).toEqual(media);
  });

  it('excludes call-type messages (fallback is messages-only)', () => {
    const conversations = [convOf({ conversationId: 'c1' })];
    const messagesByConvId = new Map<string, Message[]>([
      [
        'c1',
        [
          msgOf({ conversationId: 'c1', tsMsgId: 'call', type: 'call' }),
          msgOf({ conversationId: 'c1', tsMsgId: 'sms', type: 'sms', body: 'hi' }),
        ],
      ],
    ]);

    const items = buildTimelineFallback(conversations, messagesByConvId);
    expect(items).toHaveLength(1);
    expect((items[0] as TimelineMessage).tsMsgId).toBe('sms');
  });

  it('carries delivery_recipients through (so a relay source message can show the opted-out note)', () => {
    const conversations = [convOf({ conversationId: 'c-relay', type: 'relay_group' })];
    const messagesByConvId = new Map<string, Message[]>([
      [
        'c-relay',
        [
          msgOf({
            conversationId: 'c-relay',
            tsMsgId: 'src',
            body: 'is the unit available?',
            delivery_recipients: {
              'c-bob': { status: 'failed', errorCode: 'contact_opted_out' },
              'c-carol': { status: 'delivered' },
            },
          }),
        ],
      ],
    ]);

    const item = buildTimelineFallback(conversations, messagesByConvId)[0] as TimelineMessage;
    expect(item.delivery_recipients?.['c-bob']).toEqual({
      status: 'failed',
      errorCode: 'contact_opted_out',
    });
  });

  it('tolerates a conversation with no messages in the map', () => {
    const conversations = [convOf({ conversationId: 'c1' }), convOf({ conversationId: 'c2' })];
    const messagesByConvId = new Map<string, Message[]>([
      ['c1', [msgOf({ conversationId: 'c1', tsMsgId: 'm', body: 'only' })]],
    ]);

    const items = buildTimelineFallback(conversations, messagesByConvId);
    expect(items).toHaveLength(1);
  });

  it('falls back to created_at when provider_ts is absent, and keeps a stable order', () => {
    const conversations = [convOf({ conversationId: 'c1' })];
    const messagesByConvId = new Map<string, Message[]>([
      [
        'c1',
        [
          msgOf({ conversationId: 'c1', tsMsgId: 'a', provider_ts: '', created_at: '2026-06-08T08:00:00Z', body: 'a' }),
          msgOf({ conversationId: 'c1', tsMsgId: 'b', provider_ts: '', created_at: '2026-06-08T09:00:00Z', body: 'b' }),
        ],
      ],
    ]);

    const items = buildTimelineFallback(conversations, messagesByConvId) as TimelineMessage[];
    expect(items.map((i) => i.body)).toEqual(['a', 'b']);
    expect(items[0]?.at).toBe('2026-06-08T08:00:00Z');
  });

  it('derives the instant from tsMsgId ("<ISO ts>#<id>") when provider_ts/created_at are absent', () => {
    const conversations = [convOf({ conversationId: 'c1' })];
    // The API returns messages NEWEST-FIRST; the seed shape carries only tsMsgId
    // (no provider_ts/created_at). Output must be chronological (oldest first).
    const messagesByConvId = new Map<string, Message[]>([
      [
        'c1',
        [
          msgOf({ conversationId: 'c1', tsMsgId: '2026-06-08T11:00:00Z#m3', provider_ts: '', created_at: '', body: 'third' }),
          msgOf({ conversationId: 'c1', tsMsgId: '2026-06-08T10:00:00Z#m2', provider_ts: '', created_at: '', body: 'second' }),
          msgOf({ conversationId: 'c1', tsMsgId: '2026-06-08T09:00:00Z#m1', provider_ts: '', created_at: '', body: 'first' }),
        ],
      ],
    ]);

    const items = buildTimelineFallback(conversations, messagesByConvId) as TimelineMessage[];
    expect(items.map((i) => i.body)).toEqual(['first', 'second', 'third']);
    expect(items[0]?.at).toBe('2026-06-08T09:00:00Z');
  });
});
