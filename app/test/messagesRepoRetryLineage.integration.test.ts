// Relay 30003 retry lineage (spec D1, D2, D3, D11, D12, D13) against DynamoDB
// Local. A retry is a NEW source message row addressed to one member, carrying
// its own single-entry recipient map plus the six lineage values that let the
// dashboard join it back to the leg it is retrying.
//
// Its own throwaway table prefix, per worklist D7: a new integration file takes
// the per-file DynamoDB access key automatically and must NOT carry the shared
// lane marker.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { createLogger } from '../src/lib/logger.js';
import { relayRetryDigest, relayRetryProviderSid } from '../src/lib/relayRetryClaim.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createMessagesRepo, type NewMessage } from '../src/repos/messagesRepo.js';

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
});
