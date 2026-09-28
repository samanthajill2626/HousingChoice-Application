// Relay 30003 retry lineage (spec D1, D2, D3, D11, D12, D13) against DynamoDB
// Local. A retry is a NEW source message row addressed to one member, carrying
// its own single-entry recipient map plus the six lineage values that let the
// dashboard join it back to the leg it is retrying.
//
// Its own throwaway table prefix, per worklist D7: a new integration file takes
// the per-file DynamoDB access key automatically and must NOT carry the shared
// lane marker.
import { randomUUID } from 'node:crypto';
import { GetCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { createLogger } from '../src/lib/logger.js';
import { relayRetryDigest, relayRetryProviderSid } from '../src/lib/relayRetryClaim.js';
import { RETRY_PROMISE_WITHDRAWN_AT } from '../src/lib/retrySendWindow.js';
import { getTableSpec } from '../src/lib/tables.js';
import {
  buildTsMsgId,
  createMessagesRepo,
  RETRY_CHILD_PARTITION_PREFIX,
  retryChildPk,
  type MessageItem,
  type NewMessage,
} from '../src/repos/messagesRepo.js';

const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';
async function endpointReachable(): Promise<boolean> {
  try {
    await fetch(endpoint, { signal: AbortSignal.timeout(1_500) });
    return true;
  } catch {
    return false;
  }
}
const reachable = await endpointReachable();

describe.skipIf(!reachable)('relay retry lineage against DynamoDB Local', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const table = tableName('messages', testEnv);
  const messages = createMessagesRepo({
    doc,
    env: testEnv,
    logger: createLogger({ level: 'silent' }),
  });
  const CONV = `conv-${randomUUID()}`;

  const ROOT = '2026-09-02T10:00:00.000Z#SMroot1';
  const MEMBER = 'contact-1';
  const DIGEST = relayRetryDigest(ROOT, '+15558675309');

  /** A rung-1 retry row of an OUTBOUND, LEGACY original - the plan's `base`. */
  function retryRow(overrides: Partial<NewMessage> & { providerSid: string }): NewMessage {
    return {
      conversationId: CONV,
      providerTs: '2026-09-02T10:01:00.000Z',
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      deliveryStatus: 'queued',
      body: 'the original text',
      relayRetryOf: ROOT,
      relayRetryMemberKey: MEMBER,
      relayRetryAttempt: 1,
      relayRetryDestDigest: DIGEST,
      relayRetryOriginDirection: 'outbound',
      relayRetryLegBody: 'Sam: the original text',
      deliveryRecipients: { [MEMBER]: { status: 'queued' } },
      ...overrides,
    };
  }

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('messages'), table);
  }, 120_000);
  afterAll(async () => {
    await deleteTableIfExists(client, table);
    doc.destroy();
    client.destroy();
  }, 120_000);

  it('round-trips the six lineage values', async () => {
    const res = await messages.append(
      retryRow({ providerSid: relayRetryProviderSid(DIGEST, 1) }),
    );
    const row = await messages.getByTsMsgId(CONV, res.tsMsgId);
    expect(row?.relay_retry_of).toBe(ROOT);
    expect(row?.relay_retry_member_key).toBe(MEMBER);
    expect(row?.relay_retry_attempt).toBe(1);
    expect(row?.relay_retry_dest_digest).toBe(DIGEST);
    expect(row?.relay_retry_origin_direction).toBe('outbound');
    // D12: the ROW keeps the raw body; the LEG copy is a separate field.
    expect(row?.body).toBe('the original text');
    expect(row?.relay_retry_leg_body).toBe('Sam: the original text');
  });

  // D3: the claim. A repeat of the SAME provider SID must DEDUPE, not throw -
  // `append` attributes a dedupe to the sid pointer at index 1 and rethrows
  // anything else (messagesRepo.ts:2304-2328, :2374-2388).
  it('reports a duplicate provider SID as deduped, pointing at the winner', async () => {
    const sid = relayRetryProviderSid(relayRetryDigest(ROOT, '+15558675399'), 1);
    const first = await messages.append(
      retryRow({ providerSid: sid, providerTs: '2026-09-02T10:02:00.000Z' }),
    );
    const second = await messages.append(
      retryRow({ providerSid: sid, providerTs: '2026-09-02T10:02:05.000Z' }),
    );
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.tsMsgId).toBe(first.tsMsgId);
  });

  // D13: the pointer index must not grow per attempt. The control append proves
  // the assertion can SEE pointers at all, so a green result is suppression and
  // not a broken read.
  it('writes no media-pointer rows for a retry row', async () => {
    const controlSid = 'MMcontrol1';
    await messages.append({
      conversationId: CONV,
      providerSid: controlSid,
      providerTs: '2026-09-02T10:03:00.000Z',
      type: 'mms',
      direction: 'outbound',
      author: 'teammate',
      deliveryStatus: 'queued',
      mediaAttachments: [{ s3Key: 'unit-media/control.jpg', contentType: 'image/jpeg' }],
    });

    const retrySid = relayRetryProviderSid(relayRetryDigest(ROOT, '+15558675310'), 1);
    const res = await messages.append(
      retryRow({
        providerSid: retrySid,
        providerTs: '2026-09-02T10:04:00.000Z',
        type: 'mms',
        mediaAttachments: [{ s3Key: 'unit-media/x.jpg', contentType: 'image/jpeg' }],
      }),
    );

    const pointers = await messages.listMediaPointers(CONV, { limit: 50 });
    expect(pointers.some((p) => p.providerSid === controlSid)).toBe(true);
    expect(pointers.some((p) => p.providerSid === retrySid)).toBe(false);

    // The durable s3Keys still ride the row so the retry can re-presign them.
    const row = await messages.getByTsMsgId(CONV, res.tsMsgId);
    expect(row?.media_attachments?.[0]?.s3Key).toBe('unit-media/x.jpg');
  });

  it('round-trips the attachments a retry row re-presigns from', async () => {
    const sid = relayRetryProviderSid(relayRetryDigest(ROOT, '+15558675311'), 2);
    const res = await messages.append(
      retryRow({
        providerSid: sid,
        providerTs: '2026-09-02T10:05:00.000Z',
        type: 'mms',
        relayRetryAttempt: 2,
        mediaAttachments: [
          { s3Key: 'unit-media/a.jpg', contentType: 'image/jpeg' },
          { s3Key: 'unit-media/b.pdf', contentType: 'application/pdf', filename: 'lease.pdf' },
        ],
      }),
    );
    const row = await messages.getByTsMsgId(CONV, res.tsMsgId);
    expect(row?.media_attachments?.map((a) => a.s3Key)).toEqual([
      'unit-media/a.jpg',
      'unit-media/b.pdf',
    ]);
    expect(row?.relay_retry_attempt).toBe(2);
  });

  // D2, VERSIONED original: slot seeded `planned` or the first send throws at
  // relayFanOut.ts:1418-1424.
  it('accepts a versioned retry row whose slot is seeded planned', async () => {
    await expect(
      messages.append(
        retryRow({
          providerSid: relayRetryProviderSid(relayRetryDigest(ROOT, '+15558675312'), 1),
          providerTs: '2026-09-02T10:06:00.000Z',
          transportSchemaVersion: 1,
          deliveryRecipients: {
            [MEMBER]: {
              status: 'queued',
              requestedTransport: 'sms',
              transportAggregationState: 'planned',
            },
          },
        }),
      ),
    ).resolves.toBeDefined();
  });

  // D2, INBOUND original: no MESSAGE-level requestedTransport
  // (messagesRepo.ts:913-915), but the SLOT may carry one (:922-937). The
  // distinction is easy to invert.
  it('accepts an inbound retry row whose slot carries a requested transport', async () => {
    await expect(
      messages.append(
        retryRow({
          providerSid: relayRetryProviderSid(relayRetryDigest(ROOT, '+15558675313'), 1),
          providerTs: '2026-09-02T10:07:00.000Z',
          direction: 'inbound',
          author: 'tenant',
          relayRetryOriginDirection: 'inbound',
          transportSchemaVersion: 1,
          deliveryRecipients: {
            [MEMBER]: {
              status: 'queued',
              requestedTransport: 'sms',
              transportAggregationState: 'planned',
            },
          },
        }),
      ),
    ).resolves.toBeDefined();
  });

  // D7: the claim path re-reads its source CONSISTENTLY. The repo's own
  // consistent point-get was a PRIVATE closure inside the factory, so the
  // webhook could not call it; this is that read on the interface.
  it('exposes a consistent read on the interface', async () => {
    const res = await messages.append(
      retryRow({
        providerSid: relayRetryProviderSid(relayRetryDigest(ROOT, '+15558675315'), 1),
        providerTs: '2026-09-02T10:09:00.000Z',
      }),
    );
    await expect(messages.getByTsMsgIdConsistent(CONV, res.tsMsgId)).resolves.toMatchObject({
      tsMsgId: res.tsMsgId,
      relay_retry_of: ROOT,
    });
    await expect(
      messages.getByTsMsgIdConsistent(CONV, '2026-09-02T10:09:00.000Z#SMabsent'),
    ).resolves.toBeUndefined();
  });

  // D2, LEGACY original: no transport fields anywhere. Every relay source
  // written before 2026-09-02 is legacy, so this is the ORDINARY case for an
  // old message.
  it('accepts a legacy retry row with no transport fields', async () => {
    const res = await messages.append(
      retryRow({
        providerSid: relayRetryProviderSid(relayRetryDigest(ROOT, '+15558675314'), 1),
        providerTs: '2026-09-02T10:08:00.000Z',
      }),
    );
    const row = await messages.getByTsMsgId(CONV, res.tsMsgId);
    expect(row?.transport_schema_version).toBeUndefined();
    expect(row?.delivery_recipients?.[MEMBER]?.transportAggregationState).toBeUndefined();
  });

  // retry-send-window D2/D5: the member's ORIGINAL leg send time rides every
  // rung as relay_retry_window_start. It is OPTIONAL: a rung claimed before the
  // field existed has none and must still append (the job then skips the
  // window check, with a WARN).
  it('round-trips the carried window origin, and appends a row without it', async () => {
    const withOrigin = await messages.append(
      retryRow({
        providerSid: relayRetryProviderSid(relayRetryDigest(ROOT, '+15558675316'), 2),
        providerTs: '2026-09-02T10:10:00.000Z',
        relayRetryAttempt: 2,
        relayRetryWindowStart: '2026-09-02T10:00:04.000Z',
      }),
    );
    expect((await messages.getByTsMsgId(CONV, withOrigin.tsMsgId))?.relay_retry_window_start).toBe(
      '2026-09-02T10:00:04.000Z',
    );

    const without = await messages.append(
      retryRow({
        providerSid: relayRetryProviderSid(relayRetryDigest(ROOT, '+15558675317'), 1),
        providerTs: '2026-09-02T10:11:00.000Z',
      }),
    );
    expect(await messages.getByTsMsgId(CONV, without.tsMsgId)).not.toHaveProperty(
      'relay_retry_window_start',
    );
  });

  // ---------------------------------------------------------------------------
  // retry-send-adoption (R3, R5, R7): the ONE-TO-ONE 30003 retry lineage. A
  // one-to-one retry row carries retry_of (plus retry_attempt when automatic)
  // and, since this branch, retry_root; every append of a row with retryOf
  // also puts a retrychild# pointer in the SAME transaction, so "does this row
  // have a child?" is one consistent Query. The relay builder above stamps
  // relay fields and is not reused.
  // ---------------------------------------------------------------------------
  describe('one-to-one retry lineage (retry-send-adoption)', () => {
    const ONE_CONV = `conv-1to1-${randomUUID().slice(0, 8)}`;
    const T0 = '2026-09-27T12:00:00.000Z';
    const T1 = '2026-09-27T12:01:00.000Z';
    const T2 = '2026-09-27T12:02:30.000Z';
    const DUE_1 = '2026-09-27T12:02:00.000Z';
    const DUE_2 = '2026-09-27T12:03:00.000Z';

    /** One outbound one-to-one row in ONE_CONV; returns the stored row (consistent read). */
    async function appendOutbound(
      fields: { providerSid: string; providerTs: string } & Partial<NewMessage>,
    ): Promise<MessageItem> {
      const res = await messages.append({
        conversationId: ONE_CONV,
        type: 'sms',
        direction: 'outbound',
        author: 'teammate',
        body: 'hello',
        deliveryStatus: 'undelivered',
        errorCode: '30003',
        ...fields,
      });
      return (await messages.getByTsMsgIdConsistent(ONE_CONV, res.tsMsgId))!;
    }

    /** Every retrychild# item in the table whose sort key is `childTsMsgId`, under ANY parent. */
    async function pointersNaming(childTsMsgId: string): Promise<Record<string, unknown>[]> {
      const found: Record<string, unknown>[] = [];
      let startKey: Record<string, unknown> | undefined;
      do {
        const page = await doc.send(
          new ScanCommand({
            TableName: table,
            FilterExpression: 'tsMsgId = :t AND begins_with(conversationId, :p)',
            ExpressionAttributeValues: { ':t': childTsMsgId, ':p': RETRY_CHILD_PARTITION_PREFIX },
            ConsistentRead: true,
            ...(startKey !== undefined && { ExclusiveStartKey: startKey }),
          }),
        );
        found.push(...((page.Items ?? []) as Record<string, unknown>[]));
        startKey = page.LastEvaluatedKey;
      } while (startKey !== undefined);
      return found;
    }

    it('append persists retry_root beside retry_of and writes the retrychild# pointer in the same transaction', async () => {
      const parent = await appendOutbound({ providerSid: 'SMroot1', providerTs: T0 });
      const child = await appendOutbound({
        providerSid: 'SMretry1',
        providerTs: T1,
        retryOf: parent.tsMsgId,
        retryAttempt: 1,
        retryRoot: parent.tsMsgId,
      });
      expect(await messages.getByTsMsgIdConsistent(ONE_CONV, child.tsMsgId)).toMatchObject({
        retry_of: parent.tsMsgId,
        retry_attempt: 1,
        retry_root: parent.tsMsgId,
      });
      expect(await messages.listRetryChildrenConsistent(ONE_CONV, parent.tsMsgId)).toStrictEqual([
        { tsMsgId: child.tsMsgId, providerSid: 'SMretry1', retryAttempt: 1 },
      ]);
      // A pointer, never state: the item is the child's ids and attempt, nothing else.
      const { Item } = await doc.send(
        new GetCommand({
          TableName: table,
          Key: { conversationId: retryChildPk(ONE_CONV, parent.tsMsgId), tsMsgId: child.tsMsgId },
          ConsistentRead: true,
        }),
      );
      expect(Item).toStrictEqual({
        conversationId: `retrychild#${ONE_CONV}#${parent.tsMsgId}`,
        tsMsgId: child.tsMsgId,
        provider_sid: 'SMretry1',
        retry_attempt: 1,
      });
      // retry_root is only ever what the caller passed; retry_outcome is never an append field.
      expect(parent).not.toHaveProperty('retry_root');
      expect(child).not.toHaveProperty('retry_outcome');
    });

    it('the pointer rides the append transaction: an append another item cancels writes neither the row nor the pointer', async () => {
      const parent = await appendOutbound({ providerSid: 'SMroot5', providerTs: T0 });
      const dueRow = { partition: `due-probe#${randomUUID()}`, sortKey: `${T2}#probe#1`, attributes: { kind: 'probe' } };
      // A first append takes the due row's key, so a retry row carrying the SAME
      // due row is cancelled by that row's condition - not by its own sid#.
      await appendOutbound({ providerSid: 'SMholder5', providerTs: T0, dueRow });
      await expect(
        messages.append({
          conversationId: ONE_CONV,
          type: 'sms',
          direction: 'outbound',
          author: 'teammate',
          body: 'hello',
          deliveryStatus: 'queued',
          providerSid: 'SMretry5',
          providerTs: T1,
          retryOf: parent.tsMsgId,
          retryAttempt: 1,
          retryRoot: parent.tsMsgId,
          dueRow,
        }),
      ).rejects.toThrow();
      expect(await messages.getByProviderSidConsistent('SMretry5')).toBeUndefined();
      expect(await messages.listRetryChildrenConsistent(ONE_CONV, parent.tsMsgId)).toStrictEqual([]);
      expect(await pointersNaming(buildTsMsgId(T1, 'SMretry5'))).toStrictEqual([]);
    });

    it('a manual retry row (retryOf, no retryAttempt) writes a pointer with no retryAttempt; a row with no retryOf writes none', async () => {
      const parent = await appendOutbound({ providerSid: 'SMroot2', providerTs: T0 });
      const manual = await appendOutbound({
        providerSid: 'SMmanual2',
        providerTs: T1,
        retryOf: parent.tsMsgId,
        retryRoot: parent.tsMsgId,
      });
      expect(await messages.listRetryChildrenConsistent(ONE_CONV, parent.tsMsgId)).toStrictEqual([
        { tsMsgId: manual.tsMsgId, providerSid: 'SMmanual2' },
      ]);
      expect(await messages.listRetryChildrenConsistent(ONE_CONV, manual.tsMsgId)).toStrictEqual([]);
      // The root has no parent, so no pointer anywhere in the table names it.
      expect(await pointersNaming(parent.tsMsgId)).toStrictEqual([]);
      expect(await pointersNaming(manual.tsMsgId)).toHaveLength(1);
    });

    it("lists a parent's children in sort-key (tsMsgId) order, whatever the append order", async () => {
      const parent = await appendOutbound({ providerSid: 'SMroot6', providerTs: T0 });
      const later = await appendOutbound({
        providerSid: 'SMauto6',
        providerTs: T2,
        retryOf: parent.tsMsgId,
        retryAttempt: 1,
        retryRoot: parent.tsMsgId,
      });
      const earlier = await appendOutbound({
        providerSid: 'SMmanual6',
        providerTs: T1,
        retryOf: parent.tsMsgId,
        retryRoot: parent.tsMsgId,
      });
      expect(await messages.listRetryChildrenConsistent(ONE_CONV, parent.tsMsgId)).toStrictEqual([
        { tsMsgId: earlier.tsMsgId, providerSid: 'SMmanual6' },
        { tsMsgId: later.tsMsgId, providerSid: 'SMauto6', retryAttempt: 1 },
      ]);
    });

    it('a deduped append (same providerSid) writes no second pointer', async () => {
      const parent = await appendOutbound({ providerSid: 'SMroot3', providerTs: T0 });
      const lineage = { retryOf: parent.tsMsgId, retryAttempt: 1, retryRoot: parent.tsMsgId };
      const first = await appendOutbound({ providerSid: 'SMretry3', providerTs: T1, ...lineage });
      // The redelivery computes ANOTHER key (another providerTs), so a pointer
      // written outside the cancelled transaction would land a second item.
      const again = await messages.append({
        conversationId: ONE_CONV,
        type: 'sms',
        direction: 'outbound',
        author: 'teammate',
        body: 'hello',
        deliveryStatus: 'queued',
        providerSid: 'SMretry3',
        providerTs: T2,
        ...lineage,
      });
      expect(again).toStrictEqual({ deduped: true, tsMsgId: first.tsMsgId, conversationId: ONE_CONV });
      expect(await messages.listRetryChildrenConsistent(ONE_CONV, parent.tsMsgId)).toStrictEqual([
        { tsMsgId: first.tsMsgId, providerSid: 'SMretry3', retryAttempt: 1 },
      ]);
      expect(await pointersNaming(buildTsMsgId(T2, 'SMretry3'))).toStrictEqual([]);
    });

    it('the pointer read is a single consistent Query on the retrychild# partition', async () => {
      const parent = await appendOutbound({ providerSid: 'SMroot4', providerTs: T0 });
      await appendOutbound({
        providerSid: 'SMretry4',
        providerTs: T1,
        retryOf: parent.tsMsgId,
        retryAttempt: 1,
        retryRoot: parent.tsMsgId,
      });
      const send = vi.spyOn(doc, 'send');
      try {
        expect(await messages.listRetryChildrenConsistent(ONE_CONV, parent.tsMsgId)).toHaveLength(1);
        expect(send).toHaveBeenCalledTimes(1);
        const command: unknown = send.mock.calls[0]?.[0];
        expect(command).toBeInstanceOf(QueryCommand);
        const input = (command as QueryCommand).input;
        expect(input).toMatchObject({
          TableName: table,
          ConsistentRead: true,
          KeyConditionExpression: 'conversationId = :p',
          ExpressionAttributeValues: { ':p': retryChildPk(ONE_CONV, parent.tsMsgId) },
        });
        expect(input.FilterExpression).toBeUndefined();
      } finally {
        send.mockRestore();
      }
    });

    it('annotateRetryPromise writes only when retry_due_at still holds the expected value, and returns false otherwise', async () => {
      const row = await appendOutbound({ providerSid: 'SMdue1', providerTs: T0 });
      // absent -> absent expected: written
      expect(
        await messages.annotateRetryPromise(ONE_CONV, row.tsMsgId, { retryDueAt: DUE_1 }, { retryDueAt: undefined }),
      ).toBe(true);
      // a stale expectation loses, and writes nothing
      expect(
        await messages.annotateRetryPromise(ONE_CONV, row.tsMsgId, { retryDueAt: DUE_2 }, { retryDueAt: undefined }),
      ).toBe(false);
      expect(
        await messages.annotateRetryPromise(ONE_CONV, row.tsMsgId, { retryDueAt: DUE_2 }, { retryDueAt: 'wrong' }),
      ).toBe(false);
      expect((await messages.getByTsMsgIdConsistent(ONE_CONV, row.tsMsgId))?.retry_due_at).toBe(DUE_1);
      // the current value wins
      expect(
        await messages.annotateRetryPromise(ONE_CONV, row.tsMsgId, { retryDueAt: DUE_2 }, { retryDueAt: DUE_1 }),
      ).toBe(true);
      // WITHDRAW writes both fields in one write
      expect(
        await messages.annotateRetryPromise(
          ONE_CONV,
          row.tsMsgId,
          { retryDueAt: RETRY_PROMISE_WITHDRAWN_AT, retryOutcome: 'unconfirmed' },
          { retryDueAt: DUE_2 },
        ),
      ).toBe(true);
      expect(await messages.getByTsMsgIdConsistent(ONE_CONV, row.tsMsgId)).toMatchObject({
        retry_due_at: RETRY_PROMISE_WITHDRAWN_AT,
        retry_outcome: 'unconfirmed',
      });
      // a missing row is false, not a throw
      expect(
        await messages.annotateRetryPromise(ONE_CONV, 'nope#SMnope', { retryDueAt: DUE_1 }, { retryDueAt: undefined }),
      ).toBe(false);
    });

    it('annotateRetryPromise withdraws a row that never held a promise (the fourth expression shape); a stale withdraw writes neither field', async () => {
      const row = await appendOutbound({ providerSid: 'SMdue2', providerTs: T0 });
      const withdraw = { retryDueAt: RETRY_PROMISE_WITHDRAWN_AT, retryOutcome: 'unconfirmed' as const };
      expect(await messages.annotateRetryPromise(ONE_CONV, row.tsMsgId, withdraw, { retryDueAt: DUE_1 })).toBe(false);
      const untouched = await messages.getByTsMsgIdConsistent(ONE_CONV, row.tsMsgId);
      expect(untouched).not.toHaveProperty('retry_due_at');
      expect(untouched).not.toHaveProperty('retry_outcome');
      expect(await messages.annotateRetryPromise(ONE_CONV, row.tsMsgId, withdraw, { retryDueAt: undefined })).toBe(true);
      expect(await messages.getByTsMsgIdConsistent(ONE_CONV, row.tsMsgId)).toMatchObject({
        retry_due_at: RETRY_PROMISE_WITHDRAWN_AT,
        retry_outcome: 'unconfirmed',
      });
    });

    it('stampRetryAttribution (share-sent-outcome D8, the repair only) SETs broadcast_id and retry_root on an EXISTING row in ONE conditional write naming exactly its aliases, corrects a wrong root in place, and answers false for a missing row without creating it', async () => {
      const parent = await appendOutbound({ providerSid: 'SMstamp0', providerTs: T0 });
      const child = await appendOutbound({ providerSid: 'SMstamp1', providerTs: T1, retryOf: parent.tsMsgId, retryAttempt: 1 });
      expect(child).not.toHaveProperty('broadcast_id');
      expect(child).not.toHaveProperty('retry_root');
      const send = vi.spyOn(doc, 'send');
      try {
        expect(await messages.stampRetryAttribution(ONE_CONV, child.tsMsgId, { broadcastId: 'b-stamp', retryRoot: 'a-wrong-root' })).toBe(true);
        expect(send).toHaveBeenCalledTimes(1);
        const command: unknown = send.mock.calls[0]?.[0];
        expect(command).toBeInstanceOf(UpdateCommand);
        expect((command as UpdateCommand).input).toMatchObject({
          TableName: table,
          Key: { conversationId: ONE_CONV, tsMsgId: child.tsMsgId },
          UpdateExpression: 'SET #b = :b, #r = :r',
          ConditionExpression: 'attribute_exists(tsMsgId)',
          ExpressionAttributeNames: { '#b': 'broadcast_id', '#r': 'retry_root' },
          ExpressionAttributeValues: { ':b': 'b-stamp', ':r': 'a-wrong-root' },
        });
      } finally {
        send.mockRestore();
      }
      expect(await messages.stampRetryAttribution(ONE_CONV, child.tsMsgId, { broadcastId: 'b-stamp', retryRoot: parent.tsMsgId })).toBe(true);
      // The two fields, and nothing else of the row's lineage moved.
      expect(await messages.getByTsMsgIdConsistent(ONE_CONV, child.tsMsgId)).toMatchObject({
        broadcast_id: 'b-stamp',
        retry_root: parent.tsMsgId,
        retry_of: parent.tsMsgId,
        retry_attempt: 1,
        delivery_status: 'undelivered',
      });
      const missing = buildTsMsgId(T2, 'SMstamp-missing');
      expect(await messages.stampRetryAttribution(ONE_CONV, missing, { broadcastId: 'b-stamp', retryRoot: parent.tsMsgId })).toBe(false);
      expect(await messages.getByTsMsgIdConsistent(ONE_CONV, missing)).toBeUndefined();
    });
  });
});
