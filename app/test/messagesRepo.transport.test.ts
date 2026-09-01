import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import {
  buildTsMsgId,
  createMessagesRepo,
  type MessageItem,
  type NewMessage,
  type RelayRecipientDelivery,
} from '../src/repos/messagesRepo.js';

const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://127.0.0.1:8000';

async function endpointReachable(): Promise<boolean> {
  try {
    await fetch(endpoint, { signal: AbortSignal.timeout(1_500) });
    return true;
  } catch {
    return false;
  }
}

const reachable = await endpointReachable();
if (!reachable) {
  console.warn(
    `[messagesRepo.transport] SKIPPED - no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

describe.skipIf(!reachable)('versioned message transport persistence', () => {
  const testEnv = { TABLE_PREFIX: `hc-transport-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const table = tableName('messages', testEnv);
  const repo = createMessagesRepo({ doc, env: testEnv });
  let sequence = 0;

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('messages'), table);
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, table);
    doc.destroy();
    client.destroy();
  }, 120_000);

  function nextMessage(
    overrides: Partial<NewMessage> = {},
  ): NewMessage & { conversationId: string; providerSid: string; providerTs: string } {
    sequence += 1;
    return {
      conversationId: `transport-conversation-${sequence}`,
      providerSid: `SMtransport${String(sequence).padStart(8, '0')}`,
      providerTs: `2026-09-01T12:${String(sequence).padStart(2, '0')}:00.000Z`,
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      body: 'transport fixture',
      deliveryStatus: 'queued',
      transportSchemaVersion: 1,
      ...overrides,
    };
  }

  async function append(
    overrides: Partial<NewMessage> = {},
  ): Promise<{ message: NewMessage; tsMsgId: string }> {
    const message = nextMessage(overrides);
    const result = await repo.append(message);
    expect(result.deduped).toBe(false);
    return {
      message,
      tsMsgId: buildTsMsgId(message.providerTs, message.providerSid),
    };
  }

  async function read(conversationId: string, tsMsgId: string): Promise<MessageItem> {
    const { Item } = await doc.send(
      new GetCommand({ TableName: table, Key: { conversationId, tsMsgId }, ConsistentRead: true }),
    );
    expect(Item).toBeDefined();
    return Item as MessageItem;
  }

  it('maps versioned message and recipient facts without changing modality or delivery fields', async () => {
    const slot: RelayRecipientDelivery = {
      status: 'sent',
      sid: 'SMrecipient',
      errorCode: 'temporary',
      sentAt: '2026-09-01T12:00:01.000Z',
      requestedTransport: 'rcs',
      actualTransport: 'mms',
      transportAggregationState: 'attempted',
    };
    const { message, tsMsgId } = await append({
      type: 'sms',
      deliveryStatus: 'sent',
      errorCode: 'source-error',
      requestedTransport: 'rcs',
      actualTransport: 'mms',
      deliveryRecipients: { member: slot },
    });

    const stored = await read(message.conversationId, tsMsgId);
    expect(stored).toMatchObject({
      type: 'sms',
      delivery_status: 'sent',
      error_code: 'source-error',
      transport_schema_version: 1,
      requested_transport: 'rcs',
      actual_transport: 'mms',
      delivery_recipients: { member: slot },
    });
  });

  it.each([
    ['carrier fields on a call', { type: 'call', requestedTransport: 'sms' }],
    ['carrier fields on email', { type: 'email', actualTransport: 'sms' }],
    ['transport fields without version 1', { transportSchemaVersion: undefined, actualTransport: 'sms' }],
    ['requested transport on inbound', { direction: 'inbound', requestedTransport: 'sms' }],
    ['an invalid message actual transport', { actualTransport: 'fax' }],
    ['an invalid recipient requested transport', {
      deliveryRecipients: { member: { status: 'queued', requestedTransport: 'fax' } },
    }],
  ])('rejects %s at the persistence boundary', async (_label, override) => {
    const message = nextMessage(override as Partial<NewMessage>);
    await expect(repo.append(message)).rejects.toBeInstanceOf(TypeError);
  });

  it('returns quiet legacy no-ops and does not add transport fields to schema-absent rows', async () => {
    const { message, tsMsgId } = await append({
      transportSchemaVersion: undefined,
      deliveryRecipients: { member: { status: 'queued' } },
    });
    const before = await read(message.conversationId, tsMsgId);

    await expect(
      repo.setMessageActualTransport(message.conversationId, tsMsgId, 'sms'),
    ).resolves.toBe('legacy_noop');
    await expect(
      repo.initializeRecipientDelivery(message.conversationId, tsMsgId, 'other', {
        status: 'queued',
        requestedTransport: 'rcs',
      }),
    ).resolves.toBe('legacy_noop');
    await expect(
      repo.setRecipientTransportAggregationState(message.conversationId, tsMsgId, 'member', 'planned'),
    ).resolves.toBe('legacy_noop');
    await expect(
      repo.setRecipientActualTransport(message.conversationId, tsMsgId, 'member', 'sms'),
    ).resolves.toBe('legacy_noop');
    await expect(
      repo.applyRecipientSendResult(message.conversationId, tsMsgId, 'member', {
        status: 'sent',
        sid: 'SMlegacy',
        actualTransport: 'sms',
      }),
    ).resolves.toBe('legacy_noop');

    expect(await read(message.conversationId, tsMsgId)).toEqual(before);
  });

  it('distinguishes missing messages and recipient slots', async () => {
    await expect(repo.setMessageActualTransport('missing', 'missing', 'sms')).resolves.toBe('missing');
    await expect(
      repo.initializeRecipientDelivery('missing', 'missing', 'member', { status: 'queued' }),
    ).resolves.toBe('missing');

    const { message, tsMsgId } = await append({ deliveryRecipients: {} });
    await expect(
      repo.setRecipientTransportAggregationState(message.conversationId, tsMsgId, 'missing', 'planned'),
    ).resolves.toBe('missing');
    await expect(
      repo.setRecipientActualTransport(message.conversationId, tsMsgId, 'missing', 'sms'),
    ).resolves.toBe('missing');
    await expect(
      repo.applyRecipientSendResult(message.conversationId, tsMsgId, 'missing', { status: 'sent' }),
    ).resolves.toBe('missing');
  });

  it('applies message actual transitions and classifies stale and conflicting observations', async () => {
    const rcs = await append({ requestedTransport: 'rcs' });
    await expect(
      repo.setMessageActualTransport(rcs.message.conversationId, rcs.tsMsgId, 'rcs'),
    ).resolves.toBe('updated');
    await expect(
      repo.setMessageActualTransport(rcs.message.conversationId, rcs.tsMsgId, 'rcs'),
    ).resolves.toBe('idempotent');
    await expect(
      repo.setMessageActualTransport(rcs.message.conversationId, rcs.tsMsgId, 'sms'),
    ).resolves.toBe('updated');
    await expect(
      repo.setMessageActualTransport(rcs.message.conversationId, rcs.tsMsgId, 'rcs'),
    ).resolves.toBe('stale');

    const sms = await append({ requestedTransport: 'sms', actualTransport: 'sms' });
    await expect(
      repo.setMessageActualTransport(sms.message.conversationId, sms.tsMsgId, 'mms'),
    ).resolves.toBe('conflict');
    await expect(
      repo.setMessageActualTransport(sms.message.conversationId, sms.tsMsgId, 'fax' as never),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('applies recipient actual transitions and resolves a conditional race', async () => {
    const { message, tsMsgId } = await append({
      requestedTransport: 'rcs',
      actualTransport: 'sms',
      deliveryRecipients: {
        member: { status: 'queued', requestedTransport: 'rcs' },
      },
    });

    const outcomes = await Promise.all([
      repo.setRecipientActualTransport(message.conversationId, tsMsgId, 'member', 'rcs'),
      repo.setRecipientActualTransport(message.conversationId, tsMsgId, 'member', 'sms'),
    ]);
    expect(outcomes).toContain('updated');
    expect(outcomes.every((outcome) => outcome === 'updated' || outcome === 'stale')).toBe(true);
    expect((await read(message.conversationId, tsMsgId)).delivery_recipients?.member?.actualTransport).toBe(
      'sms',
    );
  });

  it('enforces aggregation transitions including attempted terminality', async () => {
    const { message, tsMsgId } = await append({
      deliveryRecipients: {
        member: { status: 'queued', requestedTransport: 'rcs' },
        attempted: {
          status: 'queued',
          requestedTransport: 'rcs',
          transportAggregationState: 'planned',
        },
      },
    });

    await expect(
      repo.setRecipientTransportAggregationState(message.conversationId, tsMsgId, 'member', 'planned'),
    ).resolves.toBe('updated');
    await expect(
      repo.setRecipientTransportAggregationState(message.conversationId, tsMsgId, 'member', 'planned'),
    ).resolves.toBe('idempotent');
    await expect(
      repo.setRecipientTransportAggregationState(message.conversationId, tsMsgId, 'member', 'excluded'),
    ).resolves.toBe('updated');
    await expect(
      repo.setRecipientTransportAggregationState(message.conversationId, tsMsgId, 'member', 'planned'),
    ).resolves.toBe('updated');
    await expect(
      repo.setRecipientTransportAggregationState(message.conversationId, tsMsgId, 'attempted', 'attempted'),
    ).resolves.toBe('updated');
    await expect(
      repo.setRecipientTransportAggregationState(message.conversationId, tsMsgId, 'attempted', 'excluded'),
    ).resolves.toBe('conflict');
  });

  it('refuses excluded to planned after actual evidence exists', async () => {
    const { message, tsMsgId } = await append({
      deliveryRecipients: {
        member: {
          status: 'queued',
          requestedTransport: 'rcs',
          actualTransport: 'sms',
          transportAggregationState: 'excluded',
        },
      },
    });
    await expect(
      repo.setRecipientTransportAggregationState(message.conversationId, tsMsgId, 'member', 'planned'),
    ).resolves.toBe('conflict');
  });

  it('initializes only an absent recipient slot and preserves the winner of a race', async () => {
    const { message, tsMsgId } = await append({ deliveryRecipients: {} });
    const outcomes = await Promise.all([
      repo.initializeRecipientDelivery(message.conversationId, tsMsgId, 'member', {
        status: 'queued',
        requestedTransport: 'rcs',
      }),
      repo.initializeRecipientDelivery(message.conversationId, tsMsgId, 'member', {
        status: 'failed',
        errorCode: 'must-not-overwrite',
        requestedTransport: 'sms',
      }),
    ]);

    expect(outcomes.sort()).toEqual(['created', 'existing']);
    const slot = (await read(message.conversationId, tsMsgId)).delivery_recipients?.member;
    expect([
      { status: 'queued', requestedTransport: 'rcs' },
      { status: 'failed', errorCode: 'must-not-overwrite', requestedTransport: 'sms' },
    ]).toContainEqual(slot);
  });

  it('writes same-status success metadata and actual evidence while clearing a transient error', async () => {
    const firstSentAt = '2026-09-01T13:00:00.000Z';
    const { message, tsMsgId } = await append({
      deliveryRecipients: {
        member: {
          status: 'sent',
          errorCode: 'temporary',
          requestedTransport: 'rcs',
          transportAggregationState: 'attempted',
        },
      },
    });

    await expect(
      repo.applyRecipientSendResult(message.conversationId, tsMsgId, 'member', {
        status: 'sent',
        sid: 'SMfirst',
        sentAt: firstSentAt,
        actualTransport: 'sms',
      }),
    ).resolves.toBe('updated');
    expect((await read(message.conversationId, tsMsgId)).delivery_recipients?.member).toEqual({
      status: 'sent',
      sid: 'SMfirst',
      sentAt: firstSentAt,
      requestedTransport: 'rcs',
      actualTransport: 'sms',
      transportAggregationState: 'attempted',
    });

    await expect(
      repo.applyRecipientSendResult(message.conversationId, tsMsgId, 'member', {
        status: 'sent',
        sid: 'SMsecond',
        sentAt: '2026-09-01T13:01:00.000Z',
        actualTransport: 'sms',
      }),
    ).resolves.toBe('idempotent');
    const duplicate = (await read(message.conversationId, tsMsgId)).delivery_recipients?.member;
    expect(duplicate?.sid).toBe('SMfirst');
    expect(duplicate?.sentAt).toBe(firstSentAt);
  });

  it('clears a queued accepted transient error while preserving the first acceptance metadata', async () => {
    const firstSentAt = '2026-09-01T13:30:00.000Z';
    const { message, tsMsgId } = await append({
      deliveryRecipients: {
        member: {
          status: 'queued',
          errorCode: '30003',
          requestedTransport: 'sms',
        },
      },
    });

    await expect(
      repo.applyRecipientSendResult(message.conversationId, tsMsgId, 'member', {
        status: 'queued',
        sid: 'SMaccepted-first',
        sentAt: firstSentAt,
      }),
    ).resolves.toBe('updated');
    expect((await read(message.conversationId, tsMsgId)).delivery_recipients?.member).toEqual({
      status: 'queued',
      sid: 'SMaccepted-first',
      sentAt: firstSentAt,
      requestedTransport: 'sms',
    });

    await expect(
      repo.applyRecipientSendResult(message.conversationId, tsMsgId, 'member', {
        status: 'queued',
        sid: 'SMaccepted-duplicate',
        sentAt: '2026-09-01T13:31:00.000Z',
      }),
    ).resolves.toBe('idempotent');
    expect((await read(message.conversationId, tsMsgId)).delivery_recipients?.member).toEqual({
      status: 'queued',
      sid: 'SMaccepted-first',
      sentAt: firstSentAt,
      requestedTransport: 'sms',
    });
  });

  it('does not regress status but still fills absent metadata and actual transport', async () => {
    const { message, tsMsgId } = await append({
      deliveryRecipients: {
        member: { status: 'sent', requestedTransport: 'mms' },
      },
    });
    await expect(
      repo.applyRecipientSendResult(message.conversationId, tsMsgId, 'member', {
        status: 'queued',
        sid: 'SMlate',
        sentAt: '2026-09-01T14:00:00.000Z',
        actualTransport: 'mms',
      }),
    ).resolves.toBe('updated');
    expect((await read(message.conversationId, tsMsgId)).delivery_recipients?.member).toEqual({
      status: 'sent',
      sid: 'SMlate',
      sentAt: '2026-09-01T14:00:00.000Z',
      requestedTransport: 'mms',
      actualTransport: 'mms',
    });
  });

  it('clears a continuation transient error on first success and preserves first SID and time', async () => {
    const firstSentAt = '2026-09-01T15:00:00.000Z';
    const { message, tsMsgId } = await append({
      deliveryRecipients: {
        member: { status: 'queued', errorCode: 'provider-temporary', requestedTransport: 'sms' },
      },
    });
    await expect(
      repo.applyRecipientSendResult(message.conversationId, tsMsgId, 'member', {
        status: 'sent',
        sid: 'SMcontinuation-first',
        sentAt: firstSentAt,
        actualTransport: 'sms',
      }),
    ).resolves.toBe('updated');
    await expect(
      repo.applyRecipientSendResult(message.conversationId, tsMsgId, 'member', {
        status: 'sent',
        sid: 'SMcontinuation-duplicate',
        sentAt: '2026-09-01T15:01:00.000Z',
        actualTransport: 'sms',
      }),
    ).resolves.toBe('idempotent');

    expect((await read(message.conversationId, tsMsgId)).delivery_recipients?.member).toEqual({
      status: 'sent',
      sid: 'SMcontinuation-first',
      sentAt: firstSentAt,
      requestedTransport: 'sms',
      actualTransport: 'sms',
    });
  });

  it('protects terminal error data from a stale transient result', async () => {
    const { message, tsMsgId } = await append({
      deliveryRecipients: {
        member: { status: 'failed', errorCode: 'terminal-provider-error', requestedTransport: 'sms' },
      },
    });
    await expect(
      repo.applyRecipientSendResult(message.conversationId, tsMsgId, 'member', {
        status: 'queued',
        errorCode: 'stale-transient-error',
      }),
    ).resolves.toBe('stale');
    expect((await read(message.conversationId, tsMsgId)).delivery_recipients?.member).toEqual({
      status: 'failed',
      errorCode: 'terminal-provider-error',
      requestedTransport: 'sms',
    });
  });

  it('retains a terminal diagnostic when a duplicate failed result has no error code', async () => {
    const { message, tsMsgId } = await append({
      deliveryRecipients: {
        member: { status: 'failed', errorCode: 'terminal-provider-error', requestedTransport: 'sms' },
      },
    });

    await expect(
      repo.applyRecipientSendResult(message.conversationId, tsMsgId, 'member', { status: 'failed' }),
    ).resolves.toBe('idempotent');
    expect((await read(message.conversationId, tsMsgId)).delivery_recipients?.member).toEqual({
      status: 'failed',
      errorCode: 'terminal-provider-error',
      requestedTransport: 'sms',
    });
  });

  it('reclassifies an identical durable winner after the final conditional race', async () => {
    const { message, tsMsgId } = await append({
      deliveryRecipients: {
        member: { status: 'queued', requestedTransport: 'sms' },
      },
    });
    let forcedConditionalFailures = 0;
    const raceRepo = createMessagesRepo({
      doc: {
        async send(command: unknown) {
          if (
            command instanceof UpdateCommand &&
            command.input.Key?.conversationId === message.conversationId &&
            command.input.Key.tsMsgId === tsMsgId
          ) {
            forcedConditionalFailures += 1;
            if (forcedConditionalFailures === 4) await doc.send(command);
            throw new ConditionalCheckFailedException({ message: 'forced conditional race', $metadata: {} });
          }
          return doc.send(command as never);
        },
      } as never,
      env: testEnv,
    });

    await expect(
      raceRepo.applyRecipientSendResult(message.conversationId, tsMsgId, 'member', {
        status: 'sent',
        sid: 'SMdurable-winner',
      }),
    ).resolves.toBe('idempotent');
    expect(forcedConditionalFailures).toBe(4);
    expect((await read(message.conversationId, tsMsgId)).delivery_recipients?.member).toEqual({
      status: 'sent',
      sid: 'SMdurable-winner',
      requestedTransport: 'sms',
    });
  });

  it('logs a safe info event for stale RCS evidence after durable SMS fallback', async () => {
    const { message, tsMsgId } = await append({
      requestedTransport: 'rcs',
      actualTransport: 'sms',
      deliveryRecipients: {
        'phone#+15555550100': {
          status: 'sent',
          requestedTransport: 'rcs',
          actualTransport: 'sms',
        },
      },
    });
    const info = vi.fn();
    const warn = vi.fn();
    const observingRepo = createMessagesRepo({
      doc,
      env: testEnv,
      logger: { info, warn } as never,
    });

    await expect(
      observingRepo.setRecipientActualTransport(message.conversationId, tsMsgId, 'phone#+15555550100', 'rcs'),
    ).resolves.toBe('stale');
    await expect(observingRepo.setMessageActualTransport(message.conversationId, tsMsgId, 'rcs')).resolves.toBe(
      'stale',
    );
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: message.conversationId,
        tsMsgId,
        memberKey: 'phone#redacted',
        currentTransport: 'sms',
        attemptedTransport: 'rcs',
      }),
      expect.stringContaining('stale'),
    );
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: message.conversationId,
        tsMsgId,
        currentTransport: 'sms',
        attemptedTransport: 'rcs',
      }),
      expect.stringContaining('stale'),
    );
    expect(warn).not.toHaveBeenCalled();
    expect(JSON.stringify(info.mock.calls)).not.toContain('5555550100');
  });

  it('preserves independent concurrent status, SID, error, time, actual, and aggregation writes', async () => {
    const { message, tsMsgId } = await append({
      deliveryRecipients: {
        member: {
          status: 'queued',
          errorCode: 'temporary',
          requestedTransport: 'rcs',
          transportAggregationState: 'planned',
        },
      },
    });

    const outcomes = await Promise.all([
      repo.applyRecipientSendResult(message.conversationId, tsMsgId, 'member', {
        status: 'sent',
        sid: 'SMconcurrent',
        sentAt: '2026-09-01T16:00:00.000Z',
      }),
      repo.setRecipientActualTransport(message.conversationId, tsMsgId, 'member', 'mms'),
      repo.setRecipientTransportAggregationState(message.conversationId, tsMsgId, 'member', 'attempted'),
    ]);
    expect(outcomes).toEqual(['updated', 'updated', 'updated']);
    expect((await read(message.conversationId, tsMsgId)).delivery_recipients?.member).toEqual({
      status: 'sent',
      sid: 'SMconcurrent',
      sentAt: '2026-09-01T16:00:00.000Z',
      requestedTransport: 'rcs',
      actualTransport: 'mms',
      transportAggregationState: 'attempted',
    });
  });
});
