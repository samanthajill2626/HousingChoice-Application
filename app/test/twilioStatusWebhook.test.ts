// M1.1 golden suite — POST /webhooks/twilio/status (delivery callbacks) and
// the messaging.retrySend job. Real signed posts (HMAC via the twilio
// package); in-memory fakes; the jobs gates run for real against the
// InMemorySchedulerAdapter (envelope machinery, never raw scheduler calls).
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemorySchedulerAdapter } from '../src/adapters/scheduler.js';
import {
  _resetForTests,
  configureJobsLogger,
  configureScheduler,
  dispatchJob,
  enqueue,
} from '../src/jobs/jobs.js';
import {
  MAX_SEND_RETRY_ATTEMPTS,
  parseRetrySendPayload,
  registerRetrySendJobHandler,
  RETRY_SEND_JOB,
  retryBackoffMs,
} from '../src/jobs/retrySend.js';
import { createLogger } from '../src/lib/logger.js';
import type { MessageItem } from '../src/repos/messagesRepo.js';
import { buildTsMsgId } from '../src/repos/messagesRepo.js';
import { createSendMessageService } from '../src/services/sendMessage.js';
import { loadConfig } from '../src/lib/config.js';
import { createLogCapture } from './helpers/logCapture.js';
import {
  createFakeWorld,
  makeWebhookHarness,
  ORIGIN_SECRET,
  signedTwilioPost,
  statusParams,
  TENANT_PHONE,
  type FakeWorld,
} from './helpers/twilioWebhookHarness.js';

const WARN = 40;
const ERROR = 50;
const STATUS_PATH = '/webhooks/twilio/status';

/** Seed one outbound message (the thing callbacks are about) into the world. */
async function seedOutbound(
  world: FakeWorld,
  sid: string,
  overrides: Partial<MessageItem> = {},
): Promise<MessageItem> {
  const conversation = await world.conversationsRepo.createOrGetByParticipantPhone(
    TENANT_PHONE,
    'tenant_1to1',
  );
  const providerTs = '2026-06-12T10:00:00.000Z';
  await world.messagesRepo.append({
    conversationId: conversation.conversationId,
    providerSid: sid,
    providerTs,
    type: 'sms',
    direction: 'outbound',
    author: 'teammate',
    body: 'outbound body',
    deliveryStatus: 'queued',
  });
  const item = (await world.messagesRepo.getByProviderSid(sid))!;
  Object.assign(item, overrides);
  return item;
}

