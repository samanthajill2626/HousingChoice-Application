// The harness FAKE's retry-send-window fields, pinned (spec section 4,
// "Repository and test doubles").
//
// WHY THIS FILE EXISTS. The fake `append` is an explicit field ALLOWLIST
// (twilioWebhookHarness.ts), so a field the real repo persists but the fake
// drops reads back as undefined - and a webhook or job test asserting that a
// retry "carries the chain's origin" or "follows the original send" would then
// pass VACUOUSLY through its fallback (`retry_window_start ?? provider_ts`,
// `automated ?? true`). The fake `updateDeliveryStatus` must land
// `retry_due_at` ONLY with a transition (spec D7), and the fake
// `annotateMessage` must write it for the enqueue-failure withdrawal. The real
// repo is covered against DynamoDB Local (messaging.integration.test.ts,
// messagesRepoRetryLineage.integration.test.ts); neither can see the double.
import { describe, expect, it } from 'vitest';
import { RETRY_PROMISE_WITHDRAWN_AT } from '../src/lib/retrySendWindow.js';
import { buildTsMsgId, retryChildPk, type NewMessage } from '../src/repos/messagesRepo.js';
import { createFakeWorld } from './helpers/twilioWebhookHarness.js';

const CONV = 'conv-rsw-harness';
const DUE = '2026-09-25T12:01:00.000Z';

function outbound(providerSid: string, providerTs: string): NewMessage {
  return {
    conversationId: CONV,
    providerSid,
    providerTs,
    type: 'sms',
    direction: 'outbound',
    author: 'teammate',
    body: 'hello',
    deliveryStatus: 'queued',
  };
}

