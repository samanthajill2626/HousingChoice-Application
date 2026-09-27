// The group send's WIRE behaviour, against DynamoDB Local (build slice S5).
//
// These three things exist only in the request DynamoDB actually receives, so
// no in-memory fake can prove them:
//   1. ONE transaction carries the message row, its sid pointer AND the
//      staleness due row - all or nothing. Delete the fourth Put and this suite
//      is what goes red; the groupSend unit matrix would still pass, because it
//      asserts the intent, not the write.
//   2. Due-discovery is a deadline-prefixed range QUERY on a synthetic
//      partition. The messages table has ZERO GSIs in every environment, so a
//      scan is the only alternative and it must never be the answer.
//   3. A redelivered send (same provider SID) cancels that whole transaction and
//      must report a DEDUPE, not a due-row failure.
//
// Self-skipping like the other integration suites: with nothing answering at
// DYNAMODB_ENDPOINT the suite is skipped so `npm test` stays green without
// Docker (`npm run db:start` to exercise it).
import { randomUUID } from 'node:crypto';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { createLogger } from '../src/lib/logger.js';
import { getTableSpec } from '../src/lib/tables.js';
import {
  buildGroupSendDueRow,
  createMessagesRepo,
  GROUP_SEND_DUE_PARTITION,
  GROUP_SEND_DUE_KIND,
  type DeliveryStatus,
} from '../src/repos/messagesRepo.js';
import { createLogCapture } from './helpers/logCapture.js';

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
    `[groupSendRepo.integration] SKIPPED - no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

describe.skipIf(!reachable)('group send persistence against DynamoDB Local', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const messages = createMessagesRepo({ doc, env: testEnv, logger });
  const table = tableName('messages', testEnv);

  let seq = 0;
  const nextSid = (): string => `IM${++seq}${randomUUID().replace(/-/g, '').slice(0, 20)}`;

  async function appendGroupSend(opts: {
    conversationId: string;
    providerSid: string;
    providerTs: string;
    deadlineAt: string;
  }): Promise<{ deduped: boolean; tsMsgId: string }> {
    const tsMsgId = `${opts.providerTs}#${opts.providerSid}`;
    return messages.append({
      conversationId: opts.conversationId,
      providerSid: opts.providerSid,
      providerTs: opts.providerTs,
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      body: 'group reply',
      deliveryStatus: 'queued',
      transportSchemaVersion: 1,
      requestedTransport: 'mms',
      actualTransport: 'mms',
      deliveryRecipients: {
        'phone#+16175550111': {
          status: 'queued',
          requestedTransport: 'mms',
          actualTransport: 'mms',
          transportAggregationState: 'attempted',
        },
        'phone#+16175550222': {
          status: 'queued',
          requestedTransport: 'mms',
          actualTransport: 'mms',
          transportAggregationState: 'attempted',
        },
      },
      groupRailSnapshot: {
        conversationSid: 'CHrail1',
        participantMap: { MBann: 'phone#+16175550111', MBmarcus: 'phone#+16175550222' },
      },
      dueRow: buildGroupSendDueRow({
        conversationId: opts.conversationId,
        tsMsgId,
        providerSid: opts.providerSid,
        deadlineAt: opts.deadlineAt,
        expiresAt: Math.floor(Date.parse(opts.deadlineAt) / 1000) + 30 * 24 * 60 * 60,
      }),
    });
  }

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('messages'), table);
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, table);
    doc.destroy();
    client.destroy();
  }, 120_000);

  it('writes the message row, the seeded parent map, the rail snapshot AND the due row in one transaction', async () => {
    const conversationId = `group-${randomUUID().slice(0, 8)}`;
    const providerSid = nextSid();
    const providerTs = '2026-08-11T13:00:00.500Z';
    const deadlineAt = '2026-08-11T13:10:00.500Z';

    const appended = await appendGroupSend({ conversationId, providerSid, providerTs, deadlineAt });
    expect(appended.deduped).toBe(false);

    const stored = await messages.getByProviderSid(providerSid);
    expect(stored?.delivery_recipients).toEqual({
      'phone#+16175550111': {
        status: 'queued',
        requestedTransport: 'mms',
        actualTransport: 'mms',
        transportAggregationState: 'attempted',
      },
      'phone#+16175550222': {
        status: 'queued',
        requestedTransport: 'mms',
        actualTransport: 'mms',
        transportAggregationState: 'attempted',
      },
    });
    expect(stored).toMatchObject({
      type: 'sms',
      transport_schema_version: 1,
      requested_transport: 'mms',
      actual_transport: 'mms',
    });
    expect(stored?.group_conversation_sid).toBe('CHrail1');
    expect(stored?.group_participant_map).toEqual({
      MBann: 'phone#+16175550111',
      MBmarcus: 'phone#+16175550222',
    });

    const { Item: due } = await doc.send(
      new GetCommand({
        TableName: table,
        Key: {
          conversationId: GROUP_SEND_DUE_PARTITION,
          tsMsgId: `${deadlineAt}#${GROUP_SEND_DUE_KIND}#${providerSid}`,
        },
      }),
    );
    expect(due).toMatchObject({
      due_kind: GROUP_SEND_DUE_KIND,
      deadline_at: deadlineAt,
      ref_conversationId: conversationId,
      ref_tsMsgId: appended.tsMsgId,
      provider_sid: providerSid,
    });
  });

  it('finds overdue rows by a deadline range Query, oldest first, and never the not-yet-due ones', async () => {
    const conversationId = `group-${randomUUID().slice(0, 8)}`;
    const early = nextSid();
    const late = nextSid();
    const future = nextSid();
    await appendGroupSend({
      conversationId,
      providerSid: early,
      providerTs: '2026-09-01T10:00:00.000Z',
      deadlineAt: '2026-09-01T10:10:00.000Z',
    });
    await appendGroupSend({
      conversationId,
      providerSid: late,
      providerTs: '2026-09-01T10:05:00.000Z',
      deadlineAt: '2026-09-01T10:15:00.000Z',
    });
    await appendGroupSend({
      conversationId,
      providerSid: future,
      providerTs: '2026-09-01T23:00:00.000Z',
      deadlineAt: '2026-09-01T23:10:00.000Z',
    });

    const dueNow = await messages.listDueRows(GROUP_SEND_DUE_PARTITION, '2026-09-01T10:20:00.000Z');
    const mine = dueNow.filter((r) => r.ref.conversationId === conversationId);
    expect(mine.map((r) => r.providerSid)).toEqual([early, late]);
    expect(mine[0]?.kind).toBe(GROUP_SEND_DUE_KIND);
    expect(mine[0]?.deadlineAt).toBe('2026-09-01T10:10:00.000Z');

    // A row due at EXACTLY the sweep instant is included (the '~' upper bound).
    const atDeadline = await messages.listDueRows(GROUP_SEND_DUE_PARTITION, '2026-09-01T10:10:00.000Z');
    expect(atDeadline.some((r) => r.providerSid === early)).toBe(true);
    expect(atDeadline.some((r) => r.providerSid === late)).toBe(false);
  });

  it('deletes a resolved due row, idempotently', async () => {
    const conversationId = `group-${randomUUID().slice(0, 8)}`;
    const providerSid = nextSid();
    const deadlineAt = '2026-09-02T10:10:00.000Z';
    await appendGroupSend({
      conversationId,
      providerSid,
      providerTs: '2026-09-02T10:00:00.000Z',
      deadlineAt,
    });
    const sortKey = `${deadlineAt}#${GROUP_SEND_DUE_KIND}#${providerSid}`;

    await messages.deleteDueRow(GROUP_SEND_DUE_PARTITION, sortKey);
    await messages.deleteDueRow(GROUP_SEND_DUE_PARTITION, sortKey);

    const remaining = await messages.listDueRows(GROUP_SEND_DUE_PARTITION, '2026-09-02T23:00:00.000Z');
    expect(remaining.some((r) => r.providerSid === providerSid)).toBe(false);
  });

  it('reports a redelivered send as a DEDUPE, not as a due-row collision', async () => {
    const conversationId = `group-${randomUUID().slice(0, 8)}`;
    const providerSid = nextSid();
    const providerTs = '2026-09-03T10:00:00.000Z';
    const deadlineAt = '2026-09-03T10:10:00.000Z';

    const first = await appendGroupSend({ conversationId, providerSid, providerTs, deadlineAt });
    const second = await appendGroupSend({ conversationId, providerSid, providerTs, deadlineAt });

    expect(first.deduped).toBe(false);
    expect(second).toEqual({ deduped: true, tsMsgId: first.tsMsgId });
  });

  // The whole reason updateRecipientDeliveryStatus stopped rebuilding the slot:
  // it read the slot, then SET the entire map entry from that value, so any
  // targeted field written between the Get and the Update vanished. The group
  // receipts path does exactly that - the status transition for one leg and the
  // sid-if-absent write for a duplicate receipt overlap constantly.
  //
  // Reproducing a lost update is inherently racy, so this fires eight
  // independent pairs concurrently. Under the old whole-slot replace the sid is
  // lost whenever the sid write lands inside the read-modify-write window;
  // under child-field writes both ALWAYS survive, which is what makes this a
  // stable regression pin rather than a flake.
  it('a concurrent sid write and status transition on the SAME member both survive', async () => {
    const conversationId = `group-${randomUUID().slice(0, 8)}`;
    const memberKey = 'phone#+16175550111';
    const rounds = 8;
    const sids: string[] = [];

    for (let i = 0; i < rounds; i += 1) {
      const providerSid = nextSid();
      sids.push(providerSid);
      await messages.append({
        conversationId,
        providerSid,
        providerTs: `2026-09-05T10:0${i}:00.000Z`,
        type: 'sms',
        direction: 'outbound',
        author: 'teammate',
        body: 'race',
        deliveryStatus: 'queued',
        deliveryRecipients: { [memberKey]: { status: 'queued' } },
      });
    }

    await Promise.all(
      sids.flatMap((providerSid, i) => {
        const tsMsgId = `2026-09-05T10:0${i}:00.000Z#${providerSid}`;
        return [
          messages.setRecipientDeliverySid(conversationId, tsMsgId, memberKey, `SM-${i}`),
          messages.updateRecipientDeliveryStatus(
            conversationId,
            tsMsgId,
            memberKey,
            'sent',
            undefined,
            { context: 'group' },
          ),
        ];
      }),
    );

    for (let i = 0; i < rounds; i += 1) {
      const stored = await messages.getByProviderSid(sids[i] as string);
      const slot = stored?.delivery_recipients?.[memberKey];
      expect(slot?.sid).toBe(`SM-${i}`);
      expect(slot?.status).toBe('sent');
    }
  });

  // THE LOST FORWARD TRANSITION (docs/issues/group-reply-live-rollup-full-suite-flake.md).
  // Two receipts for ONE member in flight together: both read the slot, the
  // first commits, then the second writes. The guard used to be "status still
  // equals what I read", so a `delivered` that read `queued` and found `sent`
  // failed its condition and was DROPPED - a legal sent -> delivered move,
  // logged "lost a race (regressed)" and never retried. The slot sat at `sent`
  // for good and the thread read `Delivered 2/3` for a message every handset
  // received. The relay path shares this method, so a 30003 `undelivered`
  // could lose to `sent` the same way and never claim its retry.
  //
  // GATED, never left to chance: whether the two in-flight windows overlap
  // depends on machine load, which is how this hid for five weeks as a
  // "full-suite flake" that passed on a quiet machine. The gates force the
  // exact order the failing e2e logs show, on every run.
  async function raceTwoTransitions(opts: {
    firstToCommit: DeliveryStatus;
    secondToCommit: DeliveryStatus;
    context?: 'group';
  }): Promise<{
    firstApplied: boolean;
    secondApplied: boolean;
    final: DeliveryStatus | undefined;
    msgs: unknown[];
  }> {
    const capture = createLogCapture();
    const log = createLogger({ level: 'info', destination: capture.stream });
    let secondReadDone!: () => void;
    const secondRead = new Promise<void>((resolve) => (secondReadDone = resolve));
    let firstCommitDone!: () => void;
    const firstCommitted = new Promise<void>((resolve) => (firstCommitDone = resolve));
    // The first writer's UPDATE waits for the second writer's READ, so both
    // read the same seeded status; the second writer's UPDATE waits for the
    // first to commit, so it writes against a slot that has already moved.
    const firstDoc = {
      send: async (cmd: GetCommand | UpdateCommand) => {
        if (!(cmd instanceof UpdateCommand)) return doc.send(cmd);
        await secondRead;
        try {
          return await doc.send(cmd);
        } finally {
          firstCommitDone();
        }
      },
    } as unknown as typeof doc;
    const secondDoc = {
      send: async (cmd: GetCommand | UpdateCommand) => {
        if (cmd instanceof UpdateCommand) await firstCommitted;
        const out = await doc.send(cmd);
        if (cmd instanceof GetCommand) secondReadDone();
        return out;
      },
    } as unknown as typeof doc;
    const first = createMessagesRepo({ doc: firstDoc, env: testEnv, logger: log });
    const second = createMessagesRepo({ doc: secondDoc, env: testEnv, logger: log });

    const conversationId = `group-${randomUUID().slice(0, 8)}`;
    const memberKey = 'phone#+16175550444';
    const providerSid = nextSid();
    const providerTs = '2026-09-27T17:01:06.224Z';
    await messages.append({
      conversationId,
      providerSid,
      providerTs,
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      body: 'race',
      deliveryStatus: 'queued',
      deliveryRecipients: { [memberKey]: { status: 'queued' } },
    });
    const tsMsgId = `${providerTs}#${providerSid}`;
    const ctx = opts.context !== undefined ? { context: opts.context } : undefined;
    const [firstApplied, secondApplied] = await Promise.all([
      first.updateRecipientDeliveryStatus(conversationId, tsMsgId, memberKey, opts.firstToCommit, undefined, ctx),
      second.updateRecipientDeliveryStatus(conversationId, tsMsgId, memberKey, opts.secondToCommit, undefined, ctx),
    ]);
    const stored = await messages.getByProviderSid(providerSid);
    return {
      firstApplied,
      secondApplied,
      final: stored?.delivery_recipients?.[memberKey]?.status,
      msgs: capture.lines.map((l) => l['msg']),
    };
  }

  it.each([
    { name: 'group delivered after sent', context: 'group' as const, second: 'delivered' as const },
    { name: 'relay delivered after sent', context: undefined, second: 'delivered' as const },
    { name: 'relay undelivered (30003) after sent', context: undefined, second: 'undelivered' as const },
  ])('a forward transition that read a stale status still lands: $name', async ({ context, second }) => {
    const result = await raceTwoTransitions({
      firstToCommit: 'sent',
      secondToCommit: second,
      ...(context !== undefined && { context }),
    });

    expect(result.firstApplied).toBe(true);
    expect(result.secondApplied).toBe(true);
    expect(result.final).toBe(second);
    expect(result.msgs.some((m) => typeof m === 'string' && m.includes('lost a race'))).toBe(false);
  });

  // ...and the fix must not buy that by letting a LATE lower status through. A
  // `sent` that read `queued` and finds `delivered` is a genuine regression.
  it('a stale lower transition that finds a terminal status is still refused', async () => {
    const result = await raceTwoTransitions({
      firstToCommit: 'delivered',
      secondToCommit: 'sent',
      context: 'group',
    });

    expect(result.firstApplied).toBe(true);
    expect(result.secondApplied).toBe(false);
    expect(result.final).toBe('delivered');
    expect(result.msgs).toContain('group recipient delivery status transition lost a race (regressed)');
  });

  it('records the channel SID only when the slot has none - a duplicate receipt never overwrites it', async () => {
    const conversationId = `group-${randomUUID().slice(0, 8)}`;
    const memberKey = 'phone#+16175550222';
    const providerSid = nextSid();
    const providerTs = '2026-09-06T10:00:00.000Z';
    await messages.append({
      conversationId,
      providerSid,
      providerTs,
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      body: 'dup',
      deliveryStatus: 'queued',
      deliveryRecipients: { [memberKey]: { status: 'queued' } },
    });
    const tsMsgId = `${providerTs}#${providerSid}`;

    expect(await messages.setRecipientDeliverySid(conversationId, tsMsgId, memberKey, 'SMfirst')).toBe(
      true,
    );
    expect(await messages.setRecipientDeliverySid(conversationId, tsMsgId, memberKey, 'SMsecond')).toBe(
      false,
    );
    const stored = await messages.getByProviderSid(providerSid);
    expect(stored?.delivery_recipients?.[memberKey]?.sid).toBe('SMfirst');
    // A slot that does not exist is a false, not a dangling-path crash.
    expect(await messages.setRecipientDeliverySid(conversationId, tsMsgId, 'phone#+1999', 'SMx')).toBe(
      false,
    );
  });

  it('leaves the relay log lines BYTE-IDENTICAL and labels only the group ones', async () => {
    const relayCapture = createLogCapture();
    const labelled = createMessagesRepo({
      doc,
      env: testEnv,
      logger: createLogger({ level: 'info', destination: relayCapture.stream }),
    });
    const conversationId = `group-${randomUUID().slice(0, 8)}`;
    const memberKey = 'phone#+16175550333';
    const providerSid = nextSid();
    const providerTs = '2026-09-07T10:00:00.000Z';
    await labelled.append({
      conversationId,
      providerSid,
      providerTs,
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      body: 'labels',
      deliveryStatus: 'queued',
      deliveryRecipients: { [memberKey]: { status: 'queued' } },
    });
    const tsMsgId = `${providerTs}#${providerSid}`;

    // RELAY (no opts): every message must read exactly as it did before S5.
    await labelled.updateRecipientDeliveryStatus(conversationId, tsMsgId, memberKey, 'delivered');
    await labelled.updateRecipientDeliveryStatus(conversationId, tsMsgId, memberKey, 'sent');
    await labelled.updateRecipientDeliveryStatus(conversationId, tsMsgId, 'phone#+1000', 'sent');
    const relayMessages = relayCapture.lines.map((l) => l['msg']);
    expect(relayMessages).toContain('relay recipient delivery updated');
    expect(relayMessages).toContain('relay recipient delivery status transition skipped (would regress)');
    expect(relayMessages).toContain('relay recipient delivery status for unknown recipient slot ignored');
    expect(relayMessages.some((m) => typeof m === 'string' && m.startsWith('group '))).toBe(false);

    // GROUP: the same events, labelled, so a group problem is greppable.
    const groupSid = nextSid();
    const groupTs = '2026-09-07T11:00:00.000Z';
    await labelled.append({
      conversationId,
      providerSid: groupSid,
      providerTs: groupTs,
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      body: 'labels',
      deliveryStatus: 'queued',
      deliveryRecipients: { [memberKey]: { status: 'queued' } },
    });
    await labelled.updateRecipientDeliveryStatus(
      conversationId,
      `${groupTs}#${groupSid}`,
      memberKey,
      'delivered',
      undefined,
      { context: 'group' },
    );
    expect(relayCapture.lines.map((l) => l['msg'])).toContain('group recipient delivery updated');
  });

  it('parks receipts per participant, coalesces forward-only, and drains by delete', async () => {
    const messageSid = nextSid();
    const expiresAt = Math.floor(Date.now() / 1000) + 24 * 60 * 60;

    expect(
      await messages.parkGroupReceipt(
        {
          messageSid,
          participantSid: 'MBann',
          status: 'delivered',
          channelMessageSid: 'SMann',
          parkedAt: '2026-09-08T10:00:00.000Z',
        },
        { rank: 2, expiresAt },
      ),
    ).toBe(true);
    // A LATER, LOWER-ranked receipt for the same slot must not win.
    expect(
      await messages.parkGroupReceipt(
        { messageSid, participantSid: 'MBann', status: 'sent', parkedAt: '2026-09-08T10:00:01.000Z' },
        { rank: 1, expiresAt },
      ),
    ).toBe(false);
    await messages.parkGroupReceipt(
      { messageSid, participantSid: 'MBmarcus', status: 'sent', parkedAt: '2026-09-08T10:00:02.000Z' },
      { rank: 1, expiresAt },
    );

    const parked = await messages.listParkedGroupReceipts(messageSid);
    expect(parked).toHaveLength(2);
    expect(parked.find((p) => p.participantSid === 'MBann')).toMatchObject({
      status: 'delivered',
      channelMessageSid: 'SMann',
    });

    await messages.deleteParkedGroupReceipt(messageSid, 'MBann');
    await messages.deleteParkedGroupReceipt(messageSid, 'MBann');
    expect(await messages.listParkedGroupReceipts(messageSid)).toHaveLength(1);
  });

  it('keeps the due partition out of a conversation listing (marker partitions never collide)', async () => {
    const conversationId = `group-${randomUUID().slice(0, 8)}`;
    await appendGroupSend({
      conversationId,
      providerSid: nextSid(),
      providerTs: '2026-09-04T10:00:00.000Z',
      deadlineAt: '2026-09-04T10:10:00.000Z',
    });
    const listed = await messages.listByConversation(conversationId);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.tsMsgId.startsWith('2026-09-04T10:00:00.000Z#')).toBe(true);
  });
});
