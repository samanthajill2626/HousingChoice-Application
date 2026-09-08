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
    // sent accepts queued_pending as a forward prior (T7: a held message's flush
    // path is queued_pending -> queued -> sent; listing it is forward-only-safe).
    expect(allowedPriorStatuses('sent')).toEqual(['queued', 'queued_pending']);
    expect(allowedPriorStatuses('delivered')).toEqual(['queued', 'sent']);
    expect(allowedPriorStatuses('undelivered')).toEqual(['queued', 'sent']);
    expect(allowedPriorStatuses('failed')).toEqual(['queued', 'sent']);
  });

  it('only the queued_pending flush transitions INTO queued, and delivered can never be overwritten', () => {
    // queued_pending -> queued is the T7 flush (a held message enters the send
    // path the instant its connecting group opens); nothing else precedes queued.
    expect(allowedPriorStatuses('queued')).toEqual(['queued_pending']);
    expect(allowedPriorStatuses('queued_pending')).toEqual([]);
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
            // FAITHFUL TO DYNAMODB: CancellationReasons is index-aligned with
            // TransactItems, and on a redelivery it is the SID POINTER (item 1)
            // whose condition fails - the message row's own key carries the NEW
            // first-seen providerTs, so item 0 would have succeeded.
            CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
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

  // A condition failure ANYWHERE ELSE in the transaction is NOT a dedupe: the
  // whole transaction rolled back, so there is no message row and no SID
  // pointer. Inferring "deduped" from the transaction as a whole reported a
  // send as persisted when nothing was written and handed the caller a tsMsgId
  // that addresses nothing - the group send would then drain, touch, emit SSE
  // and schedule a staleness watch for a message that does not exist.
  it('does NOT report a dedupe when the failing condition is not the SID pointer', async () => {
    const fakeDoc = {
      send: async (cmd: unknown) => {
        if (cmd instanceof TransactWriteCommand) {
          throw new TransactionCanceledException({
            $metadata: {},
            message: 'Transaction cancelled',
            // Item 3 is the group send's DUE ROW; the SID pointer succeeded.
            CancellationReasons: [
              { Code: 'None' },
              { Code: 'None' },
              { Code: 'ConditionalCheckFailed' },
            ],
          });
        }
        throw new Error(`unexpected command: ${String(cmd)}`);
      },
    } as unknown as DynamoDBDocumentClient;

    const repo = createMessagesRepo({
      doc: fakeDoc,
      env: { TABLE_PREFIX: 'hc-fake-' } as NodeJS.ProcessEnv,
      logger: createLogger({ destination: createLogCapture().stream }),
    });

    await expect(
      repo.append({
        conversationId: 'conv-1',
        providerSid: 'IMdue1',
        providerTs: '2026-06-12T10:09:59.000Z',
        type: 'sms',
        direction: 'outbound',
        author: 'teammate',
        body: 'hello',
        deliveryStatus: 'queued',
        dueRow: {
          partition: 'groupdue#send',
          sortKey: '2026-06-12T10:19:59.000Z#group_send_staleness#IMdue1',
          attributes: { due_kind: 'group_send_staleness' },
        },
      }),
    ).rejects.toBeInstanceOf(TransactionCanceledException);
  });
});