describe('twilioWebhookHarness fake - retry-send-window fields', () => {
  it('append carries the four one-to-one fields - automated FALSE included', async () => {
    const world = createFakeWorld();
    const res = await world.messagesRepo.append({
      ...outbound('SMrswfake0001', '2026-09-25T12:00:00.000Z'),
      retryOf: '2026-09-25T11:58:00.000Z#SMrswfake0000',
      retryAttempt: 2,
      retryWindowStart: '2026-09-25T11:58:00.000Z',
      automated: false,
      recipientContactId: 'c-real',
    });
    const row = await world.messagesRepo.getByTsMsgId(CONV, res.tsMsgId);
    expect(row).toMatchObject({
      retry_of: '2026-09-25T11:58:00.000Z#SMrswfake0000',
      retry_attempt: 2,
      retry_window_start: '2026-09-25T11:58:00.000Z',
      recipient_contact_id: 'c-real',
    });
    // `false` must be STORED: a row without the flag is retried as automated.
    expect(row).toHaveProperty('automated', false);
  });

  it('append carries the relay window origin on a retry row', async () => {
    const world = createFakeWorld();
    const res = await world.messagesRepo.append({
      ...outbound('relayretry-deadbeefdeadbeef-2', '2026-09-25T12:02:00.000Z'),
      relayRetryOf: '2026-09-25T12:00:00.000Z#SMrswroot',
      relayRetryMemberKey: 'c-bob',
      relayRetryAttempt: 2,
      relayRetryDestDigest: 'deadbeefdeadbeef',
      relayRetryOriginDirection: 'outbound',
      relayRetryLegBody: 'Sam: hello',
      relayRetryWindowStart: '2026-09-25T12:00:03.000Z',
    });
    expect(
      (await world.messagesRepo.getByTsMsgId(CONV, res.tsMsgId))?.relay_retry_window_start,
    ).toBe('2026-09-25T12:00:03.000Z');
  });

  it('append writes none of the five when they are absent, and automated TRUE when true', async () => {
    const world = createFakeWorld();
    const plain = await world.messagesRepo.append(outbound('SMrswfake0003', '2026-09-25T12:03:00.000Z'));
    const row = await world.messagesRepo.getByTsMsgId(CONV, plain.tsMsgId);
    for (const field of [
      'retry_attempt',
      'retry_window_start',
      'automated',
      'recipient_contact_id',
      'relay_retry_window_start',
    ]) {
      expect(row).not.toHaveProperty(field);
    }
    const auto = await world.messagesRepo.append({
      ...outbound('SMrswfake0004', '2026-09-25T12:04:00.000Z'),
      automated: true,
    });
    expect(await world.messagesRepo.getByTsMsgId(CONV, auto.tsMsgId)).toHaveProperty('automated', true);
  });

  it('updateDeliveryStatus lands retry_due_at WITH a transition and a redelivery moves nothing (D7)', async () => {
    const world = createFakeWorld();
    await world.messagesRepo.append(outbound('SMrswfake0005', '2026-09-25T12:05:00.000Z'));
    expect(
      await world.messagesRepo.updateDeliveryStatus('SMrswfake0005', 'failed', '30003', { retryDueAt: DUE }),
    ).toBe(true);
    expect(await world.messagesRepo.getByProviderSid('SMrswfake0005')).toMatchObject({
      delivery_status: 'failed',
      error_code: '30003',
      retry_due_at: DUE,
    });
    // A redelivered callback transitions nothing and must not move the promise.
    expect(
      await world.messagesRepo.updateDeliveryStatus('SMrswfake0005', 'failed', '30003', {
        retryDueAt: '2026-09-25T12:09:00.000Z',
      }),
    ).toBe(false);
    expect((await world.messagesRepo.getByProviderSid('SMrswfake0005'))?.retry_due_at).toBe(DUE);
  });

  it('a REGRESSING failure writes no retry_due_at (D7)', async () => {
    const world = createFakeWorld();
    await world.messagesRepo.append(outbound('SMrswfake0006', '2026-09-25T12:06:00.000Z'));
    expect(await world.messagesRepo.updateDeliveryStatus('SMrswfake0006', 'delivered')).toBe(true);
    expect(
      await world.messagesRepo.updateDeliveryStatus('SMrswfake0006', 'undelivered', '30003', { retryDueAt: DUE }),
    ).toBe(false);
    const row = await world.messagesRepo.getByProviderSid('SMrswfake0006');
    expect(row?.delivery_status).toBe('delivered');
    expect(row).not.toHaveProperty('retry_due_at');
  });

  it('annotateMessage re-writes retry_due_at - the enqueue-failure withdrawal (D7)', async () => {
    const world = createFakeWorld();
    const res = await world.messagesRepo.append(outbound('SMrswfake0007', '2026-09-25T12:07:00.000Z'));
    await world.messagesRepo.updateDeliveryStatus('SMrswfake0007', 'failed', '30003', { retryDueAt: DUE });
    await world.messagesRepo.annotateMessage(CONV, res.tsMsgId, { retryDueAt: RETRY_PROMISE_WITHDRAWN_AT });
    expect(await world.messagesRepo.getByProviderSid('SMrswfake0007')).toMatchObject({
      retry_due_at: RETRY_PROMISE_WITHDRAWN_AT,
      delivery_status: 'failed',
    });
  });
});

