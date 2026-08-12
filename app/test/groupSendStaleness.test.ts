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
  GROUP_SEND_DUE_PARTITION,
  GROUP_SEND_STALENESS_MS,
  type RelayRecipientDelivery,
} from '../src/repos/messagesRepo.js';
import { suppressedSlot } from '../src/services/groupDelivery.js';
import {
  createGroupSendStaleness,
  isGroupDeliveryTerminal,
  isGroupSlotTerminal,
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

// LIVE QA ROUND 2, L3. Twilio SKIPS a suppressed participant - no leg, no
// attempt, no 21610 - so no receipt will EVER arrive for that member. Treating
// their slot as pending made every send to a group containing one opted-out
// member raise the false "receipts silent" ERROR, which trains the operator to
// ignore the only alarm that detects a genuinely dead receipts webhook.
describe('slot-level terminality: a leg no receipt will ever arrive for (L3)', () => {
  it('counts a SUPPRESSED slot as terminal, however it is spelled', () => {
    expect(isGroupSlotTerminal(suppressedSlot())).toBe(true);
    // Defense in depth: the alarm's contract is about receipts that will never
    // come, so the synthetic code alone settles it - independent of the status
    // the seed happens to use.
    expect(isGroupSlotTerminal({ status: 'queued', errorCode: 'contact_opted_out' })).toBe(true);
  });

  it('still counts an ordinary pending slot as NON-terminal', () => {
    expect(isGroupSlotTerminal({ status: 'queued' })).toBe(false);
    expect(isGroupSlotTerminal({ status: 'sent' })).toBe(false);
    // A REAL carrier failure keeps its own code and is terminal on status.
    expect(isGroupSlotTerminal({ status: 'failed', errorCode: '30007' })).toBe(true);
    // A pending slot with an unrelated code is still pending.
    expect(isGroupSlotTerminal({ status: 'sent', errorCode: '30003' })).toBe(false);
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

  /** A drain that records what it was asked to drain. */
  function recordingReceipts(): { drainParked: (sid: string) => Promise<number>; drained: string[] } {
    const drained: string[] = [];
    return {
      drained,
      async drainParked(sid: string) {
        drained.push(sid);
        return 0;
      },
    };
  }

  function service(
    log: { error: unknown },
    receipts: { drainParked: (sid: string) => Promise<number> } = recordingReceipts(),
  ) {
    return createGroupSendStaleness({
      messagesRepo: messages,
      receipts: receipts as never,
      logger: log as never,
    });
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
    expect(await messages.listDueRows(GROUP_SEND_DUE_PARTITION, PAST_DEADLINE)).toEqual([]);
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

  it('a KNOWN-SUPPRESSED member does NOT raise the false receipts-silent alarm (L3)', async () => {
    // The live shape exactly: one member opted out, one delivered. Twilio never
    // created the opted-out leg, so no receipt can ever move that slot.
    await groupSend({
      'phone#+15551110020': { status: 'delivered' },
      'phone#+15551110021': suppressedSlot(),
    });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    const outcome = await service(log).sweepSendStaleness(PAST_DEADLINE);

    expect(outcome.alarmed).toBe(0);
    expect(outcome.cleared).toBe(1);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('and the SAME send with that member left `queued` still alarms - the alarm is intact', async () => {
    // The discriminator. Without the seed the slot is a bare `queued`, and this
    // is the false ERROR the operator saw on every send to that group. Keeping
    // it proves the fix is a LABEL, not a weakening of the alarm.
    const send = await groupSend({
      'phone#+15551110022': { status: 'delivered' },
      'phone#+15551110023': { status: 'queued' },
    });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    const outcome = await service(log).sweepSendStaleness(PAST_DEADLINE);

    expect(outcome.alarmed).toBe(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'group_send_receipts_stale',
        conversationId: send.conversationId,
      }),
      'group delivery receipts silent - check Conversations service webhook config',
    );
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

    const due = await messages.listDueRows(GROUP_SEND_DUE_PARTITION, PAST_DEADLINE);
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

  // THE DEFECT THIS PINS (fix wave 4, X2/C2). `drainParked` had exactly ONE
  // caller - the send path, immediately after its append. A receipt that parked
  // AFTER that call (it lost the race, or the drain itself threw) had nothing
  // left to apply it, so the slot read `Delivered 0/N` forever for a message
  // that WAS delivered and this sweep then alarmed "check Conversations service
  // webhook config" - a misdiagnosis that sends an operator to a healthy system.
  it('DRAINS parked receipts for the due row BEFORE deciding a send is stale', async () => {
    const send = await groupSend({ 'phone#+15551110012': { status: 'queued' } });
    const receipts = recordingReceipts();

    await service({ error: vi.fn() }, receipts).sweepSendStaleness(PAST_DEADLINE);

    expect(receipts.drained).toContain(send.providerSid);
  });

  it('still raises the alarm when the drain throws - a drain failure is not a reason to go quiet', async () => {
    const send = await groupSend({ 'phone#+15551110013': { status: 'sent' } });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const throwing = {
      async drainParked() {
        throw new Error('DynamoDB throttle');
      },
    };

    const outcome = await service(log, throwing as never).sweepSendStaleness(PAST_DEADLINE);

    expect(outcome.alarmed).toBe(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ providerSid: send.providerSid }),
      'group delivery receipts silent - check Conversations service webhook config',
    );
  });

  // THE DEFECT THIS PINS (fix wave 4, X3). Both guardrail sweeps used to Query
  // ONE shared deadline partition with `Limit: 50` and drop the other kind AFTER
  // the limit was spent, so a backlog of overdue cross-check rows hid every
  // stuck send - precisely when both webhooks are most likely broken at once.
  it('a BACKLOG of overdue cross-check rows cannot hide a stuck send', async () => {
    const stuck = await groupSend({ 'phone#+15551110014': { status: 'sent' } });
    // A full sweep batch of cross-check rows, every one of them OLDER than the
    // send's deadline, so they would sort ahead of it in a shared partition.
    const backlog = 50;
    // SEQUENTIAL SETUP, deliberately. Each event is now four writes rather than
    // two, and firing 200 of them at once at DynamoDB Local (single-threaded,
    // and shared with every other integration suite on this machine) draws
    // "timed out waiting for a lock" from the emulator - a harness limit, not a
    // product one. Nothing about this test needs concurrency: the rows just have
    // to exist before the sweep runs.
    for (let i = 0; i < backlog; i += 1) {
      await messages.recordCrossCheckEvent(
        {
          pairKey: `groupxc#CHstarve#phone#+1555000${String(i).padStart(4, '0')}`,
          messageSid: `IMstarve${String(i).padStart(4, '0')}`,
          conversationSid: 'CHstarve',
          author: '+15550000001',
          deadlineAt: new Date(Date.parse(SENT_AT) - (backlog - i) * 1000).toISOString(),
        },
        {
          notBeforeIso: SENT_AT,
          nowIso: SENT_AT,
          expiresAt: Math.floor(Date.parse(PAST_DEADLINE) / 1000) + 86_400,
        },
      );
    }
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    const outcome = await service(log).sweepSendStaleness(PAST_DEADLINE);

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ providerSid: stuck.providerSid }),
      'group delivery receipts silent - check Conversations service webhook config',
    );
    expect(outcome.alarmed).toBeGreaterThanOrEqual(1);
  });
});
