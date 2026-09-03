// M1.1 golden suite — POST /webhooks/twilio/status (delivery callbacks) and
// the messaging.retrySend job. Real signed posts (HMAC via the twilio
// package); in-memory fakes; the jobs gates run for real against the
// InMemorySchedulerAdapter (envelope machinery, never raw scheduler calls).
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  InMemorySchedulerAdapter,
  InProcessOutboundQueueAdapter,
} from '../src/adapters/scheduler.js';
import {
  _resetForTests,
  configureJobsLogger,
  configureOutboundQueue,
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
import type { BroadcastItem } from '../src/repos/broadcastsRepo.js';
import { createSendMessageService } from '../src/services/sendMessage.js';
import { loadConfig } from '../src/lib/config.js';
import { createLogCapture, type LogCapture } from './helpers/logCapture.js';
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
const DIRECT_RCS_SID = `SM${'6'.repeat(32)}`;

/** Seed one outbound message (the thing callbacks are about) into the world. */
async function seedOutbound(
  world: FakeWorld,
  sid: string,
  overrides: Partial<MessageItem> = {},
  participantPhone: string = TENANT_PHONE,
): Promise<MessageItem> {
  const conversation = await world.conversationsRepo.createOrGetByParticipantPhone(
    participantPhone,
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
  // The 30003 retry backoff (60/120/240s) is <=12min, so enqueue() routes it
  // through the SQS path (outbound adapter), NOT EventBridge. In tests a
  // delayed job is RECORDED in outbound.delayed[] (no real sleep, no dispatch),
  // exactly as the in-memory scheduler used to record it.
  let outbound: InProcessOutboundQueueAdapter;

  beforeEach(() => {
    // Scheduler is still wired for the long-horizon branch (unused here).
    configureScheduler(new InMemorySchedulerAdapter());
    outbound = new InProcessOutboundQueueAdapter({ dispatch: dispatchJob });
    configureOutboundQueue(outbound);
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

  it('writes actual transport and emits once even when delivery status is unchanged', async () => {
    const { app, world } = makeWebhookHarness();
    await seedOutbound(world, DIRECT_RCS_SID, {
      transport_schema_version: 1,
      requested_transport: 'rcs',
    });

    const params = statusParams({
      MessageSid: DIRECT_RCS_SID,
      MessageStatus: 'queued',
    });
    await signedTwilioPost(app, STATUS_PATH, params);

    expect((await world.messagesRepo.getByProviderSid(DIRECT_RCS_SID))?.actual_transport).toBe(
      'sms',
    );
    expect(world.emitted.filter((event) => event.event === 'message.persisted')).toHaveLength(1);

    await signedTwilioPost(app, STATUS_PATH, params);
    expect(world.emitted.filter((event) => event.event === 'message.persisted')).toHaveLength(1);
  });

  it('advances delivery status without inventing actual transport when evidence is missing', async () => {
    const { app, world } = makeWebhookHarness();
    const sid = `SM${'7'.repeat(32)}`;
    await seedOutbound(world, sid, {
      transport_schema_version: 1,
      requested_transport: 'rcs',
    });

    await signedTwilioPost(
      app,
      STATUS_PATH,
      statusParams({ MessageSid: sid, MessageStatus: 'sent', From: '' }),
    );

    expect(await world.messagesRepo.getByProviderSid(sid)).toMatchObject({
      delivery_status: 'sent',
      transport_schema_version: 1,
      requested_transport: 'rcs',
    });
    expect((await world.messagesRepo.getByProviderSid(sid))?.actual_transport).toBeUndefined();
    expect(world.emitted.filter((event) => event.event === 'message.persisted')).toHaveLength(1);
  });

  it('uses the stored request to classify identical callback evidence and preserves legacy status behavior', async () => {
    const { app, world } = makeWebhookHarness();
    const smsRequestSid = `SM${'8'.repeat(32)}`;
    const missingRequestSid = `SM${'9'.repeat(32)}`;
    const legacySid = `SM${'a'.repeat(32)}`;
    await seedOutbound(world, smsRequestSid, {
      transport_schema_version: 1,
      requested_transport: 'sms',
    });
    await seedOutbound(world, missingRequestSid, { transport_schema_version: 1 });
    await seedOutbound(world, legacySid);

    for (const sid of [smsRequestSid, missingRequestSid, legacySid]) {
      await signedTwilioPost(
        app,
        STATUS_PATH,
        statusParams({ MessageSid: sid, MessageStatus: 'sent' }),
      );
    }

    expect((await world.messagesRepo.getByProviderSid(smsRequestSid))?.actual_transport).toBe('sms');
    expect((await world.messagesRepo.getByProviderSid(missingRequestSid))?.actual_transport).toBeUndefined();
    expect(await world.messagesRepo.getByProviderSid(legacySid)).toMatchObject({
      delivery_status: 'sent',
    });
    expect((await world.messagesRepo.getByProviderSid(legacySid))?.actual_transport).toBeUndefined();
  });

  it('treats post-fallback RCS as stale and rejects non-RCS conflicts without emitting', async () => {
    const { app, world } = makeWebhookHarness();
    const staleSid = `SM${'b'.repeat(32)}`;
    const conflictSid = `SM${'c'.repeat(32)}`;
    await seedOutbound(world, staleSid, {
      transport_schema_version: 1,
      requested_transport: 'rcs',
      actual_transport: 'sms',
    });
    await seedOutbound(world, conflictSid, {
      transport_schema_version: 1,
      requested_transport: 'sms',
      actual_transport: 'sms',
    });
    const before = world.emitted.length;

    for (const sid of [staleSid, conflictSid]) {
      await signedTwilioPost(
        app,
        STATUS_PATH,
        statusParams({
          MessageSid: sid,
          MessageStatus: 'queued',
          From: 'rcs:sender-id',
          ChannelPrefix: 'rcs',
        }),
      );
    }

    expect((await world.messagesRepo.getByProviderSid(staleSid))?.actual_transport).toBe('sms');
    expect((await world.messagesRepo.getByProviderSid(conflictSid))?.actual_transport).toBe('sms');
    expect(world.emitted).toHaveLength(before);
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

  it('broadcast rollup: a delivery callback whose recipient slot is not yet written retries the load ONCE, then rolls up delivered (send/pacing race)', async () => {
    // The fan-out records the recipient slot (conversationId+tsMsgId, status
    // 'sent') a beat AFTER the provider send; a fast delivered callback can land
    // in that gap. The rollup must re-load the broadcast once before giving up.
    const { app, world } = makeWebhookHarness({ statusUnknownSidRetryDelayMs: 5 });
    const seeded = await seedOutbound(world, 'SMbcastrace', { broadcast_id: 'bcast-race' });

    const now = new Date().toISOString();
    const base: BroadcastItem = {
      broadcastId: 'bcast-race',
      created_by: 'usr_test',
      created_at: now,
      status: 'sending',
      audience_filter: { contact_type: 'tenant', excludeOptedOut: true, excludeUnreachable: true },
      body_template: 'hi',
      stats: { audience: 1, sent: 1, delivered: 0, failed: 0, skipped_opted_out: 0, skipped_no_consent: 0, queued: 0 },
      recipients: {
        'c-1': { status: 'sent', conversationId: seeded.conversationId, tsMsgId: seeded.tsMsgId },
      },
      updated_at: now,
    };
    // The COMMITTED state: the map already carries the matching 'sent' slot (so
    // the conditional setRecipient succeeds). The race is purely in the READ.
    world.broadcasts.set('bcast-race', base);

    // FIRST getById returns a STALE broadcast (slot still 'queued', no keys) —
    // the pacing gap; every later read delegates to the real (committed) repo.
    let reads = 0;
    const realGetById = world.broadcastsRepo.getById.bind(world.broadcastsRepo);
    world.broadcastsRepo.getById = async (id: string) => {
      reads += 1;
      if (id === 'bcast-race' && reads === 1) {
        return { ...base, recipients: { 'c-1': { status: 'queued' } } } satisfies BroadcastItem;
      }
      return realGetById(id);
    };

    const res = await signedTwilioPost(
      app,
      STATUS_PATH,
      statusParams({ MessageSid: 'SMbcastrace', MessageStatus: 'delivered' }),
    );
    expect(res.status).toBe(200);

    // The rollup retried the load, found the slot, and rolled up delivered.
    const bcast = world.broadcasts.get('bcast-race')!;
    expect(bcast.recipients['c-1']?.status).toBe('delivered');
    expect(bcast.stats.delivered).toBe(1);
    expect(reads).toBeGreaterThanOrEqual(2); // the retry actually happened
  });

  it("broadcast rollup: the carrier's non-terminal 'sent' stamps carrierSentAt on the slot (status/stats untouched) + emits broadcast.updated", async () => {
    // The fan-out stamps the slot 'sent' at DISPATCH (its idempotency claim), so
    // between dispatch and the carrier's sent callback the recipient row must
    // read "Sending..." like the 1:1 bubble does. The carrierSentAt marker is
    // what flips it to "Sent" - without it the two surfaces disagree.
    const { app, world } = makeWebhookHarness();
    const seeded = await seedOutbound(world, 'SMbcastsent', { broadcast_id: 'bcast-carrier' });

    const now = new Date().toISOString();
    world.broadcasts.set('bcast-carrier', {
      broadcastId: 'bcast-carrier',
      created_by: 'usr_test',
      created_at: now,
      status: 'sent',
      audience_filter: { contact_type: 'tenant', excludeOptedOut: true, excludeUnreachable: true },
      body_template: 'hi',
      stats: { audience: 1, sent: 1, delivered: 0, failed: 0, skipped_opted_out: 0, skipped_no_consent: 0, queued: 0 },
      recipients: {
        'c-1': { status: 'sent', conversationId: seeded.conversationId, tsMsgId: seeded.tsMsgId },
      },
      updated_at: now,
    } satisfies BroadcastItem);

    const res = await signedTwilioPost(
      app,
      STATUS_PATH,
      statusParams({ MessageSid: 'SMbcastsent', MessageStatus: 'sent' }),
    );
    expect(res.status).toBe(200);

    const bcast = world.broadcasts.get('bcast-carrier')!;
    const slot = bcast.recipients['c-1']!;
    // The marker landed; the slot's claim status and the stored counters did not move.
    expect(slot.carrierSentAt).toBeDefined();
    expect(slot.status).toBe('sent');
    expect(bcast.stats.sent).toBe(1);
    expect(bcast.stats.delivered).toBe(0);
    // Live surfaces get poked so the row flips Sending... -> Sent without a reload.
    const emit = world.emitted.find((e) => e.event === 'broadcast.updated');
    expect(emit).toBeDefined();
    const stats = (emit!.payload as { stats: { sent: number; sending?: number; queued: number } })
      .stats;
    // Derived stats now count this slot as carrier-confirmed sent, not in-flight.
    expect(stats.sent).toBe(1);
    expect(stats.sending).toBe(0);
    expect(stats.queued).toBe(0);
  });

  it("broadcast rollup: a REDELIVERED 'sent' callback is a no-op (message transition gates the side effects)", async () => {
    const { app, world } = makeWebhookHarness();
    const seeded = await seedOutbound(world, 'SMbcastdup', { broadcast_id: 'bcast-dup' });
    const now = new Date().toISOString();
    world.broadcasts.set('bcast-dup', {
      broadcastId: 'bcast-dup',
      created_by: 'usr_test',
      created_at: now,
      status: 'sent',
      audience_filter: { contact_type: 'tenant', excludeOptedOut: true, excludeUnreachable: true },
      body_template: 'hi',
      stats: { audience: 1, sent: 1, delivered: 0, failed: 0, skipped_opted_out: 0, skipped_no_consent: 0, queued: 0 },
      recipients: {
        'c-1': { status: 'sent', conversationId: seeded.conversationId, tsMsgId: seeded.tsMsgId },
      },
      updated_at: now,
    } satisfies BroadcastItem);

    const params = statusParams({ MessageSid: 'SMbcastdup', MessageStatus: 'sent' });
    await signedTwilioPost(app, STATUS_PATH, params);
    const stamped = world.broadcasts.get('bcast-dup')!.recipients['c-1']!.carrierSentAt;
    expect(stamped).toBeDefined();
    const emitsAfterFirst = world.emitted.filter((e) => e.event === 'broadcast.updated').length;

    await signedTwilioPost(app, STATUS_PATH, params); // Twilio redelivery
    const after = world.broadcasts.get('bcast-dup')!.recipients['c-1']!;
    expect(after.carrierSentAt).toBe(stamped); // never re-stamped
    expect(world.emitted.filter((e) => e.event === 'broadcast.updated').length).toBe(emitsAfterFirst);
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

  it('SYSTEM-send SID (syssid# marker, e.g. a cell-verification code) → INFO ack, never the ERROR backstop', async () => {
    const { app, world, capture } = makeWebhookHarness({ statusUnknownSidRetryDelayMs: 10 });
    // verify-start registered its code SMS as a system send: a real outbound
    // with NO message row by design.
    world.systemSidMarkers.set('SMverify01', 'cell_verification');

    const res = await signedTwilioPost(
      app,
      STATUS_PATH,
      statusParams({ MessageSid: 'SMverify01', MessageStatus: 'delivered' }),
    );
    expect(res.status).toBe(200);
    // The receipt acks at INFO with the marker kind — and the alarm-feeding
    // unknown-SID ERROR must NOT fire (the whole point of the marker:
    // docs/issues/verification-sms-receipts-trip-error-alarm.md).
    const info = capture.lines.find((l) =>
      String(l['msg']).includes('delivery receipt for a system send'),
    )!;
    expect(info).toBeDefined();
    expect(info['kind']).toBe('cell_verification');
    expect(info['providerSid']).toBe('SMverify01');
    expect(
      capture.atLevel(ERROR).find((l) => String(l['msg']).includes('unknown provider SID')),
    ).toBeUndefined();
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

      const res = await signedTwilioPost(
        app,
        STATUS_PATH,
        statusParams({ MessageStatus: 'undelivered', ErrorCode: '30003' }),
      );
      expect(res.status).toBe(200);

      // Routed through the SQS path with an exact DelaySeconds backoff (60s for
      // attempt 1) — recorded as a delayed outbound job, NOT an EventBridge
      // schedule, and NOT clamped to a 60s floor.
      expect(outbound.delayed).toHaveLength(1);
      const { envelope, delaySeconds } = outbound.delayed[0]!;
      expect(envelope.jobName).toBe(RETRY_SEND_JOB);
      expect(envelope.payload).toEqual({
        providerSid: 'SMout0001',
        conversationId: seeded.conversationId,
        attempt: 1,
      });
      // context envelope: the recovered conversationId rides the job
      expect(envelope.correlationContext.conversationId).toBe(seeded.conversationId);
      // backed off exactly 60s for attempt 1 (retryBackoffMs(1) = 60_000)
      expect(delaySeconds).toBe(retryBackoffMs(1) / 1000);
      // the payload never carries the message body (PII rides the DB, not the wire)
      expect(JSON.stringify(envelope.payload)).not.toContain('outbound body');
    });

    it('a REDELIVERED 30003 callback does not enqueue a second retry (transition no-op gates side effects)', async () => {
      const { app, world } = makeWebhookHarness();
      await seedOutbound(world, 'SMout0001');
      const params = statusParams({ MessageStatus: 'undelivered', ErrorCode: '30003' });

      await signedTwilioPost(app, STATUS_PATH, params);
      await signedTwilioPost(app, STATUS_PATH, params); // Twilio redelivery

      expect(outbound.delayed).toHaveLength(1);
    });

    it('30003 past the attempt cap ERRORs (now terminal) and does NOT enqueue', async () => {
      const { app, world, capture } = makeWebhookHarness();
      await seedOutbound(world, 'SMretry3', { retry_attempt: MAX_SEND_RETRY_ATTEMPTS });

      await signedTwilioPost(
        app,
        STATUS_PATH,
        statusParams({ MessageSid: 'SMretry3', MessageStatus: 'undelivered', ErrorCode: '30003' }),
      );

      expect(outbound.delayed).toHaveLength(0);
      // Exhausting retries makes the transient failure TERMINAL → it graduates to error.
      const err = capture.atLevel(ERROR).find((l) => String(l['msg']).includes('exhausted retries'));
      expect(err).toBeDefined();
    });

    it('30005 (invalid number) flags the CONTACT sms_unreachable and never retries', async () => {
      const { app, world } = makeWebhookHarness();
      world.contacts.push({ contactId: 'contact-T', type: 'tenant', phone: TENANT_PHONE });
      await seedOutbound(world, 'SMout0001');

      await signedTwilioPost(app, STATUS_PATH, statusParams({ MessageStatus: 'failed', ErrorCode: '30005' }));

      expect(world.flagWrites).toEqual([{ contactId: 'contact-T', flag: 'sms_unreachable', value: true }]);
      expect(outbound.delayed).toHaveLength(0);
    });

    it('30006 (landline) does the same', async () => {
      const { app, world } = makeWebhookHarness();
      world.contacts.push({ contactId: 'contact-T', type: 'tenant', phone: TENANT_PHONE });
      await seedOutbound(world, 'SMout0001');

      await signedTwilioPost(app, STATUS_PATH, statusParams({ MessageStatus: 'undelivered', ErrorCode: '30006' }));

      expect(world.flagWrites).toEqual([{ contactId: 'contact-T', flag: 'sms_unreachable', value: true }]);
      expect(outbound.delayed).toHaveLength(0);
    });

    it('30005 on an MMS leg flags NOTHING - "unknown handset" on a picture says nothing about SMS', async () => {
      // Prod 2026-08-24: a Verizon mobile delivered 10/10 SMS and 8 inbound
      // while 6/6 of its MMS died 30005 in under a second each. The old arm
      // flagged the contact sms_unreachable off those MMS legs, and that flag is
      // a HARD exclusion from every broadcast + matching audience - so a tenant
      // whose texts all land would be silently dropped from sends.
      const { app, world, capture } = makeWebhookHarness();
      world.contacts.push({ contactId: 'contact-T', type: 'tenant', phone: TENANT_PHONE });
      await seedOutbound(world, 'MMout0001', { type: 'mms' });

      await signedTwilioPost(
        app,
        STATUS_PATH,
        statusParams({ MessageSid: 'MMout0001', MessageStatus: 'undelivered', ErrorCode: '30005' }),
      );

      expect(world.flagWrites).toHaveLength(0);
      const owner = world.contacts.find((c) => c.contactId === 'contact-T')!;
      expect(owner.sms_unreachable).toBeFalsy();
      expect(outbound.delayed).toHaveLength(0); // still never retried
      const warn = capture
        .atLevel(WARN)
        .find((l) => String(l['msg']).includes('attachment did not get through'));
      expect(warn).toBeDefined();
      expect(warn?.['errorCode']).toBe('30005');
    });

    it('30006 on an MMS leg flags NOTHING TOO - "landline OR unreachable carrier" is a disjunction', async () => {
      // Symmetric with the 30005 case above, and an earlier revision of this
      // branch got it wrong. 30006 reads "landline or unreachable carrier";
      // only the first half is a line-type fact, and "unreachable carrier" is
      // message-type-specific because SMS and MMS traverse different
      // interconnects. We have ZERO observations of a 30006 on an MMS leg -
      // every 30006 in the prod audit came from an SMS leg - which is silence
      // about this case, not evidence for it.
      //
      // Decided on the cost asymmetry: scoping loses at most one broadcast
      // (every consumer of the flag sends text-only, so the next leg is SMS and
      // flags a real landline then), while not scoping risks a permanent,
      // invisible exclusion that nothing ever clears.
      const { app, world, capture } = makeWebhookHarness();
      world.contacts.push({ contactId: 'contact-T', type: 'tenant', phone: TENANT_PHONE });
      await seedOutbound(world, 'MMout0002', { type: 'mms' });

      await signedTwilioPost(
        app,
        STATUS_PATH,
        statusParams({ MessageSid: 'MMout0002', MessageStatus: 'undelivered', ErrorCode: '30006' }),
      );

      expect(world.flagWrites).toHaveLength(0);
      const owner = world.contacts.find((c) => c.contactId === 'contact-T')!;
      expect(owner.sms_unreachable).toBeFalsy();
      expect(outbound.delayed).toHaveLength(0);
      const warn = capture
        .atLevel(WARN)
        .find((l) => String(l['msg']).includes('attachment did not get through'));
      expect(warn?.['errorCode']).toBe('30006');
    });

    it('30006 on an SMS leg still flags - landline detection is unchanged', async () => {
      // The path that actually catches landlines in prod: 5 of the 6 genuine
      // sms_unreachable flags were HD Carrier landlines, all caught this way.
      const { app, world } = makeWebhookHarness();
      world.contacts.push({ contactId: 'contact-T', type: 'tenant', phone: TENANT_PHONE });
      await seedOutbound(world, 'SMland01');

      await signedTwilioPost(
        app,
        STATUS_PATH,
        statusParams({ MessageSid: 'SMland01', MessageStatus: 'undelivered', ErrorCode: '30006' }),
      );

      expect(world.flagWrites).toEqual([
        { contactId: 'contact-T', flag: 'sms_unreachable', value: true },
      ]);
    });

    it('30005 on an ATTACHED SECONDARY number does NOT flag the owner sms_unreachable (number-scoped); the SAME on the PRIMARY does', async () => {
      const SECOND = '+15550100002';

      // (a) Failure on the SECONDARY number → owner contact flag NOT set.
      {
        const { app, world } = makeWebhookHarness();
        world.contacts.push({ contactId: 'contact-T', type: 'tenant', phone: TENANT_PHONE });
        await world.contactsRepo.addPhone('contact-T', { phone: SECOND });
        // The outbound that failed went to the SECONDARY number's conversation.
        await seedOutbound(world, 'SMsecond', {}, SECOND);

        await signedTwilioPost(
          app,
          STATUS_PATH,
          statusParams({ MessageSid: 'SMsecond', MessageStatus: 'failed', ErrorCode: '30005' }),
        );

        expect(world.flagWrites).toHaveLength(0);
        const owner = world.contacts.find((c) => c.contactId === 'contact-T')!;
        expect(owner.sms_unreachable).toBeFalsy();
      }

      // (b) The SAME failure on the PRIMARY number still flags the contact.
      {
        const { app, world } = makeWebhookHarness();
        world.contacts.push({ contactId: 'contact-T', type: 'tenant', phone: TENANT_PHONE });
        await world.contactsRepo.addPhone('contact-T', { phone: SECOND });
        await seedOutbound(world, 'SMprimary', {}, TENANT_PHONE);

        await signedTwilioPost(
          app,
          STATUS_PATH,
          statusParams({ MessageSid: 'SMprimary', MessageStatus: 'failed', ErrorCode: '30005' }),
        );

        expect(world.flagWrites).toEqual([
          { contactId: 'contact-T', flag: 'sms_unreachable', value: true },
        ]);
      }
    });

    it('30005 on a NATIVE GROUP TEXT flags nobody and logs once per sid', async () => {
      // Reachable: a classic status callback for a group leg in the pre-marker
      // window resolves to the GROUP thread, which has no participant_phone.
      // Flagging nothing is correct (a group failure says nothing about any one
      // member's number), but Twilio redelivers status callbacks - so the
      // degradation must not log the same line on every redelivery.
      const { app, world, capture } = makeWebhookHarness();
      world.contacts.push({ contactId: 'contact-T', type: 'tenant', phone: TENANT_PHONE });
      const group = await world.conversationsRepo.createGroupTextThread({
        conversationId: 'gt-status-1',
        members: [
          { contactId: 'contact-T', phone: TENANT_PHONE },
          { contactId: 'contact-O', phone: '+15550100009' },
        ],
      });
      await world.messagesRepo.append({
        conversationId: group.item.conversationId,
        providerSid: 'SMgroupleg1',
        providerTs: '2026-06-12T10:00:00.000Z',
        type: 'sms',
        direction: 'outbound',
        author: 'teammate',
        body: 'group body',
        deliveryStatus: 'queued',
      });

      const params = statusParams({
        MessageSid: 'SMgroupleg1',
        MessageStatus: 'failed',
        ErrorCode: '30005',
      });
      await signedTwilioPost(app, STATUS_PATH, params);
      await signedTwilioPost(app, STATUS_PATH, params);

      expect(world.flagWrites).toHaveLength(0);
      const lines = capture.lines.filter((l) =>
        String(l['msg']).includes('sms_unreachable on a group_text thread'),
      );
      expect(lines).toHaveLength(1);
    });

    it('30007 (carrier filtering) is a terminal ERROR (via the delivery_failed marker) and never retries', async () => {
      const { app, world, capture } = makeWebhookHarness();
      const seeded = await seedOutbound(world, 'SMout0001');

      await signedTwilioPost(app, STATUS_PATH, statusParams({ MessageStatus: 'undelivered', ErrorCode: '30007' }));

      // Terminal failure → the delivery_failed marker carries the error severity
      // (feeds the alarm), with the conversation + correlation context.
      const err = capture.atLevel(ERROR).find((l) => l['event'] === 'delivery_failed')!;
      expect(err).toBeDefined();
      expect(err['errorCode']).toBe('30007');
      expect(err['conversationId']).toBe(seeded.conversationId);
      expect(typeof err['correlationId']).toBe('string');
      // The "carrier filtering — not retried" note is now a WARN context line
      // (the marker owns the error/alarm, so we don't double-log an error).
      const note = capture.atLevel(WARN).find((l) => String(l['msg']).includes('carrier filtering'));
      expect(note).toBeDefined();
      expect(outbound.delayed).toHaveLength(0);
      expect(world.flagWrites).toHaveLength(0);
    });

    it('21610 (opt-out suppression) sets sms_opt_out + audit event and never retries', async () => {
      const { app, world } = makeWebhookHarness();
      world.contacts.push({ contactId: 'contact-T', type: 'tenant', phone: TENANT_PHONE });
      await seedOutbound(world, 'SMout0001');

      await signedTwilioPost(app, STATUS_PATH, statusParams({ MessageStatus: 'failed', ErrorCode: '21610' }));

      expect(world.flagWrites).toEqual([{ contactId: 'contact-T', flag: 'sms_opt_out', value: true }]);
      expect(world.auditEvents).toEqual([
        expect.objectContaining({ entityKey: 'contacts#contact-T', event_type: 'sms_opt_out_recorded' }),
      ]);
      expect(outbound.delayed).toHaveLength(0);
    });

    it('21610 on an ATTACHED SECONDARY number does NOT flag the owner sms_opt_out (number-scoped); the SAME on the PRIMARY does', async () => {
      const SECOND = '+15550100002';

      // (a) Suppression on the SECONDARY number → owner contact flag + audit NOT set.
      {
        const { app, world } = makeWebhookHarness();
        world.contacts.push({ contactId: 'contact-T', type: 'tenant', phone: TENANT_PHONE });
        await world.contactsRepo.addPhone('contact-T', { phone: SECOND });
        await seedOutbound(world, 'SMsecond21610', {}, SECOND);

        await signedTwilioPost(
          app,
          STATUS_PATH,
          statusParams({ MessageSid: 'SMsecond21610', MessageStatus: 'failed', ErrorCode: '21610' }),
        );

        expect(world.flagWrites).toHaveLength(0);
        const owner = world.contacts.find((c) => c.contactId === 'contact-T')!;
        expect(owner.sms_opt_out).toBeFalsy();
        expect(world.auditEvents.some((e) => e.entityKey === 'contacts#contact-T')).toBe(false);
      }

      // (b) The SAME suppression on the PRIMARY number still flags + audits.
      {
        const { app, world } = makeWebhookHarness();
        world.contacts.push({ contactId: 'contact-T', type: 'tenant', phone: TENANT_PHONE });
        await world.contactsRepo.addPhone('contact-T', { phone: SECOND });
        await seedOutbound(world, 'SMprimary21610', {}, TENANT_PHONE);

        await signedTwilioPost(
          app,
          STATUS_PATH,
          statusParams({ MessageSid: 'SMprimary21610', MessageStatus: 'failed', ErrorCode: '21610' }),
        );

        expect(world.flagWrites).toEqual([
          { contactId: 'contact-T', flag: 'sms_opt_out', value: true },
        ]);
        expect(world.auditEvents).toContainEqual(
          expect.objectContaining({ entityKey: 'contacts#contact-T', event_type: 'sms_opt_out_recorded' }),
        );
      }
    });

    it('21610 on a GROUP thread writes nothing and says so ONCE, not on every redelivery', async () => {
      // The 30005/30006 twin above got this treatment; the 21610 arm did not,
      // so a group leg fell into "no contact record to flag" - the exact
      // misleading line the twin's branch was written to avoid - and repeated it
      // on every Twilio redelivery. There is no number to scope a group 21610
      // to; per-member receipts land in S5 (spec 15.8).
      const { app, world, capture } = makeWebhookHarness();
      world.contacts.push({ contactId: 'contact-T', type: 'tenant', phone: TENANT_PHONE });
      const group = await world.conversationsRepo.createGroupTextThread({
        conversationId: 'gt-21610',
        members: [
          { contactId: 'contact-T', phone: TENANT_PHONE },
          { contactId: 'contact-O', phone: '+15550100009' },
        ],
      });
      await world.messagesRepo.append({
        conversationId: group.item.conversationId,
        providerSid: 'SMgroup21610',
        providerTs: '2026-06-12T10:00:00.000Z',
        type: 'sms',
        direction: 'outbound',
        author: 'teammate',
        body: 'group body',
        deliveryStatus: 'queued',
      });

      const params = statusParams({
        MessageSid: 'SMgroup21610',
        MessageStatus: 'failed',
        ErrorCode: '21610',
      });
      await signedTwilioPost(app, STATUS_PATH, params);
      await signedTwilioPost(app, STATUS_PATH, params);

      expect(world.flagWrites).toHaveLength(0);
      expect(world.auditEvents).toHaveLength(0);
      expect(
        capture.lines.filter((l) => String(l['msg']).includes('no contact record to flag')),
      ).toHaveLength(0);
      expect(
        capture.lines.filter((l) =>
          String(l['msg']).includes('21610 suppression on a group_text thread'),
        ),
      ).toHaveLength(1);
    });

    it('the error code is recorded on the message item either way', async () => {
      const { app, world } = makeWebhookHarness();
      await seedOutbound(world, 'SMout0001');
      await signedTwilioPost(app, STATUS_PATH, statusParams({ MessageStatus: 'undelivered', ErrorCode: '30007' }));
      expect((await world.messagesRepo.getByProviderSid('SMout0001'))?.error_code).toBe('30007');
    });

    it('an undelivered/failed callback logs the delivery_failed marker with the error_code + SID (IDs only, doc §9)', async () => {
      const { app, world, capture } = makeWebhookHarness();
      await seedOutbound(world, 'SMout0001');

      await signedTwilioPost(
        app,
        STATUS_PATH,
        statusParams({ MessageStatus: 'undelivered', ErrorCode: '30005' }),
      );

      // Stable marker the DeliveryFailures metric filter keys on. 30005 (invalid
      // number) is a TERMINAL failure → ERROR, with the Twilio error_code +
      // provider SID, never a body/phone (PII).
      const marker = capture
        .atLevel(ERROR)
        .find((l) => l['event'] === 'delivery_failed' && l['providerSid'] === 'SMout0001')!;
      expect(marker).toBeDefined();
      expect(marker['errorCode']).toBe('30005');
      expect(marker['providerStatus']).toBe('undelivered');
      expect(typeof marker['correlationId']).toBe('string');
      // A 'failed' status with no code is terminal too → also marked at ERROR.
      const { app: app2, world: world2, capture: capture2 } = makeWebhookHarness();
      await seedOutbound(world2, 'SMout0002');
      await signedTwilioPost(app2, STATUS_PATH, statusParams({ MessageSid: 'SMout0002', MessageStatus: 'failed' }));
      expect(
        capture2.atLevel(ERROR).some((l) => l['event'] === 'delivery_failed' && l['providerSid'] === 'SMout0002'),
      ).toBe(true);
    });

    it('a delivered callback does NOT emit the delivery_failed marker', async () => {
      const { app, world, capture } = makeWebhookHarness();
      await seedOutbound(world, 'SMout0001');
      await signedTwilioPost(app, STATUS_PATH, statusParams({ MessageStatus: 'delivered' }));
      expect(capture.lines.some((l) => l['event'] === 'delivery_failed')).toBe(false);
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
    // The retry backoff (60s) is <=12min → SQS path. The InProcess outbound
    // adapter RECORDS the delayed retry; deliverDelayed() drains it through the
    // handler deterministically (no real sleep) — the analog of the old
    // scheduler.deliverAll.
    const outbound = new InProcessOutboundQueueAdapter({ dispatch: dispatchJob });
    configureOutboundQueue(outbound);
    const capture = createLogCapture();
    const logger = createLogger({ destination: capture.stream });
    configureJobsLogger(logger);

    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });
    const seeded = await seedOutbound(world, 'SMout0001');

    // 1) the failure callback enqueues the retry
    await signedTwilioPost(app, STATUS_PATH, statusParams({ MessageStatus: 'undelivered', ErrorCode: '30003' }));
    expect(outbound.delayed).toHaveLength(1);

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
    await outbound.deliverDelayed(dispatchJob);

    // the retry went to the provider with the SAME body, automated:true path
    expect(world.sent).toEqual([{ to: TENANT_PHONE, body: 'outbound body' }]);
    // and the NEW message records retry_of + retry_attempt
    const retried = world.messages.find((m) => m.retry_of !== undefined)!;
    expect(retried).toBeDefined();
    expect(retried.retry_of).toBe(buildTsMsgId(seeded.provider_ts, 'SMout0001'));
    expect(retried.retry_attempt).toBe(1);
    expect(retried.direction).toBe('outbound');
    expect(retried).toMatchObject({
      transport_schema_version: 1,
      requested_transport: 'sms',
      actual_transport: 'sms',
    });
    expect(seeded.actual_transport).toBeUndefined();
  });

  it('AUTOMATED RETRY re-presigns media_attachments FRESH (never replays the stored stale URLs)', async () => {
    // The automated 30003 twin of the manual Retry route: presign PER ATTEMPT.
    // A message's stored mediaUrls are short-lived bearer tokens - replaying them
    // on a retry 24h later would hand Twilio an EXPIRED token. The durable truth
    // is media_attachments (s3Keys); each is re-presigned fresh at retry time.
    const outbound = new InProcessOutboundQueueAdapter({ dispatch: dispatchJob });
    configureOutboundQueue(outbound);
    const logger = createLogger({ destination: createLogCapture().stream });
    configureJobsLogger(logger);

    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });
    const STALE_URL =
      'https://s3.local/uploads/aaaa?X-Amz-Signature=STALEEXPIRED&X-Amz-Expires=3600';
    await seedOutbound(world, 'SMout0001', {
      media_attachments: [{ s3Key: 'uploads/aaaa', contentType: 'image/png' }],
      // The stale presigned URL from the FIRST send - must NOT be replayed.
      mediaUrls: [STALE_URL],
    });
    await signedTwilioPost(app, STATUS_PATH, statusParams({ MessageStatus: 'undelivered', ErrorCode: '30003' }));

    // A fake store whose presign is unique per call AND derived from the key:
    // proves the retry re-presigns (never replaying the stored URL).
    let presignCount = 0;
    const mediaStore = {
      async presign(key: string, ttl: number) {
        presignCount += 1;
        return `https://s3.local/${key}?X-Amz-Signature=fresh${presignCount}&X-Amz-Expires=${ttl}`;
      },
    } as unknown as import('../src/adapters/mediaStore.js').MediaStore;

    const send = createSendMessageService({
      config: loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: ORIGIN_SECRET, MESSAGING_DRIVER: 'console' }),
      logger,
      adapter: world.adapter,
      conversationsRepo: world.conversationsRepo,
      messagesRepo: world.messagesRepo,
      contactsRepo: world.contactsRepo,
      auditRepo: world.auditRepo,
    });
    registerRetrySendJobHandler({ sendMessage: send, messagesRepo: world.messagesRepo, mediaStore, logger });
    await outbound.deliverDelayed(dispatchJob);

    // Exactly one fresh presign happened for the one attachment.
    expect(presignCount).toBe(1);
    const sentUrls = world.sent[0]?.mediaUrls;
    expect(sentUrls).toBeDefined();
    // Freshly presigned (bearer-token query present) AND derived from the s3Key,
    // and NOT the stored stale URL.
    expect(sentUrls?.[0]).not.toBe(STALE_URL);
    expect(sentUrls?.[0]).toContain('X-Amz-Signature=fresh');
    expect(sentUrls?.[0]).toContain('uploads/aaaa');
    // The durable attachments ride along so the retried message PERSISTS them.
    const retried = world.messages.find((m) => m.retry_of !== undefined)!;
    expect(retried.media_attachments).toEqual([{ s3Key: 'uploads/aaaa', contentType: 'image/png' }]);
  });

  it('AUTOMATED RETRY with NO media_attachments replays raw mediaUrls (e2e/raw seam fallback)', async () => {
    const outbound = new InProcessOutboundQueueAdapter({ dispatch: dispatchJob });
    configureOutboundQueue(outbound);
    const logger = createLogger({ destination: createLogCapture().stream });
    configureJobsLogger(logger);

    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });
    const RAW_URL = 'https://provider.example/raw-media-fixture';
    // No media_attachments (the raw internal/e2e seam): the raw mediaUrls ARE the
    // durable truth here, so replaying them verbatim is correct.
    await seedOutbound(world, 'SMout0001', { mediaUrls: [RAW_URL] });
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
    // No mediaStore dep at all - proves the fallback path needs none.
    registerRetrySendJobHandler({ sendMessage: send, messagesRepo: world.messagesRepo, logger });
    await outbound.deliverDelayed(dispatchJob);

    expect(world.sent[0]?.mediaUrls).toEqual([RAW_URL]);
  });

  it('a retry carries the ORIGINAL message author through (ai stays ai)', async () => {
    const outbound = new InProcessOutboundQueueAdapter({ dispatch: dispatchJob });
    configureOutboundQueue(outbound);
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
    await outbound.deliverDelayed(dispatchJob);

    const retried = world.messages.find((m) => m.retry_of !== undefined)!;
    expect(retried).toBeDefined();
    expect(retried.author).toBe('ai'); // not reset to teammate by the retry
  });

  it('a refused retry (contact opted out meanwhile) WARNs and stops the chain — no throw, no send', async () => {
    const outbound = new InProcessOutboundQueueAdapter({ dispatch: dispatchJob });
    configureOutboundQueue(outbound);
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
    await outbound.deliverDelayed(dispatchJob);

    expect(world.sent).toHaveLength(0);
    const warn = capture.atLevel(WARN).find((l) => String(l['msg']).includes('send refused'));
    expect(warn).toBeDefined();
  });

  it('EXECUTION GUARD: a redelivered job (same jobId) sends NOTHING and resolves (consumer can delete)', async () => {
    const outbound = new InProcessOutboundQueueAdapter({ dispatch: dispatchJob });
    configureOutboundQueue(outbound);
    const capture = createLogCapture();
    const logger = createLogger({ destination: capture.stream });
    configureJobsLogger(logger);

    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });
    await seedOutbound(world, 'SMout0001');
    await signedTwilioPost(app, STATUS_PATH, statusParams({ MessageStatus: 'undelivered', ErrorCode: '30003' }));
    const envelope = outbound.delayed[0]!.envelope;

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

    // First delivery: marker written (keyed by the envelope jobId), send happens.
    await dispatchJob(JSON.parse(JSON.stringify(envelope)));
    expect(world.sent).toHaveLength(1);
    expect([...world.jobExecutionMarkers.keys()]).toEqual([envelope.jobId]);

    // SQS redelivery of the SAME message (DeleteMessage failure / visibility
    // overrun / SIGTERM mid-flight): must resolve SUCCESSFULLY — so the
    // consumer deletes it — without re-texting the human.
    await expect(dispatchJob(JSON.parse(JSON.stringify(envelope)))).resolves.toBeUndefined();
    expect(world.sent).toHaveLength(1); // nothing re-sent
    const suppressed = capture.lines.find((l) =>
      String(l['msg']).includes('duplicate delivery suppressed'),
    );
    expect(suppressed).toBeDefined();
    expect(suppressed?.['jobId']).toBe(envelope.jobId);
  });

  it('EXECUTION GUARD: a non-conditional marker write failure propagates as a handler failure (redelivery)', async () => {
    const outbound = new InProcessOutboundQueueAdapter({ dispatch: dispatchJob });
    configureOutboundQueue(outbound);
    const logger = createLogger({ destination: createLogCapture().stream });
    configureJobsLogger(logger);

    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });
    await seedOutbound(world, 'SMout0001');
    await signedTwilioPost(app, STATUS_PATH, statusParams({ MessageStatus: 'undelivered', ErrorCode: '30003' }));
    const envelope = outbound.delayed[0]!.envelope;

    world.messagesRepo.putJobExecutionMarker = async () => {
      throw new Error('marker write exploded');
    };
    registerRetrySendJobHandler({
      sendMessage: async () => {
        throw new Error('must not be reached — guard precedes the send');
      },
      messagesRepo: world.messagesRepo,
      logger,
    });

    await expect(dispatchJob(JSON.parse(JSON.stringify(envelope)))).rejects.toThrow(
      'marker write exploded',
    );
    expect(world.sent).toHaveLength(0); // marker failure stops BEFORE the provider
  });

  it('a missing original message WARNs and does nothing', async () => {
    // No runAt → delaySeconds 0 → the InProcess outbound adapter dispatches the
    // job immediately in-process (no deliverDelayed needed).
    const outbound = new InProcessOutboundQueueAdapter({ dispatch: dispatchJob });
    configureOutboundQueue(outbound);
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
    await outbound.settle(); // immediate dispatch is deferred - drain it

    const warn = capture.atLevel(WARN).find((l) => String(l['msg']).includes('original message not found'));
    expect(warn).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// The attempt-aware relay severity taxonomy (plan Task 13, spec D23 +
// adjudication S2a). A relay fan-out or team leg logs WARN while a retry rung is
// actually claimed and ERROR once the chain is a real dead end, ON TOP of the
// existing carve-outs rather than instead of them - so 21610 and every
// announcement leg stay WARN, and the 1:1 and native-group-text paths, which the
// shared set still governs, do not move.
//
// Every case builds its OWN harness, and therefore its own log collector: a
// shared one makes `expect(errorLines()).toHaveLength(0)` order-dependent.
// ---------------------------------------------------------------------------
describe('relay delivery-failure severity (D23)', () => {
  const RELAY_CONV = 'conv-relay-severity';
  const RELAY_POOL = '+15550109000';
  const RELAY_SENDER = '+15550100001';
  const RELAY_MEMBER = '+15550100002';
  const RELAY_MEMBER_KEY = 'c-bob';
  const RELAY_LEG_SID = 'SMleg-severity-01';
  const RELAY_SOURCE_SID = 'SMrelay-src-severity';
  const RELAY_SOURCE_TS = '2026-09-01T12:00:00.000Z';
  const RELAY_ROOT_KEY = '2026-09-01T12:00:00.000Z#SMrelay-root-severity';

  beforeEach(() => {
    configureScheduler(new InMemorySchedulerAdapter());
    configureOutboundQueue(new InProcessOutboundQueueAdapter({ dispatch: dispatchJob }));
    configureJobsLogger(createLogger({ destination: createLogCapture().stream }));
  });
  afterEach(() => {
    _resetForTests();
  });

  /**
   * One relay source with one failed-member slot and the `relaysid#` pointer the
   * callback resolves through. `rung` (when given) makes the source itself a
   * RETRY row at that attempt number, which is how the cap case is reached
   * without walking a whole ladder - the ladder walk lives in
   * relayRetryClaim.webhook.test.ts.
   */
  async function seedRelayLeg(
    world: FakeWorld,
    opts: { senderKey?: string; rung?: number } = {},
  ): Promise<void> {
    world.conversations.set(RELAY_CONV, {
      conversationId: RELAY_CONV,
      participant_phone: RELAY_POOL,
      pool_number: RELAY_POOL,
      status: 'open',
      last_activity_at: RELAY_SOURCE_TS,
      type: 'relay_group',
      ai_mode: 'manual',
      participants: [
        { contactId: 'c-alice', phone: RELAY_SENDER, name: 'Alice' },
        { contactId: RELAY_MEMBER_KEY, phone: RELAY_MEMBER, name: 'Bob' },
      ],
      created_at: RELAY_SOURCE_TS,
    });
    const appended = await world.messagesRepo.append({
      conversationId: RELAY_CONV,
      providerSid: RELAY_SOURCE_SID,
      providerTs: RELAY_SOURCE_TS,
      type: 'sms',
      direction: 'inbound',
      author: 'tenant',
      deliveryStatus: 'delivered',
      relaySenderKey: opts.senderKey ?? 'c-alice',
      body: 'is the unit still available?',
      deliveryRecipients: { [RELAY_MEMBER_KEY]: { status: 'sent' } },
      ...(opts.rung !== undefined && {
        relayRetryOf: RELAY_ROOT_KEY,
        relayRetryMemberKey: RELAY_MEMBER_KEY,
        relayRetryAttempt: opts.rung,
        relayRetryDestDigest: 'deadbeefdeadbeef',
        relayRetryOriginDirection: 'inbound' as const,
        relayRetryLegBody: 'Alice: is the unit still available?',
      }),
    });
    await world.messagesRepo.putRelaySidPointer(RELAY_LEG_SID, {
      conversationId: RELAY_CONV,
      tsMsgId: appended.tsMsgId,
      memberKey: RELAY_MEMBER_KEY,
    });
  }

  function relayFailureParams(over: Record<string, string> = {}): Record<string, string> {
    return {
      MessageSid: RELAY_LEG_SID,
      MessageStatus: 'undelivered',
      ErrorCode: '30003',
      To: RELAY_MEMBER,
      From: RELAY_POOL,
      ApiVersion: '2010-04-01',
      ...over,
    };
  }

  function relayFailureLines(capture: LogCapture, level: number): Record<string, unknown>[] {
    return capture
      .atLevel(level)
      .filter((l) => l['event'] === 'delivery_failed' && l['relay'] === true);
  }

  it('logs WARN while a retry is claimed and ERROR once the ladder is exhausted', async () => {
    const claimed = makeWebhookHarness();
    await seedRelayLeg(claimed.world);
    await signedTwilioPost(claimed.app, STATUS_PATH, relayFailureParams());
    expect(relayFailureLines(claimed.capture, WARN)).toContainEqual(
      expect.objectContaining({ retryClaim: 'claimed', errorCode: '30003' }),
    );
    expect(relayFailureLines(claimed.capture, ERROR)).toHaveLength(0);

    // The last rung's own leg failing: next would be 4, past the cap, so the
    // chain is terminal and the alarm says which dead end it is.
    const exhausted = makeWebhookHarness();
    await seedRelayLeg(exhausted.world, { rung: 3 });
    await signedTwilioPost(exhausted.app, STATUS_PATH, relayFailureParams());
    expect(relayFailureLines(exhausted.capture, ERROR)).toContainEqual(
      expect.objectContaining({ retryClaim: 'cap_exhausted', errorCode: '30003' }),
    );
    expect(relayFailureLines(exhausted.capture, WARN)).toHaveLength(0);
  });

  // D23: the 21610 carve-out survives. A purely attempt-aware predicate would
  // alarm on the platform correctly honoring STOP - a strictly larger increase
  // than the one the founder approved.
  it('keeps 21610 at WARN on a relay leg', async () => {
    const { app, world, capture } = makeWebhookHarness();
    await seedRelayLeg(world);
    await signedTwilioPost(app, STATUS_PATH, relayFailureParams({ ErrorCode: '21610' }));
    expect(relayFailureLines(capture, ERROR)).toHaveLength(0);
    expect(relayFailureLines(capture, WARN)).toContainEqual(
      expect.objectContaining({ retryClaim: 'code_not_retryable', errorCode: '21610' }),
    );
  });

  // D23: announcement legs keep WARN. They reach this same severity site through
  // the same pointers and no retry is ever claimed for them, so "ERROR whenever
  // no retry was claimed" would alarm every relay intro, member-added,
  // group-closed and tour-reminder rung - blast radius from a mission that
  // fences that file out.
  it('keeps an announcement leg at WARN', async () => {
    const { app, world, capture } = makeWebhookHarness();
    await seedRelayLeg(world, { senderKey: 'system' });
    await signedTwilioPost(app, STATUS_PATH, relayFailureParams());
    expect(relayFailureLines(capture, ERROR)).toHaveLength(0);
    expect(relayFailureLines(capture, WARN)).toContainEqual(
      expect.objectContaining({ retryClaim: 'fenced_announcement' }),
    );
  });

  // A terminal 30003 on a fan-out or team leg is a real dead end for a real
  // tenant, and nothing else surfaces it.
  it('ERRORs a 30003 whose claim was declined for a missing destination', async () => {
    const { app, world, capture } = makeWebhookHarness();
    await seedRelayLeg(world);
    const params = relayFailureParams();
    delete params['To'];
    await signedTwilioPost(app, STATUS_PATH, params);
    expect(relayFailureLines(capture, ERROR)).toContainEqual(
      expect.objectContaining({ retryClaim: 'to_missing' }),
    );
  });

  // 30005 follows TODAY's rule (terminal, ERROR) and still carries a cause -
  // that is what stops an operator reading an internal fault and a genuine
  // unreachable handset as the same line.
  it('keeps a 30005 relay leg at ERROR, with code_not_retryable as its cause', async () => {
    const { app, world, capture } = makeWebhookHarness();
    await seedRelayLeg(world);
    await signedTwilioPost(app, STATUS_PATH, relayFailureParams({ ErrorCode: '30005' }));
    expect(relayFailureLines(capture, ERROR)).toContainEqual(
      expect.objectContaining({ retryClaim: 'code_not_retryable', errorCode: '30005' }),
    );
  });

  // The `source_unreadable` case is an INTERNAL fault and takes its own message
  // rather than the shared carrier-shaped one, so the alarm is self-describing.
  it('ERRORs an unreadable source with its own message', async () => {
    const { app, world, capture } = makeWebhookHarness();
    await seedRelayLeg(world);
    world.messagesRepo.getByTsMsgIdConsistent = async () => undefined;

    await signedTwilioPost(app, STATUS_PATH, relayFailureParams());

    const line = relayFailureLines(capture, ERROR).find(
      (l) => l['retryClaim'] === 'source_unreadable',
    );
    expect(line).toBeDefined();
    expect(line!['msg']).not.toBe('twilio relay-recipient delivery failed (undelivered/failed)');
  });

  // The 1:1 and native-group-text paths are FENCED and must not move: they still
  // read the shared set, where 30003 is still a carve-out, and their failure line
  // carries no retryClaim at all.
  it('leaves the 1:1 severity unchanged', async () => {
    const { app, world, capture } = makeWebhookHarness();
    await seedOutbound(world, 'SMout0001');
    await signedTwilioPost(
      app,
      STATUS_PATH,
      statusParams({ MessageStatus: 'undelivered', ErrorCode: '30003' }),
    );
    expect(capture.atLevel(ERROR).filter((l) => l['event'] === 'delivery_failed')).toHaveLength(0);
    const warn = capture
      .atLevel(WARN)
      .find((l) => l['event'] === 'delivery_failed' && l['providerSid'] === 'SMout0001');
    expect(warn).toBeDefined();
    expect(warn!['relay']).toBeUndefined();
    expect(warn!['retryClaim']).toBeUndefined();
  });
});