// retry-send-adoption (R3, R5, R7): the same vacuous-pass risk for this
// branch's fields. The fake must carry retry_root through its allowlist, write
// the retrychild# pointer ONLY where the real append does (a row with retryOf,
// never on a dedupe), answer the pointer read in the real Query's sort-key
// order, and hold annotateRetryPromise to the real condition. The real repo's
// twin is messagesRepoRetryLineage.integration.test.ts; the two are held to
// each other step by step in twilioWebhookHarnessRepoAdditions.integration.test.ts.
describe('twilioWebhookHarness fake - retry-send-adoption fields', () => {
  const T0 = '2026-09-27T12:00:00.000Z';
  const T1 = '2026-09-27T12:01:00.000Z';
  const T2 = '2026-09-27T12:02:30.000Z';
  const DUE_1 = '2026-09-27T12:02:00.000Z';
  const DUE_2 = '2026-09-27T12:03:00.000Z';

  it('append carries retry_root beside retry_of, and never writes retry_outcome', async () => {
    const world = createFakeWorld();
    const parent = await world.messagesRepo.append(outbound('SMrsa0001', T0));
    const child = await world.messagesRepo.append({
      ...outbound('SMrsa0002', T1),
      retryOf: parent.tsMsgId,
      retryAttempt: 1,
      retryRoot: parent.tsMsgId,
      // Not a NewMessage field: an allowlist that copied unknown keys would store it.
      ...({ retryOutcome: 'unconfirmed' } as object),
    });
    const row = await world.messagesRepo.getByTsMsgId(CONV, child.tsMsgId);
    expect(row).toMatchObject({ retry_of: parent.tsMsgId, retry_attempt: 1, retry_root: parent.tsMsgId });
    expect(row).not.toHaveProperty('retry_outcome');
    expect(await world.messagesRepo.getByTsMsgId(CONV, parent.tsMsgId)).not.toHaveProperty('retry_root');
  });

  it('append writes the retrychild# pointer for a row with retryOf - with retryAttempt when automatic - and none otherwise', async () => {
    const world = createFakeWorld();
    const parent = await world.messagesRepo.append(outbound('SMrsa0011', T0));
    const auto = await world.messagesRepo.append({
      ...outbound('SMrsa0012', T1),
      retryOf: parent.tsMsgId,
      retryAttempt: 1,
      retryRoot: parent.tsMsgId,
    });
    const manual = await world.messagesRepo.append({
      ...outbound('SMrsa0013', T2),
      retryOf: parent.tsMsgId,
      retryRoot: parent.tsMsgId,
    });
    expect(await world.messagesRepo.listRetryChildrenConsistent(CONV, parent.tsMsgId)).toStrictEqual([
      { tsMsgId: auto.tsMsgId, providerSid: 'SMrsa0012', retryAttempt: 1 },
      { tsMsgId: manual.tsMsgId, providerSid: 'SMrsa0013' },
    ]);
    expect(await world.messagesRepo.listRetryChildrenConsistent(CONV, auto.tsMsgId)).toStrictEqual([]);
    // The map holds exactly the one partition the parent's children wrote.
    expect([...world.retryChildren.keys()]).toStrictEqual([retryChildPk(CONV, parent.tsMsgId)]);
  });

  it('a deduped append writes no second pointer, even under another provider timestamp', async () => {
    const world = createFakeWorld();
    const parent = await world.messagesRepo.append(outbound('SMrsa0021', T0));
    const lineage = { retryOf: parent.tsMsgId, retryAttempt: 1, retryRoot: parent.tsMsgId };
    const first = await world.messagesRepo.append({ ...outbound('SMrsa0022', T1), ...lineage });
    const again = await world.messagesRepo.append({ ...outbound('SMrsa0022', T2), ...lineage });
    expect(again).toStrictEqual({ deduped: true, tsMsgId: first.tsMsgId, conversationId: CONV });
    expect(await world.messagesRepo.listRetryChildrenConsistent(CONV, parent.tsMsgId)).toStrictEqual([
      { tsMsgId: first.tsMsgId, providerSid: 'SMrsa0022', retryAttempt: 1 },
    ]);
  });

  it('answers in sort-key (tsMsgId) order whatever the append order, and as a copy', async () => {
    const world = createFakeWorld();
    const parent = await world.messagesRepo.append(outbound('SMrsa0031', T0));
    const later = await world.messagesRepo.append({
      ...outbound('SMrsa0032', T2),
      retryOf: parent.tsMsgId,
      retryAttempt: 1,
    });
    const earlier = await world.messagesRepo.append({ ...outbound('SMrsa0033', T1), retryOf: parent.tsMsgId });
    const answer = await world.messagesRepo.listRetryChildrenConsistent(CONV, parent.tsMsgId);
    expect(answer).toStrictEqual([
      { tsMsgId: earlier.tsMsgId, providerSid: 'SMrsa0033' },
      { tsMsgId: later.tsMsgId, providerSid: 'SMrsa0032', retryAttempt: 1 },
    ]);
    // Scribbling on the answer changes nothing stored (the real repo answers a fresh read).
    answer.pop();
    answer[0]!.providerSid = 'SMscribbled';
    expect(await world.messagesRepo.listRetryChildrenConsistent(CONV, parent.tsMsgId)).toHaveLength(2);
    expect((await world.messagesRepo.listRetryChildrenConsistent(CONV, parent.tsMsgId))[0]?.providerSid).toBe(
      'SMrsa0033',
    );
  });

  it('a row pushed straight into world.messages has no pointer - only append writes one, as in production', async () => {
    const world = createFakeWorld();
    const parent = await world.messagesRepo.append(outbound('SMrsa0041', T0));
    world.messages.push({
      conversationId: CONV,
      tsMsgId: buildTsMsgId(T1, 'SMrsa0042'),
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      provider_sid: 'SMrsa0042',
      provider_ts: T1,
      delivery_status: 'sent',
      created_at: T1,
      retry_of: parent.tsMsgId,
      retry_attempt: 1,
    });
    expect(await world.messagesRepo.listRetryChildrenConsistent(CONV, parent.tsMsgId)).toStrictEqual([]);
  });

  it('annotateRetryPromise mirrors the real condition: the four shapes, a stale expectation, a missing row', async () => {
    const world = createFakeWorld();
    const row = await world.messagesRepo.append(outbound('SMrsa0051', T0));
    const repo = world.messagesRepo;
    const stored = async () => repo.getByTsMsgId(CONV, row.tsMsgId);
    // absent -> absent expected: written
    expect(await repo.annotateRetryPromise(CONV, row.tsMsgId, { retryDueAt: DUE_1 }, { retryDueAt: undefined })).toBe(true);
    // stale expectations lose and write nothing
    expect(await repo.annotateRetryPromise(CONV, row.tsMsgId, { retryDueAt: DUE_2 }, { retryDueAt: undefined })).toBe(false);
    expect(await repo.annotateRetryPromise(CONV, row.tsMsgId, { retryDueAt: DUE_2 }, { retryDueAt: 'wrong' })).toBe(false);
    expect((await stored())?.retry_due_at).toBe(DUE_1);
    // the current value wins
    expect(await repo.annotateRetryPromise(CONV, row.tsMsgId, { retryDueAt: DUE_2 }, { retryDueAt: DUE_1 })).toBe(true);
    // WITHDRAW writes both fields in one call
    expect(
      await repo.annotateRetryPromise(
        CONV,
        row.tsMsgId,
        { retryDueAt: RETRY_PROMISE_WITHDRAWN_AT, retryOutcome: 'unconfirmed' },
        { retryDueAt: DUE_2 },
      ),
    ).toBe(true);
    expect(await stored()).toMatchObject({ retry_due_at: RETRY_PROMISE_WITHDRAWN_AT, retry_outcome: 'unconfirmed' });
    // a missing row is false, not a throw
    expect(await repo.annotateRetryPromise(CONV, 'nope#SMnope', { retryDueAt: DUE_1 }, { retryDueAt: undefined })).toBe(
      false,
    );
  });

  it('annotateRetryPromise withdraws a row that never held a promise; a stale withdraw writes neither field', async () => {
    const world = createFakeWorld();
    const row = await world.messagesRepo.append(outbound('SMrsa0061', T0));
    const withdraw = { retryDueAt: RETRY_PROMISE_WITHDRAWN_AT, retryOutcome: 'unconfirmed' as const };
    expect(await world.messagesRepo.annotateRetryPromise(CONV, row.tsMsgId, withdraw, { retryDueAt: DUE_1 })).toBe(false);
    const untouched = await world.messagesRepo.getByTsMsgId(CONV, row.tsMsgId);
    expect(untouched).not.toHaveProperty('retry_due_at');
    expect(untouched).not.toHaveProperty('retry_outcome');
    expect(await world.messagesRepo.annotateRetryPromise(CONV, row.tsMsgId, withdraw, { retryDueAt: undefined })).toBe(
      true,
    );
    expect(await world.messagesRepo.getByTsMsgId(CONV, row.tsMsgId)).toMatchObject({
      retry_due_at: RETRY_PROMISE_WITHDRAWN_AT,
      retry_outcome: 'unconfirmed',
    });
  });
});