describe('POST /webhooks/twilio/status — transitions', () => {
  let scheduler: InMemorySchedulerAdapter;

  beforeEach(() => {
    scheduler = new InMemorySchedulerAdapter();
    configureScheduler(scheduler);
    configureJobsLogger(createLogger({ destination: createLogCapture().stream }));
  });
  afterEach(() => {
    _resetForTests();
  });

  it('walks queued → sent → delivered; out-of-order callbacks never regress', async () => {
    const { app, world } = makeWebhookHarness();
    await seedOutbound(world, 'SMout0001');

    expect((await signedTwilioPost(app, STATUS_PATH, statusParams({ MessageStatus: 'sent' }))).status).toBe(200);
    expect((await signedTwilioPost(app, STATUS_PATH, statusParams({ MessageStatus: 'delivered' }))).status).toBe(200);
    // late/duplicate 'sent' arrives AFTER 'delivered' — must not regress
    expect((await signedTwilioPost(app, STATUS_PATH, statusParams({ MessageStatus: 'sent' }))).status).toBe(200);

    const message = await world.messagesRepo.getByProviderSid('SMout0001');
    expect(message?.delivery_status).toBe('delivered');
  });

  it('unknown SID that appears WITHIN the retry window (send/append race) is processed normally', async () => {
    // Shrunken window for tests; production default is 2500ms.
    const { app, world } = makeWebhookHarness({ statusUnknownSidRetryDelayMs: 120 });

    // The callback arrives BEFORE the send wrapper's append commits…
    const [res] = await Promise.all([
      signedTwilioPost(app, STATUS_PATH, statusParams({ MessageSid: 'SMlate', MessageStatus: 'sent' })),
      (async () => {
        await delay(30); // …and the append lands inside the retry window.
        await seedOutbound(world, 'SMlate');
      })(),
    ]);

    expect(res.status).toBe(200);
    expect((await world.messagesRepo.getByProviderSid('SMlate'))?.delivery_status).toBe('sent');
  });

  it('PERSISTENT unknown SID → one retried lookup, then ERROR (level 50, alarmed) + 200 ack, never a 500', async () => {
    const { app, capture } = makeWebhookHarness({ statusUnknownSidRetryDelayMs: 10 });
    const res = await signedTwilioPost(
      app,
      STATUS_PATH,
      statusParams({ MessageSid: 'SMghost', MessageStatus: 'delivered' }),
    );
    expect(res.status).toBe(200);
    // ERROR on purpose: a status we cannot attach is a silently-lost delivery
    // outcome — this line feeds the hc-<env>-error-logs alarm (§7.1 backstop).
    const err = capture.atLevel(ERROR).find((l) => String(l['msg']).includes('unknown provider SID'))!;
    expect(err).toBeDefined();
    expect(err['providerSid']).toBe('SMghost');
    expect(err['providerStatus']).toBe('delivered');
    expect(typeof err['correlationId']).toBe('string');
  });

  it('recovers conversation context by SID lookup — processing logs carry the conversationId (doc §9)', async () => {
    const { app, world, capture } = makeWebhookHarness();
    const seeded = await seedOutbound(world, 'SMout0001');

    await signedTwilioPost(app, STATUS_PATH, statusParams({ MessageStatus: 'sent' }));

    const line = capture.lines.find((l) => l['msg'] === 'twilio delivery status callback processed')!;
    expect(line['conversationId']).toBe(seeded.conversationId);
  });

  it('rejects a tampered signature with 403 and updates nothing', async () => {
    const { app, world } = makeWebhookHarness();
    await seedOutbound(world, 'SMout0001');
    const res = await signedTwilioPost(app, STATUS_PATH, statusParams({ MessageStatus: 'delivered' }), {
      tamper: true,
    });
    expect(res.status).toBe(403);
    expect((await world.messagesRepo.getByProviderSid('SMout0001'))?.delivery_status).toBe('queued');
  });

  describe('error-class handling (doc §7.1)', () => {
    it('30003 (transient) enqueues EXACTLY ONE backed-off retry job through jobs.enqueue()', async () => {
      const { app, world } = makeWebhookHarness();
      const seeded = await seedOutbound(world, 'SMout0001');
      const before = Date.now();

      const res = await signedTwilioPost(
        app,
        STATUS_PATH,
        statusParams({ MessageStatus: 'undelivered', ErrorCode: '30003' }),
      );
      expect(res.status).toBe(200);

      expect(scheduler.scheduled).toHaveLength(1);
      const { envelope, runAt } = scheduler.scheduled[0]!;
      expect(envelope.jobName).toBe(RETRY_SEND_JOB);
      expect(envelope.payload).toEqual({
        providerSid: 'SMout0001',
        conversationId: seeded.conversationId,
        attempt: 1,
      });
      // context envelope: the recovered conversationId rides the job
      expect(envelope.correlationContext.conversationId).toBe(seeded.conversationId);
      // backed off ~60s for attempt 1
      expect(runAt!.getTime()).toBeGreaterThanOrEqual(before + retryBackoffMs(1) - 1000);
      expect(runAt!.getTime()).toBeLessThanOrEqual(Date.now() + retryBackoffMs(1) + 1000);
      // the payload never carries the message body (PII rides the DB, not the wire)
      expect(JSON.stringify(envelope.payload)).not.toContain('outbound body');
    });

    it('a REDELIVERED 30003 callback does not enqueue a second retry (transition no-op gates side effects)', async () => {
      const { app, world } = makeWebhookHarness();
      await seedOutbound(world, 'SMout0001');
      const params = statusParams({ MessageStatus: 'undelivered', ErrorCode: '30003' });

      await signedTwilioPost(app, STATUS_PATH, params);
      await signedTwilioPost(app, STATUS_PATH, params); // Twilio redelivery

      expect(scheduler.scheduled).toHaveLength(1);
    });

    it('30003 past the attempt cap WARNs and does NOT enqueue', async () => {
      const { app, world, capture } = makeWebhookHarness();
      await seedOutbound(world, 'SMretry3', { retry_attempt: MAX_SEND_RETRY_ATTEMPTS });

      await signedTwilioPost(
        app,
        STATUS_PATH,
        statusParams({ MessageSid: 'SMretry3', MessageStatus: 'undelivered', ErrorCode: '30003' }),
      );

      expect(scheduler.scheduled).toHaveLength(0);
      const warn = capture.atLevel(WARN).find((l) => String(l['msg']).includes('retry cap reached'));
      expect(warn).toBeDefined();
    });

    it('30005 (invalid number) flags the CONTACT sms_unreachable and never retries', async () => {
      const { app, world } = makeWebhookHarness();
      world.contacts.push({ contactId: 'contact-T', type: 'tenant', phone: TENANT_PHONE });
      await seedOutbound(world, 'SMout0001');

      await signedTwilioPost(app, STATUS_PATH, statusParams({ MessageStatus: 'failed', ErrorCode: '30005' }));

      expect(world.flagWrites).toEqual([{ contactId: 'contact-T', flag: 'sms_unreachable', value: true }]);
      expect(scheduler.scheduled).toHaveLength(0);
    });

    it('30006 (landline) does the same', async () => {
      const { app, world } = makeWebhookHarness();
      world.contacts.push({ contactId: 'contact-T', type: 'tenant', phone: TENANT_PHONE });
      await seedOutbound(world, 'SMout0001');

      await signedTwilioPost(app, STATUS_PATH, statusParams({ MessageStatus: 'undelivered', ErrorCode: '30006' }));

      expect(world.flagWrites).toEqual([{ contactId: 'contact-T', flag: 'sms_unreachable', value: true }]);
      expect(scheduler.scheduled).toHaveLength(0);
    });

    it('30007 (carrier filtering) ERROR-logs with correlation and never retries', async () => {
      const { app, world, capture } = makeWebhookHarness();
      const seeded = await seedOutbound(world, 'SMout0001');

      await signedTwilioPost(app, STATUS_PATH, statusParams({ MessageStatus: 'undelivered', ErrorCode: '30007' }));

      const err = capture.atLevel(ERROR).find((l) => String(l['msg']).includes('carrier filtering'))!;
      expect(err).toBeDefined();
      expect(err['conversationId']).toBe(seeded.conversationId);
      expect(typeof err['correlationId']).toBe('string');
      expect(scheduler.scheduled).toHaveLength(0);
      expect(world.flagWrites).toHaveLength(0);
    });

    it('21610 (opt-out suppression) sets sms_opt_out + audit event and never retries', async () => {
      const { app, world } = makeWebhookHarness();
      world.contacts.push({ contactId: 'contact-T', type: 'tenant', phone: TENANT_PHONE });
      await seedOutbound(world, 'SMout0001');

      await signedTwilioPost(app, STATUS_PATH, statusParams({ MessageStatus: 'failed', ErrorCode: '21610' }));

      expect(world.flagWrites).toEqual([{ contactId: 'contact-T', flag: 'sms_opt_out', value: true }]);
      expect(world.auditEvents).toEqual([
        expect.objectContaining({ entityKey: 'contacts#contact-T', eventType: 'sms_opt_out_recorded' }),
      ]);
      expect(scheduler.scheduled).toHaveLength(0);
    });

    it('the error code is recorded on the message item either way', async () => {
      const { app, world } = makeWebhookHarness();
      await seedOutbound(world, 'SMout0001');
      await signedTwilioPost(app, STATUS_PATH, statusParams({ MessageStatus: 'undelivered', ErrorCode: '30007' }));
      expect((await world.messagesRepo.getByProviderSid('SMout0001'))?.error_code).toBe('30007');
    });
  });
});

