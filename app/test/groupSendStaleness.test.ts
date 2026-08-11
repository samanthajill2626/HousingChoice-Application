// T6.4 - the per-send delivery-staleness alarm.
//
// This is now the ONLY detector of a dead receipts webhook. The S5-PRE addendum
// proved classic status callbacks do not fire for Conversations-originated
// sends, so if `onDeliveryUpdated` stops arriving there is no second channel and
// nothing else in the system notices. That makes two properties worth proving
// against a real table rather than a fake: the due row really is written by the
// append (so a crash anywhere after the message exists still leaves it
// monitored), and the terminal predicate really is the group-local one.
//
// A18 is the trap this suite guards: `relayFanOut.isTerminal` counts `sent` and
// omits `undelivered`. Under that predicate a slot stuck at `sent` - the exact
// silent-webhook symptom - would read as finished and never alarm.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import {
  buildGroupSendDueRow,
  buildTsMsgId,
  createMessagesRepo,
  GROUP_DUE_PARTITION,
  GROUP_SEND_STALENESS_MS,
  type RelayRecipientDelivery,
} from '../src/repos/messagesRepo.js';
import {
  createGroupSendStaleness,
  isGroupDeliveryTerminal,
} from '../src/services/groupSendStaleness.js';

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
if (!reachable) {
  console.warn(
    `[groupSendStaleness.integration] SKIPPED - no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

describe('group-local terminal predicate (A18)', () => {
  it('treats delivered, failed and undelivered as terminal', () => {
    expect(isGroupDeliveryTerminal('delivered')).toBe(true);
    expect(isGroupDeliveryTerminal('failed')).toBe(true);
    expect(isGroupDeliveryTerminal('undelivered')).toBe(true);
  });

  it('treats sent and queued as NON-terminal - a stuck `sent` is the symptom', () => {
    expect(isGroupDeliveryTerminal('sent')).toBe(false);
    expect(isGroupDeliveryTerminal('queued')).toBe(false);
    expect(isGroupDeliveryTerminal(undefined)).toBe(false);
  });
});

describe.skipIf(!reachable)('group send staleness against DynamoDB Local', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const table = tableName('messages', testEnv);
  const messages = createMessagesRepo({ doc, env: testEnv });

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('messages'), table);
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, table);
    doc.destroy();
    client.destroy();
  }, 120_000);

  const SENT_AT = '2026-08-11T12:00:00.000Z';
  const PAST_DEADLINE = new Date(
    Date.parse(SENT_AT) + GROUP_SEND_STALENESS_MS + 60_000,
  ).toISOString();

  let seq = 0;
  /** A real group send: the message row AND its due row, in ONE transaction. */
  async function groupSend(
    slots: Record<string, RelayRecipientDelivery>,
  ): Promise<{ conversationId: string; providerSid: string; tsMsgId: string }> {
    seq += 1;
    const conversationId = `convGroup:staleness-${seq}-${randomUUID().slice(0, 8)}`;
    const providerSid = `IM${seq}${randomUUID().replace(/-/g, '')}`.slice(0, 34);
    const tsMsgId = buildTsMsgId(SENT_AT, providerSid);
    const appended = await messages.append({
      conversationId,
      providerSid,
      providerTs: SENT_AT,
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      deliveryStatus: 'queued',
      body: 'group reply',
      deliveryRecipients: slots,
      dueRow: buildGroupSendDueRow({
        conversationId,
        tsMsgId,
        providerSid,
        deadlineAt: new Date(Date.parse(SENT_AT) + GROUP_SEND_STALENESS_MS).toISOString(),
      }),
    });
    return { conversationId, providerSid, tsMsgId: appended.tsMsgId };
  }

  function service(log: { error: unknown }) {
    return createGroupSendStaleness({ messagesRepo: messages, logger: log as never });
  }

  it('PARTIAL RECEIPT LOSS alarms: one member delivered, one still `sent`', async () => {
    const send = await groupSend({
      'phone#+15551110001': { status: 'delivered' },
      'phone#+15551110002': { status: 'sent' },
    });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    const outcome = await service(log).sweepSendStaleness(PAST_DEADLINE);

    expect(outcome.alarmed).toBe(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'group_send_receipts_stale',
        conversationId: send.conversationId,
        providerSid: send.providerSid,
      }),
      'group delivery receipts silent - check Conversations service webhook config',
    );
  });

  it('alarms ONCE - the resolved due row is gone from the deadline partition', async () => {
    await groupSend({ 'phone#+15551110003': { status: 'queued' } });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const svc = service(log);

    expect((await svc.sweepSendStaleness(PAST_DEADLINE)).alarmed).toBe(1);
    log.error.mockClear();
    expect((await svc.sweepSendStaleness(PAST_DEADLINE)).alarmed).toBe(0);
    expect(log.error).not.toHaveBeenCalled();
    expect(await messages.listDueRows(GROUP_DUE_PARTITION, PAST_DEADLINE)).toEqual([]);
  });

  it('a FULLY DELIVERED send clears without alarming', async () => {
    await groupSend({
      'phone#+15551110004': { status: 'delivered' },
      'phone#+15551110005': { status: 'delivered' },
    });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    const outcome = await service(log).sweepSendStaleness(PAST_DEADLINE);

    expect(outcome.cleared).toBe(1);
    expect(outcome.alarmed).toBe(0);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('a send whose members ALL failed or went undelivered is terminal, not stale', async () => {
    await groupSend({
      'phone#+15551110006': { status: 'failed' },
      'phone#+15551110007': { status: 'undelivered' },
    });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    const outcome = await service(log).sweepSendStaleness(PAST_DEADLINE);
    expect(outcome.alarmed).toBe(0);
    expect(outcome.cleared).toBe(1);
  });

  it('does NOT alarm before the deadline', async () => {
    await groupSend({ 'phone#+15551110008': { status: 'sent' } });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    const outcome = await service(log).sweepSendStaleness(SENT_AT);
    expect(outcome.scanned).toBe(0);
    expect(log.error).not.toHaveBeenCalled();

    // ...and the row is still there, waiting for its deadline.
    await service(log).sweepSendStaleness(PAST_DEADLINE);
    expect(log.error).toHaveBeenCalled();
  });

  it('CRASH ANYWHERE AFTER THE APPEND is still monitored - the due row is transactional', async () => {
    // Nothing but the append ran: no receipt, no drain, no follow-up write.
    const send = await groupSend({ 'phone#+15551110009': { status: 'queued' } });

    const due = await messages.listDueRows(GROUP_DUE_PARTITION, PAST_DEADLINE);
    expect(due.some((row) => row.providerSid === send.providerSid)).toBe(true);
  });

  it('the direct `__dev` check reports the stuck members for one message', async () => {
    const send = await groupSend({
      'phone#+15551110010': { status: 'delivered' },
      'phone#+15551110011': { status: 'sent' },
    });

    const result = await service({ error: vi.fn() }).checkMessage({
      conversationId: send.conversationId,
      tsMsgId: send.tsMsgId,
    });

    expect(result.outcome).toBe('alarmed');
    expect(result.stuck).toEqual([{ memberKey: 'phone#+15551110011', status: 'sent' }]);
  });

  it('a message row that is gone resolves as missing rather than alarming forever', async () => {
    const result = await service({ error: vi.fn() }).checkMessage({
      conversationId: 'convGroup:no-such-thread',
      tsMsgId: '2026-08-11T12:00:00.000Z#nope',
    });
    expect(result.outcome).toBe('missing');
  });
});
