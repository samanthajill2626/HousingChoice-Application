// MEDIA POINTERS (2026-08-18) - the "Media from comms" gallery's own index,
// against DynamoDB Local. The gallery used to be assembled by reading messages
// (a 200-row scan per thread, and the live gallery from the loaded timeline
// page), so an attachment older than that was not in the gallery at all. Every
// attachment is now ALSO indexed at write time in `media#<conversationId>`,
// and the gallery pages that partition newest-first with no cap.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { createLogger } from '../src/lib/logger.js';
import { getTableSpec } from '../src/lib/tables.js';
import {
  buildTsMsgId,
  createMessagesRepo,
  mediaPointerSk,
  splitTsMsgId,
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

describe('splitTsMsgId', () => {
  it('splits at the FIRST # - the ISO timestamp never carries one, the SID may', () => {
    expect(splitTsMsgId('2026-08-18T00:00:00.000Z#MM1')).toEqual({ providerTs: '2026-08-18T00:00:00.000Z', providerSid: 'MM1' });
    expect(splitTsMsgId('2026-08-18T00:00:00.000Z#a#b')).toEqual({ providerTs: '2026-08-18T00:00:00.000Z', providerSid: 'a#b' });
  });
  it('the pointer sort key orders by message SK then zero-padded position', () => {
    const k = (i: number) => mediaPointerSk('2026-08-18T00:00:00.000Z#MM1', i);
    expect(k(9) < k(10)).toBe(true);
  });
});

describe.skipIf(!reachable)('media pointers against DynamoDB Local', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const table = tableName('messages', testEnv);
  const messages = createMessagesRepo({ doc, env: testEnv, logger: createLogger({ level: 'silent' }) });
  const CONV = `conv-${randomUUID()}`;

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('messages'), table);
  }, 120_000);
  afterAll(async () => {
    await deleteTableIfExists(client, table);
    doc.destroy();
    client.destroy();
  }, 120_000);

  it('an OUTBOUND MMS append writes its pointers in the same transaction; a redelivery adds none', async () => {
    const first = await messages.append({
      conversationId: CONV,
      type: 'mms',
      direction: 'outbound',
      author: 'teammate',
      providerSid: 'MMout1',
      providerTs: '2026-08-18T10:00:00.000Z',
      deliveryStatus: 'sent',
      mediaAttachments: [
        { s3Key: 'media/out/1/a', contentType: 'image/jpeg' },
        { s3Key: 'media/out/1/b', contentType: 'application/pdf', filename: 'lease.pdf' },
      ],
    });
    expect(first.deduped).toBe(false);
    const again = await messages.append({
      conversationId: CONV,
      type: 'mms',
      direction: 'outbound',
      author: 'teammate',
      providerSid: 'MMout1',
      providerTs: '2026-08-18T10:00:00.500Z', // a redelivery with a later ts
      deliveryStatus: 'sent',
      mediaAttachments: [{ s3Key: 'media/out/1/a', contentType: 'image/jpeg' }],
    });
    expect(again.deduped).toBe(true);

    const pointers = await messages.listMediaPointers(CONV, { limit: 10 });
    expect(pointers.map((p) => [p.providerSid, p.index, p.s3Key, p.contentType])).toEqual([
      ['MMout1', 1, 'media/out/1/b', 'application/pdf'],
      ['MMout1', 0, 'media/out/1/a', 'image/jpeg'],
    ]);
    expect(pointers[0]!.at).toBe('2026-08-18T10:00:00.000Z');
    expect(pointers[0]!.tsMsgId).toBe(buildTsMsgId('2026-08-18T10:00:00.000Z', 'MMout1'));
  });

  it('an INBOUND MMS mirrored after append is indexed by annotateMessage; a re-annotate is idempotent', async () => {
    const appended = await messages.append({
      conversationId: CONV,
      type: 'mms',
      direction: 'inbound',
      author: 'tenant',
      providerSid: 'MMin1',
      providerTs: '2026-08-18T11:00:00.000Z',
      deliveryStatus: 'delivered',
    });
    // Nothing yet: the message row exists, its media is still being mirrored.
    expect((await messages.listMediaPointers(CONV, { limit: 10 })).some((p) => p.providerSid === 'MMin1')).toBe(false);

    await messages.annotateMessage(CONV, appended.tsMsgId, {
      mediaAttachments: [{ s3Key: 'media/in/1/0', contentType: 'image/png' }],
    });
    // The media.mirror job appends a late attachment: the array grows, the
    // existing pointer is rewritten unchanged, the new position is added.
    await messages.annotateMessage(CONV, appended.tsMsgId, {
      mediaAttachments: [
        { s3Key: 'media/in/1/0', contentType: 'image/png' },
        { s3Key: 'media/in/1/1', contentType: 'image/gif' },
      ],
    });

    const mine = (await messages.listMediaPointers(CONV, { limit: 10 })).filter((p) => p.providerSid === 'MMin1');
    expect(mine.map((p) => [p.index, p.s3Key])).toEqual([
      [1, 'media/in/1/1'],
      [0, 'media/in/1/0'],
    ]);
  });

  it('pages newest-first with an exclusive `before` cursor and no cap - across everything above', async () => {
    const page1 = await messages.listMediaPointers(CONV, { limit: 3 });
    expect(page1).toHaveLength(3);
    // Newest message (11:00 inbound) first, then the outbound's two.
    expect(page1.map((p) => p.providerSid)).toEqual(['MMin1', 'MMin1', 'MMout1']);
    const page2 = await messages.listMediaPointers(CONV, { limit: 3, before: page1[2]!.sortKey });
    expect(page2.map((p) => [p.providerSid, p.index])).toEqual([['MMout1', 0]]);
    const page3 = await messages.listMediaPointers(CONV, { limit: 3, before: page2[0]!.sortKey });
    expect(page3).toEqual([]);
  });

  it('the backfill re-derives every pointer from the messages: idempotent, dry run writes nothing', async () => {
    const { backfillMediaPointers } = await import('../scripts/backfill-media-pointers.js');
    // A LEGACY row: attachments stored, but written before the index - model it
    // by deleting the pointers the runtime wrote for MMout1.
    const { DeleteCommand } = await import('@aws-sdk/lib-dynamodb');
    const outSk = buildTsMsgId('2026-08-18T10:00:00.000Z', 'MMout1');
    for (const i of [0, 1]) {
      await doc.send(new DeleteCommand({ TableName: table, Key: { conversationId: `media#${CONV}`, tsMsgId: mediaPointerSk(outSk, i) } }));
    }
    expect((await messages.listMediaPointers(CONV, { limit: 10 })).some((p) => p.providerSid === 'MMout1')).toBe(false);

    const dry = await backfillMediaPointers({ dryRun: true, doc, env: testEnv, messagesRepo: messages });
    // Two media-bearing messages so far (MMout1 x2 attachments, MMin1 x2).
    expect(dry).toEqual({ messages: 2, pointers: 4 });
    expect((await messages.listMediaPointers(CONV, { limit: 10 })).some((p) => p.providerSid === 'MMout1')).toBe(false);

    const live = await backfillMediaPointers({ doc, env: testEnv, messagesRepo: messages });
    expect(live).toEqual({ messages: 2, pointers: 4 });
    const all = await messages.listMediaPointers(CONV, { limit: 10 });
    expect(all.map((p) => `${p.providerSid}:${p.index}`)).toEqual(['MMin1:1', 'MMin1:0', 'MMout1:1', 'MMout1:0']);
    // Again: same rows, same count.
    expect(await backfillMediaPointers({ doc, env: testEnv, messagesRepo: messages })).toEqual({ messages: 2, pointers: 4 });
    expect(await messages.listMediaPointers(CONV, { limit: 10 })).toHaveLength(4);
  });

  it('a message with NO media writes no pointer', async () => {
    await messages.append({
      conversationId: CONV,
      type: 'sms',
      direction: 'inbound',
      author: 'tenant',
      providerSid: 'SMtext1',
      providerTs: '2026-08-18T12:00:00.000Z',
      body: 'hi',
      deliveryStatus: 'delivered',
    });
    expect((await messages.listMediaPointers(CONV, { limit: 10 })).some((p) => p.providerSid === 'SMtext1')).toBe(false);
  });
});