describe('messaging.retrySend job (worker side)', () => {
  afterEach(() => {
    _resetForTests();
  });

  it('payload parsing rejects malformed payloads and the attempt cap', () => {
    expect(() => parseRetrySendPayload(null)).toThrow(/not an object/);
    expect(() => parseRetrySendPayload({ conversationId: 'c', attempt: 1 })).toThrow(/providerSid/);
    expect(() => parseRetrySendPayload({ providerSid: 's', attempt: 1 })).toThrow(/conversationId/);
    expect(() => parseRetrySendPayload({ providerSid: 's', conversationId: 'c', attempt: 0 })).toThrow(/attempt/);
    expect(() =>
      parseRetrySendPayload({ providerSid: 's', conversationId: 'c', attempt: MAX_SEND_RETRY_ATTEMPTS + 1 }),
    ).toThrow(/cap/);
  });

  it('backoff doubles per attempt (60s, 120s, 240s)', () => {
    expect(retryBackoffMs(1)).toBe(60_000);
    expect(retryBackoffMs(2)).toBe(120_000);
    expect(retryBackoffMs(3)).toBe(240_000);
  });

  it('END TO END: a 30003 callback schedules a job whose handler re-sends via the service (automated) and records retry lineage', async () => {
    const scheduler = new InMemorySchedulerAdapter();
    configureScheduler(scheduler);
    const capture = createLogCapture();
    const logger = createLogger({ destination: capture.stream });
    configureJobsLogger(logger);

    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });
    const seeded = await seedOutbound(world, 'SMout0001');

    // 1) the failure callback enqueues the retry
    await signedTwilioPost(app, STATUS_PATH, statusParams({ MessageStatus: 'undelivered', ErrorCode: '30003' }));
    expect(scheduler.scheduled).toHaveLength(1);

    // 2) the worker-side handler, wired to the SAME fakes through the real
    // send service (breaker-metered automated send)
    const send = createSendMessageService({
      config: loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: ORIGIN_SECRET, MESSAGING_DRIVER: 'console' }),
      logger,
      adapter: world.adapter,
      conversationsRepo: world.conversationsRepo,
      messagesRepo: world.messagesRepo,
      contactsRepo: world.contactsRepo,
      auditRepo: world.auditRepo,
    });
    registerRetrySendJobHandler({ sendMessage: send, messagesRepo: world.messagesRepo, logger });
    await scheduler.deliverAll(dispatchJob);

    // the retry went to the provider with the SAME body, automated:true path
    expect(world.sent).toEqual([{ to: TENANT_PHONE, body: 'outbound body' }]);
    // and the NEW message records retry_of + retry_attempt
    const retried = world.messages.find((m) => m.retry_of !== undefined)!;
    expect(retried).toBeDefined();
    expect(retried.retry_of).toBe(buildTsMsgId(seeded.provider_ts, 'SMout0001'));
    expect(retried.retry_attempt).toBe(1);
    expect(retried.direction).toBe('outbound');
  });

  it('a retry carries the ORIGINAL message author through (ai stays ai)', async () => {
    const scheduler = new InMemorySchedulerAdapter();
    configureScheduler(scheduler);
    const logger = createLogger({ destination: createLogCapture().stream });
    configureJobsLogger(logger);

    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });
    await seedOutbound(world, 'SMout0001', { author: 'ai' });
    await signedTwilioPost(app, STATUS_PATH, statusParams({ MessageStatus: 'undelivered', ErrorCode: '30003' }));

    const send = createSendMessageService({
      config: loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: ORIGIN_SECRET, MESSAGING_DRIVER: 'console' }),
      logger,
      adapter: world.adapter,
      conversationsRepo: world.conversationsRepo,
      messagesRepo: world.messagesRepo,
      contactsRepo: world.contactsRepo,
      auditRepo: world.auditRepo,
    });
    registerRetrySendJobHandler({ sendMessage: send, messagesRepo: world.messagesRepo, logger });
    await scheduler.deliverAll(dispatchJob);

    const retried = world.messages.find((m) => m.retry_of !== undefined)!;
    expect(retried).toBeDefined();
    expect(retried.author).toBe('ai'); // not reset to teammate by the retry
  });

  it('a refused retry (contact opted out meanwhile) WARNs and stops the chain — no throw, no send', async () => {
    const scheduler = new InMemorySchedulerAdapter();
    configureScheduler(scheduler);
    const capture = createLogCapture();
    const logger = createLogger({ destination: capture.stream });
    configureJobsLogger(logger);

    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });
    await seedOutbound(world, 'SMout0001');
    await signedTwilioPost(app, STATUS_PATH, statusParams({ MessageStatus: 'undelivered', ErrorCode: '30003' }));

    // contact opts out between the failure and the retry firing
    world.contacts.push({ contactId: 'contact-T', type: 'tenant', phone: TENANT_PHONE, sms_opt_out: true });

    const send = createSendMessageService({
      config: loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: ORIGIN_SECRET, MESSAGING_DRIVER: 'console' }),
      logger,
      adapter: world.adapter,
      conversationsRepo: world.conversationsRepo,
      messagesRepo: world.messagesRepo,
      contactsRepo: world.contactsRepo,
      auditRepo: world.auditRepo,
    });
    registerRetrySendJobHandler({ sendMessage: send, messagesRepo: world.messagesRepo, logger });
    await scheduler.deliverAll(dispatchJob);

    expect(world.sent).toHaveLength(0);
    const warn = capture.atLevel(WARN).find((l) => String(l['msg']).includes('send refused'));
    expect(warn).toBeDefined();
  });

  it('a missing original message WARNs and does nothing', async () => {
    const scheduler = new InMemorySchedulerAdapter();
    configureScheduler(scheduler);
    const capture = createLogCapture();
    const logger = createLogger({ destination: capture.stream });
    configureJobsLogger(logger);

    const world = createFakeWorld();
    registerRetrySendJobHandler({
      sendMessage: async () => {
        throw new Error('must not be called');
      },
      messagesRepo: world.messagesRepo,
      logger,
    });

    await enqueue(RETRY_SEND_JOB, { providerSid: 'SMnope', conversationId: 'conv-x', attempt: 1 });
    await scheduler.deliverAll(dispatchJob);

    const warn = capture.atLevel(WARN).find((l) => String(l['msg']).includes('original message not found'));
    expect(warn).toBeDefined();
  });
});
