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
import type { NewMessage } from '../src/repos/messagesRepo.js';
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