describe('messagesRepo.append relay external caller metadata', () => {
  function createAppendHarness() {
    const transactions: TransactWriteCommand[] = [];
    const fakeDoc = {
      send: async (cmd: unknown) => {
        if (cmd instanceof TransactWriteCommand) {
          transactions.push(cmd);
          return {};
        }
        throw new Error(`unexpected command: ${String(cmd)}`);
      },
    } as unknown as DynamoDBDocumentClient;

    return {
      repo: createMessagesRepo({
        doc: fakeDoc,
        env: { TABLE_PREFIX: 'hc-fake-' } as NodeJS.ProcessEnv,
        logger: createLogger({ destination: createLogCapture().stream }),
      }),
      transactions,
    };
  }

  const nonMemberCall = {
    conversationId: 'conv-relay',
    providerSid: 'CAexternal1',
    providerTs: '2026-08-28T16:21:16.000Z',
    type: 'call' as const,
    direction: 'inbound' as const,
    author: 'unknown' as const,
    deliveryStatus: 'delivered' as const,
    callStatus: 'no-answer' as const,
    callOutcome: 'missed' as const,
    masked: true,
    relayRefusalReason: 'non_member' as const,
    relayExternalCallerPhone: '+16175550198',
    relayExternalCallerContactId: 'contact-external',
  };

  function firstPersistedItem(transaction: TransactWriteCommand) {
    return transaction.input.TransactItems?.[0]?.Put?.Item;
  }

  it('persists all approved facts and permits a reason-only unknown caller', async () => {
    const { repo, transactions } = createAppendHarness();

    await repo.append(nonMemberCall);
    expect(firstPersistedItem(transactions[0]!)).toMatchObject({
      relay_refusal_reason: 'non_member',
      relay_external_caller_phone: '+16175550198',
      relay_external_caller_contact_id: 'contact-external',
    });

    await repo.append({
      ...nonMemberCall,
      providerSid: 'CAexternal2',
      relayExternalCallerPhone: undefined,
      relayExternalCallerContactId: undefined,
    });
    expect(firstPersistedItem(transactions[1]!)).toMatchObject({
      relay_refusal_reason: 'non_member',
    });
    expect(firstPersistedItem(transactions[1]!)).not.toHaveProperty('relay_external_caller_phone');
    expect(firstPersistedItem(transactions[1]!)).not.toHaveProperty('relay_external_caller_contact_id');
  });

  it.each([
    { ...nonMemberCall, type: 'sms' },
    { ...nonMemberCall, direction: 'outbound' },
    { ...nonMemberCall, masked: false },
    { ...nonMemberCall, relayRefusalReason: undefined },
    { ...nonMemberCall, relayExternalCallerPhone: '617-555-0198' },
    { ...nonMemberCall, relayExternalCallerPhone: undefined },
    { ...nonMemberCall, relaySenderKey: 'contact-member' },
    { ...nonMemberCall, author: 'tenant' },
  ])('rejects an invalid relay external caller storage shape before writing', async (message) => {
    const { repo, transactions } = createAppendHarness();

    await expect(repo.append(message as unknown as Parameters<typeof repo.append>[0])).rejects.toThrow(
      'invalid relay external caller metadata',
    );
    expect(transactions).toHaveLength(0);
  });

  it('leaves ordinary call and SMS storage unchanged', async () => {
    const { repo, transactions } = createAppendHarness();

    await repo.append({
      ...nonMemberCall,
      providerSid: 'CAnormal',
      author: 'tenant',
      relayRefusalReason: undefined,
      relayExternalCallerPhone: undefined,
      relayExternalCallerContactId: undefined,
    });
    await repo.append({
      conversationId: 'conv-sms',
      providerSid: 'SMnormal',
      providerTs: '2026-08-28T16:22:16.000Z',
      type: 'sms',
      direction: 'inbound',
      author: 'tenant',
      body: 'hello',
      deliveryStatus: 'delivered',
    });

    for (const transaction of transactions) {
      const item = firstPersistedItem(transaction);
      expect(item).not.toHaveProperty('relay_refusal_reason');
      expect(item).not.toHaveProperty('relay_external_caller_phone');
      expect(item).not.toHaveProperty('relay_external_caller_contact_id');
    }
  });
});

describe('messagesRepo point-get consistency (fake document client)', () => {
  function createGetHarness() {
    const gets: GetCommand[] = [];
    const fakeDoc = {
      send: async (cmd: unknown) => {
        if (cmd instanceof GetCommand) {
          gets.push(cmd);
          return {};
        }
        throw new Error(`unexpected command: ${String(cmd)}`);
      },
    } as unknown as DynamoDBDocumentClient;

    return {
      repo: createMessagesRepo({
        doc: fakeDoc,
        env: { TABLE_PREFIX: 'hc-fake-' } as NodeJS.ProcessEnv,
        logger: createLogger({ destination: createLogCapture().stream }),
      }),
      gets,
    };
  }

  // The relay 30003 claim path re-reads its source CONSISTENTLY (spec D7/D8):
  // a partition lag reporting a row absent turns a fail-closed fence into a
  // permanently lost retry, and a stale slot read drops the claim silently and
  // load-dependently. The FLAG is the whole contract, so the flag is what this
  // asserts - a round-trip against DynamoDB Local passes either way.
  it('sets ConsistentRead on the consistent read and not on the plain one', async () => {
    const { repo, gets } = createGetHarness();

    await repo.getByTsMsgIdConsistent('conv-1', '2026-09-02T10:00:00.000Z#SM1');
    expect(gets.at(-1)?.input).toMatchObject({
      Key: { conversationId: 'conv-1', tsMsgId: '2026-09-02T10:00:00.000Z#SM1' },
      ConsistentRead: true,
    });

    // D7 scopes the change deliberately: getByTsMsgId runs on EVERY relay
    // status callback and only needs requestedTransport, so making IT
    // consistent would double a hot-path read to fix a rare one.
    await repo.getByTsMsgId('conv-1', '2026-09-02T10:00:00.000Z#SM1');
    expect(gets.at(-1)?.input.ConsistentRead).toBeUndefined();
    expect(gets).toHaveLength(2);
  });
});

describe('breaker minute bucketing', () => {
  it('buckets to the UTC minute', () => {
    expect(minuteBucket(new Date('2026-06-12T15:04:59.999Z'))).toBe('2026-06-12T15:04');
    expect(minuteBucket(new Date('2026-06-12T15:05:00.000Z'))).toBe('2026-06-12T15:05');
  });
});
