// M1.1 unit tests: repo pure logic — messages SK construction, the
// delivery-status machine's allowed transitions, preview truncation, and the
// breaker's minute bucketing. (Conditional-write/idempotency behavior against
// real DynamoDB lives in messaging.integration.test.ts.)
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import { minuteBucket, toPreview } from '../src/repos/conversationsRepo.js';
import { allowedPriorStatuses, buildTsMsgId, createMessagesRepo } from '../src/repos/messagesRepo.js';
import { createLogCapture } from './helpers/logCapture.js';

describe('messages SK construction (`<ISO ts>#<msgId>`)', () => {
  it('uses the PROVIDER timestamp + provider SID — deterministic across redeliveries', () => {
    const a = buildTsMsgId('2026-06-12T10:00:00.000Z', 'SM123');
    const b = buildTsMsgId('2026-06-12T10:00:00.000Z', 'SM123');
    expect(a).toBe('2026-06-12T10:00:00.000Z#SM123');
    expect(b).toBe(a); // same provider message -> same key, every delivery
  });

  it('sorts chronologically as a plain string (ISO 8601 prefix)', () => {
    const earlier = buildTsMsgId('2026-06-12T09:59:59.999Z', 'SM999');
    const later = buildTsMsgId('2026-06-12T10:00:00.000Z', 'SM000');
    expect(earlier < later).toBe(true);
  });
});

describe('delivery-status machine (queued → sent → delivered | undelivered | failed)', () => {
  it('moves forward only', () => {
    expect(allowedPriorStatuses('sent')).toEqual(['queued']);
    expect(allowedPriorStatuses('delivered')).toEqual(['queued', 'sent']);
    expect(allowedPriorStatuses('undelivered')).toEqual(['queued', 'sent']);
    expect(allowedPriorStatuses('failed')).toEqual(['queued', 'sent']);
  });

  it('nothing transitions INTO queued, and delivered can never be overwritten', () => {
    expect(allowedPriorStatuses('queued')).toEqual([]);
    for (const next of ['sent', 'delivered', 'undelivered', 'failed'] as const) {
      expect(allowedPriorStatuses(next)).not.toContain('delivered');
    }
  });
});

describe('conversation preview truncation', () => {
  it('passes short bodies through and leaves undefined alone', () => {
    expect(toPreview('hello')).toBe('hello');
    expect(toPreview(undefined)).toBeUndefined();
  });

  it('truncates long bodies to 120 chars with an ellipsis', () => {
    const preview = toPreview('x'.repeat(500))!;
    expect(preview).toHaveLength(120);
    expect(preview.endsWith('…')).toBe(true);
  });

  it('never splits a surrogate pair: an emoji at the truncation boundary survives or is dropped whole', () => {
    // 119 chars then an emoji (a surrogate PAIR) right on the cut boundary,
    // then more text — a UTF-16 slice would cut the pair in half.
    const preview = toPreview(`${'x'.repeat(119)}😀${'y'.repeat(50)}`)!;
    expect(Array.from(preview)).toHaveLength(120); // 119 x + ellipsis, by code points
    expect(preview.endsWith('…')).toBe(true);
    expect(preview).not.toMatch(/[\uD800-\uDBFF]…/); // no lone high surrogate before the ellipsis

    // All-emoji body: counted by code points, never bisected.
    const emojiPreview = toPreview('😀'.repeat(200))!;
    expect(Array.from(emojiPreview)).toHaveLength(120);
    expect(Array.from(emojiPreview).slice(0, 119).every((c) => c === '😀')).toBe(true);
    expect(emojiPreview.endsWith('…')).toBe(true);
  });
});

describe('messagesRepo.append dedupe (fake document client)', () => {
  it('returns the PERSISTED tsMsgId from the SID pointer, not the freshly computed one', async () => {
    // A redelivery computes a NEW first-seen providerTs (inbound webhooks
    // carry no provider timestamp) — the dedupe result must point at the
    // FIRST write's item, or callers would annotate/mirror a key that
    // doesn't exist.
    const persistedTsMsgId = '2026-06-12T10:00:00.000Z#SMdup1';
    const fakeDoc = {
      send: async (cmd: unknown) => {
        if (cmd instanceof TransactWriteCommand) {
          throw new TransactionCanceledException({
            $metadata: {},
            message: 'Transaction cancelled',
            CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
          });
        }
        if (cmd instanceof GetCommand && cmd.input.Key?.['conversationId'] === 'sid#SMdup1') {
          return {
            Item: {
              conversationId: 'sid#SMdup1',
              tsMsgId: 'ptr',
              ref_conversationId: 'conv-1',
              ref_tsMsgId: persistedTsMsgId,
            },
          };
        }
        throw new Error(`unexpected command: ${String(cmd)}`);
      },
    } as unknown as DynamoDBDocumentClient;

    const repo = createMessagesRepo({
      doc: fakeDoc,
      env: { TABLE_PREFIX: 'hc-fake-' } as NodeJS.ProcessEnv,
      logger: createLogger({ destination: createLogCapture().stream }),
    });

    const result = await repo.append({
      conversationId: 'conv-1',
      providerSid: 'SMdup1',
      providerTs: '2026-06-12T10:09:59.000Z', // a LATER first-seen ts on redelivery
      type: 'sms',
      direction: 'inbound',
      author: 'tenant',
      body: 'hello',
      deliveryStatus: 'delivered',
    });

    expect(result.deduped).toBe(true);
    expect(result.tsMsgId).toBe(persistedTsMsgId); // NOT 2026-06-12T10:09:59.000Z#SMdup1
  });
});

describe('breaker minute bucketing', () => {
  it('buckets to the UTC minute', () => {
    expect(minuteBucket(new Date('2026-06-12T15:04:59.999Z'))).toBe('2026-06-12T15:04');
    expect(minuteBucket(new Date('2026-06-12T15:05:00.000Z'))).toBe('2026-06-12T15:05');
  });
});
