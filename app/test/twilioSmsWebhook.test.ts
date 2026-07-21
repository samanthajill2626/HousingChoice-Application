// M1.1 golden suite — POST /webhooks/twilio/sms (inbound webhook ingress).
// Signature verification is exercised for REAL (computed HMAC-SHA1 via the
// twilio package, validated by the middleware) — only repos/adapter/S3 are
// in-memory fakes. Covers the doc-§7.1 echo defenses, redelivery dedupe,
// STOP/START recording, and MMS mirroring.
import { describe, expect, it } from 'vitest';
import { ContactOptedOutError, createSendMessageService } from '../src/services/sendMessage.js';
import {
  HELP_REPLY,
  STOP_CONFIRMATION,
  WELCOME_SMS,
} from '../src/lib/smsCompliance.js';
import { loadConfig } from '../src/lib/config.js';
import type { ConversationItem } from '../src/repos/conversationsRepo.js';
import type { ExtractionRepo } from '../src/repos/extractionRepo.js';
import { createLogger } from '../src/lib/logger.js';
import { createLogCapture } from './helpers/logCapture.js';
import {
  AUTH_TOKEN,
  inboundSmsParams,
  makeWebhookHarness,
  ORIGIN_SECRET,
  OUR_NUMBER,
  signedTwilioPost,
  TENANT_PHONE,
} from './helpers/twilioWebhookHarness.js';

const WARN = 40;
const ERROR = 50;
const SMS_PATH = '/webhooks/twilio/sms';

describe('POST /webhooks/twilio/sms — signature verification (real HMAC)', () => {
  it('accepts a correctly signed webhook (200 TwiML) and persists the message', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await signedTwilioPost(app, SMS_PATH, inboundSmsParams());

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/xml');
    expect(res.text).toContain('<Response/>');
    expect(world.messages).toHaveLength(1);
    expect(world.messages[0]).toMatchObject({
      provider_sid: 'SMinbound0001',
      direction: 'inbound',
      // No reviewed contact for this phone — authorship is honest 'unknown'
      // (operator mandate; see MessageAuthor in messagesRepo).
      author: 'unknown',
      type: 'sms',
      body: 'hello, looking for a 2 bed',
    });
  });

  it('rejects a TAMPERED signature with 403 and persists nothing', async () => {
    const { app, world, capture } = makeWebhookHarness();
    const res = await signedTwilioPost(app, SMS_PATH, inboundSmsParams(), { tamper: true });

    expect(res.status).toBe(403);
    expect(world.messages).toHaveLength(0);
    expect(world.conversations.size).toBe(0);
    const warn = capture.atLevel(WARN).find((l) => String(l['msg']).includes('invalid X-Twilio-Signature'))!;
    expect(warn).toBeDefined();
    expect(typeof warn['correlationId']).toBe('string');
    // Stable marker the WebhookSignatureRejections metric filter keys on (doc §9).
    expect(warn['event']).toBe('webhook_signature_rejected');
    // The body must never be logged (and the marker line carries no PII).
    expect(JSON.stringify(capture.lines)).not.toContain('looking for a 2 bed');
    expect(JSON.stringify(warn)).not.toContain('looking for a 2 bed');
  });

  it('rejects a MISSING signature header with 403 and persists nothing', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await signedTwilioPost(app, SMS_PATH, inboundSmsParams(), { omitSignature: true });
    expect(res.status).toBe(403);
    expect(world.messages).toHaveLength(0);
  });

  it('rejects a signature computed for a DIFFERENT public URL (Host-header attack shape)', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await signedTwilioPost(app, SMS_PATH, inboundSmsParams(), {
      signatureBaseUrl: 'https://attacker.example',
    });
    expect(res.status).toBe(403);
    expect(world.messages).toHaveLength(0);
  });

  it('unconfigured validation FAILS CLOSED in production (403 + ERROR), allows with WARN in development', async () => {
    // production, no TWILIO_AUTH_TOKEN / PUBLIC_BASE_URL (job-delivery vars
    // present — production fail-fasts without them since M1.2)
    const prod = makeWebhookHarness({
      env: {
        NODE_ENV: 'production',
        TWILIO_AUTH_TOKEN: undefined,
        PUBLIC_BASE_URL: undefined,
        JOBS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/000000000000/hc-test-jobs',
        SCHEDULER_TARGET_ARN: 'arn:aws:sqs:us-east-1:000000000000:hc-test-jobs',
        SCHEDULER_ROLE_ARN: 'arn:aws:iam::000000000000:role/hc-test-scheduler',
      },
    });
    const prodRes = await signedTwilioPost(prod.app, SMS_PATH, inboundSmsParams());
    expect(prodRes.status).toBe(403);
    expect(prod.world.messages).toHaveLength(0);
    const err = prod.capture.atLevel(ERROR).find((l) => String(l['msg']).includes('fail closed'));
    expect(err).toBeDefined();

    // development (test NODE_ENV), same missing config -> allowed + WARN
    const dev = makeWebhookHarness({
      env: { TWILIO_AUTH_TOKEN: undefined, PUBLIC_BASE_URL: undefined },
    });
    const devRes = await signedTwilioPost(dev.app, SMS_PATH, inboundSmsParams(), { omitSignature: true });
    expect(devRes.status).toBe(200);
    expect(dev.world.messages).toHaveLength(1);
    const warn = dev.capture
      .atLevel(WARN)
      .find((l) => String(l['msg']).includes('WITHOUT signature validation'));
    expect(warn).toBeDefined();
  });
});

describe('POST /webhooks/twilio/sms — multi-phone resolution (BE1/C1)', () => {
  const PRIMARY = TENANT_PHONE; // phone A (primary)
  const SECOND = '+15550100002'; // phone B (attached, pointer present)

  it('inbound from an ATTACHED second number resolves to the owner (no new contact) and bumps B.lastSeenAt', async () => {
    const { app, world } = makeWebhookHarness();
    // A contact owning A (primary) + B (attached). Seeding via the repo writes
    // both phones[] and the phone-pointer for B (the resolution seam under test).
    world.contacts.push({
      contactId: 'contact-multi',
      type: 'tenant',
      status: 'active',
      phone: PRIMARY,
      created_at: '2026-06-10T00:00:00.000Z',
    });
    await world.contactsRepo.addPhone('contact-multi', { phone: SECOND, label: 'work' });
    const contactCountBefore = world.contacts.filter((c) => c.phone_ref !== true).length;

    // FIX 2: addPhone stamps B's lastSeenAt to NOW, so asserting "lastSeenAt is
    // defined / != created_at" would pass even if the webhook's touchPhoneLastSeen
    // were removed. Overwrite B's entry to a fixed PAST sentinel directly on the
    // world contact, so the only thing that can move it off the sentinel is the
    // webhook path's touchPhoneLastSeen call (proves it actually ran).
    const PAST_SENTINEL = '2020-01-01T00:00:00.000Z';
    const seededOwner = world.contacts.find((c) => c.contactId === 'contact-multi')!;
    seededOwner.phones!.find((p) => p.phone === SECOND)!.lastSeenAt = PAST_SENTINEL;

    const res = await signedTwilioPost(
      app,
      SMS_PATH,
      inboundSmsParams({ MessageSid: 'SMfromB0001', From: SECOND, Body: 'it is me again' }),
    );
    expect(res.status).toBe(200);

    // No NEW real contact was minted — the pointer resolved B to the owner.
    const realContacts = world.contacts.filter((c) => c.phone_ref !== true);
    expect(realContacts).toHaveLength(contactCountBefore);
    expect(world.contactCreates).toHaveLength(0);

    // B's lastSeenAt was bumped off the past sentinel by the webhook's
    // touchPhoneLastSeen (and parses to a recent time). A's was untouched.
    const owner = world.contacts.find((c) => c.contactId === 'contact-multi')!;
    const bEntry = owner.phones?.find((p) => p.phone === SECOND);
    expect(bEntry?.lastSeenAt).toBeDefined();
    expect(bEntry?.lastSeenAt).not.toBe(PAST_SENTINEL);
    const bumpedMs = Date.parse(bEntry!.lastSeenAt!);
    expect(Number.isNaN(bumpedMs)).toBe(false);
    expect(Date.now() - bumpedMs).toBeLessThan(60_000); // recent
  });

  it('inbound from a brand-new UNKNOWN number still mints its own stub (never auto-attached)', async () => {
    const { app, world } = makeWebhookHarness();
    world.contacts.push({
      contactId: 'contact-multi',
      type: 'tenant',
      status: 'active',
      phone: PRIMARY,
    });

    const res = await signedTwilioPost(
      app,
      SMS_PATH,
      inboundSmsParams({ MessageSid: 'SMunknown01', From: '+15550109999', Body: 'who is this' }),
    );
    expect(res.status).toBe(200);
    // A new stub was created for the unknown number (honest-identity mandate) —
    // it was NOT silently attached to the existing contact.
    expect(world.contactCreates).toHaveLength(1);
    const owner = world.contacts.find((c) => c.contactId === 'contact-multi')!;
    expect(owner.phones).toBeUndefined(); // existing contact untouched
  });
});

describe('POST /webhooks/twilio/sms — echo-loop defenses (doc §7.1)', () => {
  it('drops a webhook whose From is OUR number: 200 TwiML, zero persisted, zero side effects', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await signedTwilioPost(
      app,
      SMS_PATH,
      inboundSmsParams({ From: OUR_NUMBER, To: TENANT_PHONE, MessageSid: 'SMecho0001' }),
    );

    expect(res.status).toBe(200);
    expect(res.text).toContain('<Response/>');
    expect(world.messages).toHaveLength(0);
    expect(world.conversations.size).toBe(0);
    expect(world.sent).toHaveLength(0);
    expect(world.touches).toHaveLength(0);
  });

  it('FULL LOOP: outbound send via the service, then its webhook echo (same SID) dedupes to a no-op', async () => {
    // OUR_PHONE_NUMBERS deliberately unset: the echo slips past defense 1
    // (From-match) and must be stopped by defense 2 (SID dedupe against the
    // copy persisted at send time by the send wrapper).
    const harness = makeWebhookHarness({ env: { OUR_PHONE_NUMBERS: undefined } });
    const { app, world } = harness;

    // Seed the conversation, then send outbound through the REAL service
    // wired to the same fakes (persist-at-send under the provider SID).
    const conversation = await world.conversationsRepo.createOrGetByParticipantPhone(
      TENANT_PHONE,
      'tenant_1to1',
    );
    const send = createSendMessageService({
      config: loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: ORIGIN_SECRET, MESSAGING_DRIVER: 'console' }),
      logger: createLogger({ destination: createLogCapture().stream }),
      adapter: world.adapter,
      conversationsRepo: world.conversationsRepo,
      messagesRepo: world.messagesRepo,
      contactsRepo: world.contactsRepo,
      auditRepo: world.auditRepo,
    });
    const outcome = await send({ conversationId: conversation.conversationId, body: 'our outbound reply' });
    expect(world.messages).toHaveLength(1);

    // The Messaging Service projects our own send back at the webhook.
    const res = await signedTwilioPost(
      app,
      SMS_PATH,
      inboundSmsParams({
        MessageSid: outcome.providerSid,
        From: OUR_NUMBER,
        To: TENANT_PHONE,
        Body: 'our outbound reply',
      }),
    );

    expect(res.status).toBe(200);
    expect(world.messages).toHaveLength(1); // still exactly one — dedupe no-op
    expect(world.sent).toHaveLength(1); // and absolutely nothing re-sent
    expect(world.flagWrites).toHaveLength(0);
  });

  it('REDELIVERY: the identical inbound webhook twice persists exactly one message and re-runs the idempotent side effects', async () => {
    const { app, world } = makeWebhookHarness();
    const params = inboundSmsParams({ MessageSid: 'SMredeliver01' });

    const first = await signedTwilioPost(app, SMS_PATH, params);
    const second = await signedTwilioPost(app, SMS_PATH, params);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(world.messages).toHaveLength(1);
    expect(world.conversations.size).toBe(1);
    // The dedupe path does NOT early-return: the side effects re-run (they
    // are idempotent), so both deliveries touch the inbox.
    expect(world.touches).toHaveLength(2);
  });

  it('REDELIVERY completes a first delivery that died after the append: media + STOP side effects land on retry', async () => {
    const { app, world } = makeWebhookHarness();
    world.contacts.push({ contactId: 'contact-T', type: 'tenant', phone: TENANT_PHONE });
    const params = inboundSmsParams({
      MessageSid: 'MMcrash01',
      Body: 'STOP',
      OptOutType: 'STOP',
      NumMedia: '1',
      MediaUrl0: 'https://api.twilio.com/media/crash',
      MediaContentType0: 'image/jpeg',
    });

    // First delivery: the media fetch throws (per-attachment failure path) —
    // the message persists but its media never reaches S3.
    world.failMediaUrls.add('https://api.twilio.com/media/crash');
    const first = await signedTwilioPost(app, SMS_PATH, params);
    expect(first.status).toBe(200);
    expect(world.messages).toHaveLength(1);
    expect(world.mediaPuts).toHaveLength(0);
    expect(world.messages[0]!.media_attachments).toBeUndefined();

    // Twilio redelivers: the append dedupes, but the pipeline continues —
    // the persisted message lacks media_attachments, so mirroring runs this time.
    world.failMediaUrls.delete('https://api.twilio.com/media/crash');
    const second = await signedTwilioPost(app, SMS_PATH, params);
    expect(second.status).toBe(200);

    expect(world.messages).toHaveLength(1); // still exactly one message
    const conv = [...world.conversations.values()][0]!;
    expect(world.mediaPuts.map((p) => p.key)).toEqual([`media/${conv.conversationId}/MMcrash01/0`]);
    expect(world.messages[0]!.media_attachments).toEqual([
      { s3Key: `media/${conv.conversationId}/MMcrash01/0`, contentType: 'image/jpeg' },
    ]);
    // STOP recording ran on BOTH deliveries (idempotent re-set, no harm).
    expect(conv.sms_opt_out).toBe(true);
    expect(world.contacts[0]!.sms_opt_out).toBe(true);
  });

  it('REDELIVERY with already-mirrored media does NOT re-fetch or re-annotate', async () => {
    const { app, world } = makeWebhookHarness();
    const params = inboundSmsParams({
      MessageSid: 'MMonce01',
      NumMedia: '1',
      MediaUrl0: 'https://api.twilio.com/media/once',
    });

    await signedTwilioPost(app, SMS_PATH, params);
    expect(world.mediaPuts).toHaveLength(1);

    await signedTwilioPost(app, SMS_PATH, params);
    expect(world.mediaPuts).toHaveLength(1); // mirrored exactly once
  });

  it('REDELIVERY recovers a PARTIAL first mirror (1 of 2) — completeness-gated, not presence-gated', async () => {
    const { app, world } = makeWebhookHarness();
    const params = inboundSmsParams({
      MessageSid: 'MMpartial1',
      NumMedia: '2',
      MediaUrl0: 'https://api.twilio.com/media/ok',
      MediaContentType0: 'image/jpeg',
      MediaUrl1: 'https://api.twilio.com/media/flaky',
      MediaContentType1: 'image/png',
    });

    // First delivery: attachment 1 fails to fetch → only attachment 0 mirrors.
    world.failMediaUrls.add('https://api.twilio.com/media/flaky');
    await signedTwilioPost(app, SMS_PATH, params);
    const conv = [...world.conversations.values()][0]!;
    expect(world.messages[0]!.media_attachments).toEqual([
      { s3Key: `media/${conv.conversationId}/MMpartial1/0`, contentType: 'image/jpeg' },
    ]);

    // Redelivery (flaky URL now healthy): because the gate is completeness
    // (1 stored < 2 expected), mirroring RE-RUNS and captures the missing one.
    // The old presence gate (length > 0) would have skipped this → lost media.
    world.failMediaUrls.delete('https://api.twilio.com/media/flaky');
    await signedTwilioPost(app, SMS_PATH, params);
    expect(world.messages[0]!.media_attachments).toEqual([
      { s3Key: `media/${conv.conversationId}/MMpartial1/0`, contentType: 'image/jpeg' },
      { s3Key: `media/${conv.conversationId}/MMpartial1/1`, contentType: 'image/png' },
    ]);
  });
});

describe('POST /webhooks/twilio/sms — conversation resolution', () => {
  it('routes a known landlord phone into a landlord_1to1 conversation with author landlord', async () => {
    const { app, world } = makeWebhookHarness();
    world.contacts.push({ contactId: 'contact-LL', type: 'landlord', phone: TENANT_PHONE });

    await signedTwilioPost(app, SMS_PATH, inboundSmsParams());

    const conv = [...world.conversations.values()][0]!;
    expect(conv.type).toBe('landlord_1to1');
    expect(world.messages[0]).toMatchObject({ author: 'landlord' });
  });

  it('routes a KNOWN tenant phone into a tenant_1to1 conversation', async () => {
    const { app, world } = makeWebhookHarness();
    world.contacts.push({ contactId: 'contact-T', type: 'tenant', phone: TENANT_PHONE });

    await signedTwilioPost(app, SMS_PATH, inboundSmsParams());

    const conv = [...world.conversations.values()][0]!;
    expect(conv.type).toBe('tenant_1to1');
  });

  it('routes a known partner phone into a partner_1to1 conversation with author partner (A2 honesty)', async () => {
    const { app, world } = makeWebhookHarness();
    world.contacts.push({ contactId: 'contact-P', type: 'partner', phone: TENANT_PHONE });

    await signedTwilioPost(app, SMS_PATH, inboundSmsParams());

    const conv = [...world.conversations.values()][0]!;
    expect(conv.type).toBe('partner_1to1');
    expect(world.messages[0]).toMatchObject({ author: 'partner' });
  });

  it('unknown phones get an unknown_1to1 conversation (type is never guessed) and a touch with the body preview + 200', async () => {
    const { app, world } = makeWebhookHarness();
    await signedTwilioPost(app, SMS_PATH, inboundSmsParams());

    const conv = [...world.conversations.values()][0]!;
    expect(conv.type).toBe('unknown_1to1');
    expect(conv.participant_phone).toBe(TENANT_PHONE);
    expect(world.touches).toEqual([
      {
        conversationId: conv.conversationId,
        previewText: 'hello, looking for a 2 bed',
        ts: world.messages[0]!.provider_ts,
      },
    ]);
  });

  it('a contact with an UNRESOLVED type (unknown) also yields unknown_1to1 — only resolved types are trusted', async () => {
    const { app, world } = makeWebhookHarness();
    world.contacts.push({ contactId: 'contact-U', type: 'unknown', status: 'needs_review', phone: TENANT_PHONE });

    await signedTwilioPost(app, SMS_PATH, inboundSmsParams());

    const conv = [...world.conversations.values()][0]!;
    expect(conv.type).toBe('unknown_1to1');
  });
});

describe('POST /webhooks/twilio/sms — STOP/opt-out recording (doc §7.1)', () => {
  it('STOP sets sms_opt_out, writes an audit event, and STILL persists the message', async () => {
    const { app, world } = makeWebhookHarness();
    world.contacts.push({ contactId: 'contact-T', type: 'tenant', phone: TENANT_PHONE });

    const res = await signedTwilioPost(
      app,
      SMS_PATH,
      inboundSmsParams({ Body: 'STOP', OptOutType: 'STOP', MessageSid: 'SMstop01' }),
    );

    expect(res.status).toBe(200);
    expect(world.flagWrites).toEqual([{ contactId: 'contact-T', flag: 'sms_opt_out', value: true }]);
    expect(world.auditEvents).toHaveLength(1);
    expect(world.auditEvents[0]).toMatchObject({
      entityKey: 'contacts#contact-T',
      event_type: 'sms_opt_out_recorded',
    });
    expect(world.messages).toHaveLength(1); // the STOP itself is on the timeline
    expect(world.messages[0]!.body).toBe('STOP');
  });

  it('STOP on an ATTACHED SECONDARY number does NOT flag the owner contact (number-scoped); the SAME STOP on the PRIMARY does', async () => {
    const SECOND = '+15550100002';

    // (a) STOP arriving on the contact's SECONDARY number: the owner's
    // contact-level sms_opt_out must NOT be set (it would suppress the good
    // primary). Only this conversation is suppressed.
    {
      const { app, world } = makeWebhookHarness();
      world.contacts.push({
        contactId: 'contact-multi',
        type: 'tenant',
        status: 'active',
        phone: TENANT_PHONE, // primary
        created_at: '2026-06-10T00:00:00.000Z',
      });
      await world.contactsRepo.addPhone('contact-multi', { phone: SECOND });

      await signedTwilioPost(
        app,
        SMS_PATH,
        inboundSmsParams({ Body: 'STOP', OptOutType: 'STOP', From: SECOND, MessageSid: 'SMstopSecond' }),
      );

      // No contact-level flag write for the owner …
      expect(world.flagWrites).toHaveLength(0);
      const owner = world.contacts.find((c) => c.contactId === 'contact-multi')!;
      expect(owner.sms_opt_out).toBeFalsy();
      // … but the conversation IS suppressed (per-number scope) + audited on the
      // conversation, not the contact.
      const conv = [...world.conversations.values()].find((c) => c.participant_phone === SECOND)!;
      expect(conv.sms_opt_out).toBe(true);
      expect(world.auditEvents).toContainEqual(
        expect.objectContaining({
          entityKey: `conversations#${conv.conversationId}`,
          event_type: 'sms_opt_out_recorded',
        }),
      );
      expect(world.auditEvents.some((e) => e.entityKey === 'contacts#contact-multi')).toBe(false);
    }

    // (b) The SAME STOP on the PRIMARY number still sets the contact flag.
    {
      const { app, world } = makeWebhookHarness();
      world.contacts.push({
        contactId: 'contact-multi',
        type: 'tenant',
        status: 'active',
        phone: TENANT_PHONE, // primary
        created_at: '2026-06-10T00:00:00.000Z',
      });
      await world.contactsRepo.addPhone('contact-multi', { phone: SECOND });

      await signedTwilioPost(
        app,
        SMS_PATH,
        inboundSmsParams({ Body: 'STOP', OptOutType: 'STOP', From: TENANT_PHONE, MessageSid: 'SMstopPrimary' }),
      );

      expect(world.flagWrites).toEqual([
        { contactId: 'contact-multi', flag: 'sms_opt_out', value: true },
      ]);
      const owner = world.contacts.find((c) => c.contactId === 'contact-multi')!;
      expect(owner.sms_opt_out).toBe(true);
    }
  });

  it('recognizes every standard stop keyword case-insensitively (no OptOutType param)', async () => {
    for (const keyword of ['stop', 'STOPALL', 'Unsubscribe', 'CANCEL', 'end', 'Quit']) {
      const { app, world } = makeWebhookHarness();
      world.contacts.push({ contactId: 'contact-T', type: 'tenant', phone: TENANT_PHONE });
      await signedTwilioPost(app, SMS_PATH, inboundSmsParams({ Body: keyword }));
      expect(world.flagWrites, `keyword ${keyword}`).toEqual([
        { contactId: 'contact-T', flag: 'sms_opt_out', value: true },
      ]);
    }
  });

  it('START clears the flag (and audits the re-subscribe)', async () => {
    const { app, world } = makeWebhookHarness();
    world.contacts.push({ contactId: 'contact-T', type: 'tenant', phone: TENANT_PHONE, sms_opt_out: true });

    await signedTwilioPost(
      app,
      SMS_PATH,
      inboundSmsParams({ Body: 'START', OptOutType: 'START', MessageSid: 'SMstart01' }),
    );

    expect(world.flagWrites).toEqual([{ contactId: 'contact-T', flag: 'sms_opt_out', value: false }]);
    expect(world.auditEvents[0]).toMatchObject({ event_type: 'sms_opt_out_cleared' });
    expect(world.contacts[0]!.sms_opt_out).toBe(false);
  });

  it('STOP also flags the CONVERSATION (contact and conversation suppression travel together)', async () => {
    const { app, world } = makeWebhookHarness();
    world.contacts.push({ contactId: 'contact-T', type: 'tenant', phone: TENANT_PHONE });

    await signedTwilioPost(app, SMS_PATH, inboundSmsParams({ Body: 'STOP', OptOutType: 'STOP' }));

    const conv = [...world.conversations.values()][0]!;
    expect(conv.sms_opt_out).toBe(true);
    expect(world.optOutSets).toEqual([{ conversationId: conv.conversationId, value: true }]);
  });

  it('a STOP from an UNKNOWN phone suppresses AND flags the auto-captured stub (M1.2), later send refused', async () => {
    const { app, world } = makeWebhookHarness();
    await signedTwilioPost(app, SMS_PATH, inboundSmsParams({ Body: 'STOP', MessageSid: 'SMstopunknown' }));

    // M1.2: the unknown phone is auto-captured BEFORE opt-out recording, so
    // the stub contact carries the suppression flag alongside the conversation.
    expect(world.contacts).toHaveLength(1);
    const stub = world.contacts[0]!;
    expect(world.flagWrites).toEqual([{ contactId: stub.contactId, flag: 'sms_opt_out', value: true }]);
    expect(world.messages).toHaveLength(1);

    // The CONVERSATION carries the suppression + both audit trail entries
    // (capture first, then the opt-out against the captured contact).
    const conv = [...world.conversations.values()][0]!;
    expect(conv.sms_opt_out).toBe(true);
    expect(world.auditEvents).toEqual([
      expect.objectContaining({
        entityKey: `contacts#${stub.contactId}`,
        event_type: 'contact_auto_captured',
      }),
      expect.objectContaining({
        entityKey: `contacts#${stub.contactId}`,
        event_type: 'sms_opt_out_recorded',
        payload: expect.objectContaining({ providerSid: 'SMstopunknown', source: 'keyword' }),
      }),
    ]);

    // And the send wrapper refuses the conversation from now on.
    const send = createSendMessageService({
      config: loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: ORIGIN_SECRET, MESSAGING_DRIVER: 'console' }),
      logger: createLogger({ destination: createLogCapture().stream }),
      adapter: world.adapter,
      conversationsRepo: world.conversationsRepo,
      messagesRepo: world.messagesRepo,
      contactsRepo: world.contactsRepo,
      auditRepo: world.auditRepo,
      events: world.events,
    });
    await expect(send({ conversationId: conv.conversationId, body: 'hi again' })).rejects.toBeInstanceOf(
      ContactOptedOutError,
    );
    expect(world.sent).toHaveLength(0);
  });

  it('a START from an UNKNOWN phone clears the conversation flag and audits the re-subscribe', async () => {
    const { app, world } = makeWebhookHarness();
    await signedTwilioPost(app, SMS_PATH, inboundSmsParams({ Body: 'STOP', MessageSid: 'SMstopu2' }));
    const conv = [...world.conversations.values()][0]!;
    expect(conv.sms_opt_out).toBe(true);

    await signedTwilioPost(app, SMS_PATH, inboundSmsParams({ Body: 'START', MessageSid: 'SMstartu2' }));

    expect(conv.sms_opt_out).toBe(false);
    expect(world.optOutSets).toEqual([
      { conversationId: conv.conversationId, value: true },
      { conversationId: conv.conversationId, value: false },
    ]);
    // M1.2: both deliveries resolve the SAME auto-captured contact (no second
    // stub), and the clear lands on it.
    expect(world.contacts).toHaveLength(1);
    const stub = world.contacts[0]!;
    expect(stub.sms_opt_out).toBe(false);
    expect(world.auditEvents.map((e) => e.event_type)).toEqual([
      'contact_auto_captured',
      'sms_opt_out_recorded',
      'sms_opt_out_cleared',
    ]);
    expect(world.auditEvents[2]).toMatchObject({
      entityKey: `contacts#${stub.contactId}`,
      event_type: 'sms_opt_out_cleared',
    });

    // Cleared = sendable again.
    const send = createSendMessageService({
      config: loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: ORIGIN_SECRET, MESSAGING_DRIVER: 'console' }),
      logger: createLogger({ destination: createLogCapture().stream }),
      adapter: world.adapter,
      conversationsRepo: world.conversationsRepo,
      messagesRepo: world.messagesRepo,
      contactsRepo: world.contactsRepo,
      auditRepo: world.auditRepo,
    });
    await expect(send({ conversationId: conv.conversationId, body: 'welcome back' })).resolves.toMatchObject({
      conversationId: conv.conversationId,
    });
  });

  it('an ordinary message containing "stop" mid-sentence is NOT an opt-out', async () => {
    const { app, world } = makeWebhookHarness();
    world.contacts.push({ contactId: 'contact-T', type: 'tenant', phone: TENANT_PHONE });
    await signedTwilioPost(app, SMS_PATH, inboundSmsParams({ Body: 'please stop by the unit at 5' }));
    expect(world.flagWrites).toHaveLength(0);
  });
});

describe('POST /webhooks/twilio/sms — A2P/CTIA keyword replies (WE own them, spec §6)', () => {
  // Extract + un-escape the TwiML <Message> body so we can compare against the
  // (un-escaped) filed copy. The handler XML-escapes ' & < > " into entities.
  function twimlMessage(xml: string): string | undefined {
    const m = /<Message>([\s\S]*?)<\/Message>/.exec(xml);
    if (!m) return undefined;
    return m[1]!
      .replace(/&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }

  it('STOP → TwiML STOP_CONFIRMATION reply (NOT via the gated send wrapper — reaches the opted-out number)', async () => {
    const { app, world } = makeWebhookHarness();
    world.contacts.push({ contactId: 'contact-T', type: 'tenant', phone: TENANT_PHONE, consent_method: 'inbound_text' });

    const res = await signedTwilioPost(
      app,
      SMS_PATH,
      inboundSmsParams({ Body: 'STOP', OptOutType: 'STOP', MessageSid: 'SMkwstop' }),
    );

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/xml');
    expect(twimlMessage(res.text)).toBe(STOP_CONFIRMATION);
    // The confirmation did NOT go through the opt-out-gated sendMessage wrapper.
    expect(world.sent).toHaveLength(0);
    // Suppression still recorded.
    expect(world.flagWrites).toEqual([{ contactId: 'contact-T', flag: 'sms_opt_out', value: true }]);
  });

  it('HELP → TwiML HELP_REPLY reply, no suppression change, and the body carries NO phone number (digits)', async () => {
    const { app, world } = makeWebhookHarness();
    world.contacts.push({ contactId: 'contact-T', type: 'tenant', phone: TENANT_PHONE, consent_method: 'inbound_text' });

    const res = await signedTwilioPost(app, SMS_PATH, inboundSmsParams({ Body: 'HELP', MessageSid: 'SMkwhelp' }));

    expect(res.status).toBe(200);
    const body = twimlMessage(res.text)!;
    expect(body).toBe(HELP_REPLY);
    expect(/\d/.test(body)).toBe(false); // no phone number in HELP (campaign: phone=No)
    // HELP never changes suppression.
    expect(world.flagWrites).toHaveLength(0);
    expect(world.optOutSets).toHaveLength(0);
  });

  it('opt-in (START) → clears suppression, stamps inbound_text consent when absent, replies WELCOME_SMS', async () => {
    const { app, world } = makeWebhookHarness();
    // Contact opted out earlier, and (deliberately) has NO consent recorded.
    world.contacts.push({ contactId: 'contact-T', type: 'tenant', phone: TENANT_PHONE, sms_opt_out: true });

    const res = await signedTwilioPost(
      app,
      SMS_PATH,
      inboundSmsParams({ Body: 'START', OptOutType: 'START', MessageSid: 'SMkwstart' }),
    );

    expect(res.status).toBe(200);
    expect(twimlMessage(res.text)).toBe(WELCOME_SMS);
    // Suppression cleared.
    expect(world.flagWrites).toContainEqual({ contactId: 'contact-T', flag: 'sms_opt_out', value: false });
    // Consent stamped (keyword opt-in is a documented affirmative opt-in).
    const contact = world.contacts.find((c) => c.contactId === 'contact-T')!;
    expect(contact.consent_method).toBe('inbound_text');
    expect(typeof contact.consent_at).toBe('string');
  });

  it('opt-in does NOT overwrite an EXISTING consent_method (e.g. web_form)', async () => {
    const { app, world } = makeWebhookHarness();
    world.contacts.push({
      contactId: 'contact-T',
      type: 'tenant',
      phone: TENANT_PHONE,
      sms_opt_out: true,
      consent_method: 'web_form',
      consent_version: 'ctia-2026-06',
    });

    await signedTwilioPost(
      app,
      SMS_PATH,
      inboundSmsParams({ Body: 'JOIN', MessageSid: 'SMkwjoin' }),
    );

    const contact = world.contacts.find((c) => c.contactId === 'contact-T')!;
    expect(contact.consent_method).toBe('web_form'); // unchanged
  });

  it('a PLAIN inbound from an EXISTING no-consent contact stamps inbound_text (spec §3.2 — reply never JIT-gated)', async () => {
    const { app, world } = makeWebhookHarness();
    // An existing contact with NO consent (e.g. added via the contact form) who
    // now texts in. A brand-new stub is stamped at mint time; this closes the
    // gap for an EXISTING contact so a later staff reply isn't JIT-blocked.
    world.contacts.push({ contactId: 'contact-T', type: 'tenant', phone: TENANT_PHONE });

    const res = await signedTwilioPost(
      app,
      SMS_PATH,
      inboundSmsParams({ Body: 'hi there, is the place still open?', MessageSid: 'SMplaininbound' }),
    );

    expect(res.status).toBe(200);
    expect(twimlMessage(res.text)).toBeUndefined(); // a plain inbound gets NO keyword reply
    const contact = world.contacts.find((c) => c.contactId === 'contact-T')!;
    expect(contact.consent_method).toBe('inbound_text');
    expect(typeof contact.consent_at).toBe('string');
    // Not an opt-out — suppression untouched.
    expect(world.flagWrites).toEqual([]);
  });

  it('a PLAIN inbound does NOT overwrite an existing consent_method (idempotent)', async () => {
    const { app, world } = makeWebhookHarness();
    world.contacts.push({
      contactId: 'contact-T',
      type: 'tenant',
      phone: TENANT_PHONE,
      consent_method: 'verbal_phone',
    });

    await signedTwilioPost(
      app,
      SMS_PATH,
      inboundSmsParams({ Body: 'thanks!', MessageSid: 'SMplain2' }),
    );

    const contact = world.contacts.find((c) => c.contactId === 'contact-T')!;
    expect(contact.consent_method).toBe('verbal_phone'); // unchanged
  });

  it('an opt-out (STOP) from a no-consent contact does NOT stamp consent (revocation, not opt-in)', async () => {
    const { app, world } = makeWebhookHarness();
    world.contacts.push({ contactId: 'contact-T', type: 'tenant', phone: TENANT_PHONE });

    await signedTwilioPost(
      app,
      SMS_PATH,
      inboundSmsParams({ Body: 'STOP', OptOutType: 'STOP', MessageSid: 'SMplainstop' }),
    );

    const contact = world.contacts.find((c) => c.contactId === 'contact-T')!;
    expect(contact.consent_method).toBeUndefined(); // a STOP never confers consent
  });

  it('honors the NEW opt-out keywords OPTOUT and REVOKE (STOP_CONFIRMATION reply + suppression)', async () => {
    for (const keyword of ['OPTOUT', 'REVOKE', 'optout', 'Revoke']) {
      const { app, world } = makeWebhookHarness();
      world.contacts.push({ contactId: 'contact-T', type: 'tenant', phone: TENANT_PHONE, consent_method: 'inbound_text' });
      const res = await signedTwilioPost(app, SMS_PATH, inboundSmsParams({ Body: keyword, MessageSid: `SM-${keyword}` }));
      expect(twimlMessage(res.text), keyword).toBe(STOP_CONFIRMATION);
      expect(world.flagWrites, keyword).toEqual([{ contactId: 'contact-T', flag: 'sms_opt_out', value: true }]);
    }
  });

  it('honors the NEW opt-in keywords JOIN and HOME (WELCOME_SMS reply)', async () => {
    for (const keyword of ['JOIN', 'HOME', 'join', 'Home']) {
      const { app, world } = makeWebhookHarness();
      world.contacts.push({ contactId: 'contact-T', type: 'tenant', phone: TENANT_PHONE, sms_opt_out: true });
      const res = await signedTwilioPost(app, SMS_PATH, inboundSmsParams({ Body: keyword, MessageSid: `SM-${keyword}` }));
      expect(twimlMessage(res.text), keyword).toBe(WELCOME_SMS);
    }
  });

  it('an ordinary message returns empty TwiML (no <Message> reply)', async () => {
    const { app, world } = makeWebhookHarness();
    world.contacts.push({ contactId: 'contact-T', type: 'tenant', phone: TENANT_PHONE, consent_method: 'inbound_text' });
    const res = await signedTwilioPost(app, SMS_PATH, inboundSmsParams({ Body: 'is the unit still available?' }));
    expect(res.text).toContain('<Response/>');
    expect(twimlMessage(res.text)).toBeUndefined();
    expect(world.sent).toHaveLength(0);
  });
});

describe('POST /webhooks/twilio/sms — M1.2 contact auto-capture', () => {
  it('UNKNOWN phone → stub contact (unknown/needs_review/capture metadata) + participants link + audit', async () => {
    const { app, world } = makeWebhookHarness();
    await signedTwilioPost(app, SMS_PATH, inboundSmsParams({ MessageSid: 'SMcapture01' }));

    expect(world.contacts).toHaveLength(1);
    const stub = world.contacts[0]!;
    expect(stub).toMatchObject({
      type: 'unknown', // identity is never guessed; humans triage via byTypeStatus
      status: 'needs_review',
      phone: TENANT_PHONE,
      capture_source: 'inbound_sms',
    });
    expect(typeof stub.captured_at).toBe('string');

    const conv = [...world.conversations.values()][0]!;
    expect(conv.participants).toEqual([{ contactId: stub.contactId, phone: TENANT_PHONE }]);
    expect(world.auditEvents).toEqual([
      {
        entityKey: `contacts#${stub.contactId}`,
        event_type: 'contact_auto_captured',
        payload: { conversationId: conv.conversationId, source: 'inbound_sms' },
      },
    ]);
  });

  it('KNOWN contact without a link → backfills the link ONLY: no new contact, no overwrite, no capture audit', async () => {
    const { app, world } = makeWebhookHarness();
    world.contacts.push({
      contactId: 'contact-known',
      type: 'landlord',
      status: 'active',
      phone: TENANT_PHONE,
      notes: 'pre-existing field that must survive',
    });

    await signedTwilioPost(app, SMS_PATH, inboundSmsParams({ MessageSid: 'SMbackfill01' }));

    expect(world.contacts).toHaveLength(1); // nothing created
    expect(world.contactCreates).toHaveLength(0);
    // NEVER overwrite existing contact fields:
    expect(world.contacts[0]).toMatchObject({
      contactId: 'contact-known',
      type: 'landlord',
      status: 'active',
      notes: 'pre-existing field that must survive',
    });
    expect(world.contacts[0]!.capture_source).toBeUndefined();

    const conv = [...world.conversations.values()][0]!;
    expect(conv.participants).toEqual([{ contactId: 'contact-known', phone: TENANT_PHONE }]);
    expect(world.auditEvents.filter((e) => e.event_type === 'contact_auto_captured')).toHaveLength(0);
  });

  it('DEDUPE path (redelivery) → no double capture: one contact, one link, one audit', async () => {
    const { app, world } = makeWebhookHarness();
    const params = inboundSmsParams({ MessageSid: 'SMcapdup01' });

    await signedTwilioPost(app, SMS_PATH, params);
    await signedTwilioPost(app, SMS_PATH, params);

    expect(world.contacts).toHaveLength(1);
    expect(world.contactCreates).toHaveLength(1);
    expect(
      world.auditEvents.filter((e) => e.event_type === 'contact_auto_captured'),
    ).toHaveLength(1);
    const conv = [...world.conversations.values()][0]!;
    expect(conv.participants).toHaveLength(1);
  });

  it('capture failure never crashes the webhook: 200 TwiML, ERROR logged, message persisted', async () => {
    const { app, world, capture } = makeWebhookHarness();
    // Only the capture path calls the participants claim — fail it there.
    world.conversationsRepo.setParticipantsIfAbsent = async () => {
      throw new Error('participants claim write exploded');
    };

    const res = await signedTwilioPost(app, SMS_PATH, inboundSmsParams({ MessageSid: 'SMcapfail01' }));

    expect(res.status).toBe(200);
    expect(world.messages).toHaveLength(1);
    const err = capture.atLevel(ERROR).find((l) => String(l['msg']).includes('contact auto-capture failed'))!;
    expect(err).toBeDefined();
    expect(typeof err['correlationId']).toBe('string');
  });
});

describe('POST /webhooks/twilio/sms — M1.2 unread tracking + SSE emits', () => {
  it('a fresh inbound increments unread_count and emits message.persisted + conversation.updated', async () => {
    const { app, world } = makeWebhookHarness();
    await signedTwilioPost(app, SMS_PATH, inboundSmsParams({ MessageSid: 'SMunread01' }));

    const conv = [...world.conversations.values()][0]!;
    expect(conv.unread_count).toBe(1);
    expect(world.unreadIncrements).toEqual([conv.conversationId]);

    const message = world.messages[0]!;
    expect(world.emitted).toEqual([
      {
        event: 'message.persisted',
        payload: {
          conversationId: conv.conversationId,
          tsMsgId: message.tsMsgId,
          direction: 'inbound',
          deliveryStatus: 'delivered',
        },
      },
      {
        event: 'conversation.updated',
        payload: {
          conversationId: conv.conversationId,
          last_activity_at: conv.last_activity_at,
          unread_count: 1,
          preview: 'hello, looking for a 2 bed',
          // M1.4 wire fields (shared builder): an unknown-phone inbound is an
          // unresolved unknown_1to1 thread with no resolved name (the
          // participant is un-triaged).
          type: 'unknown_1to1',
          participant_display_name: null,
        },
      },
    ]);
  });

  it('the DEDUPE path does NOT double-increment unread and does NOT re-emit', async () => {
    const { app, world } = makeWebhookHarness();
    const params = inboundSmsParams({ MessageSid: 'SMunread02' });

    await signedTwilioPost(app, SMS_PATH, params);
    await signedTwilioPost(app, SMS_PATH, params); // redelivery → dedupe

    const conv = [...world.conversations.values()][0]!;
    expect(conv.unread_count).toBe(1); // incremented exactly once
    expect(world.unreadIncrements).toHaveLength(1);
    expect(world.touches).toHaveLength(2); // the idempotent touch still re-ran
    expect(world.emitted).toHaveLength(2); // one message.persisted + one conversation.updated
  });

  it('each distinct inbound message keeps counting until a read resets it', async () => {
    const { app, world } = makeWebhookHarness();
    await signedTwilioPost(app, SMS_PATH, inboundSmsParams({ MessageSid: 'SMcount01' }));
    await signedTwilioPost(app, SMS_PATH, inboundSmsParams({ MessageSid: 'SMcount02' }));
    await signedTwilioPost(app, SMS_PATH, inboundSmsParams({ MessageSid: 'SMcount03' }));

    const conv = [...world.conversations.values()][0]!;
    expect(conv.unread_count).toBe(3);

    const reset = await world.conversationsRepo.resetUnread(conv.conversationId);
    expect(reset.unread_count).toBe(0);
  });
});

describe('POST /webhooks/twilio/sms — MMS media mirroring (streams → S3)', () => {
  it('mirrors each MediaUrl{i} to media/<conversationId>/<MessageSid>/<i> and stores the keys', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await signedTwilioPost(
      app,
      SMS_PATH,
      inboundSmsParams({
        MessageSid: 'MMmedia01',
        Body: '',
        NumMedia: '2',
        MediaUrl0: 'https://api.twilio.com/media/0',
        MediaContentType0: 'image/jpeg',
        MediaUrl1: 'https://api.twilio.com/media/1',
        MediaContentType1: 'image/png',
      }),
    );

    expect(res.status).toBe(200);
    const conv = [...world.conversations.values()][0]!;
    const expectedKeys = [
      `media/${conv.conversationId}/MMmedia01/0`,
      `media/${conv.conversationId}/MMmedia01/1`,
    ];
    expect(world.mediaPuts.map((p) => p.key)).toEqual(expectedKeys);
    expect(world.mediaPuts.map((p) => p.contentType)).toEqual(['image/jpeg', 'image/png']);
    expect(world.mediaPuts.every((p) => p.bytes > 0)).toBe(true);
    expect(world.messages[0]).toMatchObject({
      type: 'mms',
      media_attachments: [
        { s3Key: expectedKeys[0], contentType: 'image/jpeg' },
        { s3Key: expectedKeys[1], contentType: 'image/png' },
      ],
      mediaUrls: ['https://api.twilio.com/media/0', 'https://api.twilio.com/media/1'],
    });
    expect(world.messages[0]!.body).toBeUndefined(); // empty Body is not stored
  });

  it('a failed media fetch ERROR-logs (correlated) but the message record survives, other media still mirrored', async () => {
    const { app, world, capture } = makeWebhookHarness();
    world.failMediaUrls.add('https://api.twilio.com/media/broken');

    const res = await signedTwilioPost(
      app,
      SMS_PATH,
      inboundSmsParams({
        MessageSid: 'MMmedia02',
        NumMedia: '2',
        MediaUrl0: 'https://api.twilio.com/media/broken',
        MediaUrl1: 'https://api.twilio.com/media/ok',
      }),
    );

    expect(res.status).toBe(200); // never a crash
    expect(world.messages).toHaveLength(1); // usable message record
    const conv = [...world.conversations.values()][0]!;
    expect(world.messages[0]!.media_attachments).toEqual([
      { s3Key: `media/${conv.conversationId}/MMmedia02/1`, contentType: 'application/octet-stream' },
    ]);
    const err = capture.atLevel(ERROR).find((l) => String(l['msg']).includes('media mirror failed'))!;
    expect(err).toBeDefined();
    expect(typeof err['correlationId']).toBe('string');
    expect(err['conversationId']).toBe(conv.conversationId);
  });

  it('with no media store configured, the message persists and the gap is logged', async () => {
    const { app, world, capture } = makeWebhookHarness({ withoutMediaStore: true, env: { MEDIA_BUCKET: undefined } });
    await signedTwilioPost(
      app,
      SMS_PATH,
      inboundSmsParams({ MessageSid: 'MMmedia03', NumMedia: '1', MediaUrl0: 'https://api.twilio.com/media/x' }),
    );
    expect(world.messages).toHaveLength(1);
    expect(world.mediaPuts).toHaveLength(0);
    const line = capture.atLevel(WARN).find((l) => String(l['msg']).includes('MEDIA_BUCKET'));
    expect(line).toBeDefined();
  });
});

describe('POST /webhooks/twilio/sms — malformed requests', () => {
  it('400s when MessageSid/From are missing (nothing persisted)', async () => {
    const { app, world } = makeWebhookHarness();
    const params = inboundSmsParams();
    delete (params as Record<string, string | undefined>)['From'];
    const res = await signedTwilioPost(app, SMS_PATH, params);
    expect(res.status).toBe(400);
    expect(world.messages).toHaveLength(0);
  });

  it('AUTH_TOKEN constant matches the harness config (sanity: signatures are real)', () => {
    const { config } = makeWebhookHarness();
    expect(config.twilioAuthToken).toBe(AUTH_TOKEN);
  });
});

describe('config: OUR_PHONE_NUMBERS / MEDIA_BUCKET parsing', () => {
  it('parses a comma-separated E.164 list with whitespace tolerance', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      OUR_PHONE_NUMBERS: ' +15550009999 , +15550008888 ',
    } as NodeJS.ProcessEnv);
    expect(config.ourPhoneNumbers).toEqual(['+15550009999', '+15550008888']);
  });

  it('defaults to an empty list and fails fast on non-E.164 entries', () => {
    expect(loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv).ourPhoneNumbers).toEqual([]);
    expect(() =>
      loadConfig({ NODE_ENV: 'test', OUR_PHONE_NUMBERS: '555-0100' } as NodeJS.ProcessEnv),
    ).toThrow(/E\.164/);
  });

  it('exposes MEDIA_BUCKET as config.mediaBucket', () => {
    const config = loadConfig({ NODE_ENV: 'test', MEDIA_BUCKET: 'hc-dev-media-1' } as NodeJS.ProcessEnv);
    expect(config.mediaBucket).toBe('hc-dev-media-1');
  });
});

describe('POST /webhooks/twilio/sms - conversation-fact-extraction scheduling (Task 6)', () => {
  // A stub extraction repo that records scheduleExtraction calls; the other repo
  // methods are never exercised by the webhook path (they throw if touched, which
  // surfaces an accidental call as a test failure rather than a silent no-op).
  function stubExtractionRepo(overrides: Partial<ExtractionRepo> = {}): {
    repo: ExtractionRepo;
    scheduleCalls: { conversationId: string; channel: 'sms' | 'voice' | 'triage'; dueAt: string }[];
  } {
    const scheduleCalls: { conversationId: string; channel: 'sms' | 'voice' | 'triage'; dueAt: string }[] = [];
    const notImpl = (name: string) => async (): Promise<never> => {
      throw new Error(`extraction stub: ${name} must not be called by the webhook path`);
    };
    const repo: ExtractionRepo = {
      async scheduleExtraction(conversationId, channel, dueAt) {
        scheduleCalls.push({ conversationId, channel, dueAt });
      },
      listDue: notImpl('listDue') as ExtractionRepo['listDue'],
      claim: notImpl('claim') as ExtractionRepo['claim'],
      complete: notImpl('complete') as ExtractionRepo['complete'],
      fail: notImpl('fail') as ExtractionRepo['fail'],
      getDue: notImpl('getDue') as ExtractionRepo['getDue'],
      putSuggestion: notImpl('putSuggestion') as ExtractionRepo['putSuggestion'],
      getSuggestion: notImpl('getSuggestion') as ExtractionRepo['getSuggestion'],
      listSuggestionsByContact: notImpl('listSuggestionsByContact') as ExtractionRepo['listSuggestionsByContact'],
      deleteSuggestion: notImpl('deleteSuggestion') as ExtractionRepo['deleteSuggestion'],
      listPending: notImpl('listPending') as ExtractionRepo['listPending'],
      ...overrides,
    };
    return { repo, scheduleCalls };
  }

  it('a fresh inbound on a tenant 1:1 schedules a sliding run (conversationId + dueAt ~ now+debounce)', async () => {
    const { repo, scheduleCalls } = stubExtractionRepo();
    const { app, world, config } = makeWebhookHarness({ extractionRepo: repo });
    world.contacts.push({ contactId: 'contact-T', type: 'tenant', phone: TENANT_PHONE });

    const before = Date.now();
    const res = await signedTwilioPost(app, SMS_PATH, inboundSmsParams({ MessageSid: 'SMextract01' }));
    const after = Date.now();

    expect(res.status).toBe(200);
    const conv = [...world.conversations.values()][0]!;
    expect(conv.type).toBe('tenant_1to1');
    expect(scheduleCalls).toHaveLength(1);
    expect(scheduleCalls[0]!.conversationId).toBe(conv.conversationId);
    expect(scheduleCalls[0]!.channel).toBe('sms');
    const dueMs = Date.parse(scheduleCalls[0]!.dueAt);
    expect(Number.isNaN(dueMs)).toBe(false);
    // dueAt == wall-clock-at-call + debounce, so it lands in [before, after]+debounce.
    expect(dueMs).toBeGreaterThanOrEqual(before + config.aiExtractionDebounceMs);
    expect(dueMs).toBeLessThanOrEqual(after + config.aiExtractionDebounceMs);
  });

  it('schedules for an unknown_1to1 conversation (unknown contacts ARE extraction sources)', async () => {
    const { repo, scheduleCalls } = stubExtractionRepo();
    const { app, world } = makeWebhookHarness({ extractionRepo: repo });

    await signedTwilioPost(app, SMS_PATH, inboundSmsParams({ MessageSid: 'SMextract02' }));

    const conv = [...world.conversations.values()][0]!;
    expect(conv.type).toBe('unknown_1to1');
    expect(scheduleCalls).toHaveLength(1);
    expect(scheduleCalls[0]!.conversationId).toBe(conv.conversationId);
  });

  it('a deduped redelivery does NOT re-schedule (only the fresh append schedules)', async () => {
    const { repo, scheduleCalls } = stubExtractionRepo();
    const { app } = makeWebhookHarness({ extractionRepo: repo });
    const params = inboundSmsParams({ MessageSid: 'SMextractDup' });

    await signedTwilioPost(app, SMS_PATH, params);
    await signedTwilioPost(app, SMS_PATH, params); // redelivery -> dedupe

    expect(scheduleCalls).toHaveLength(1);
  });

  it('does NOT schedule when AI_EXTRACTION_ENABLED is off (kill switch)', async () => {
    const { repo, scheduleCalls } = stubExtractionRepo();
    const { app } = makeWebhookHarness({
      extractionRepo: repo,
      env: { AI_EXTRACTION_ENABLED: 'false' },
    });

    const res = await signedTwilioPost(app, SMS_PATH, inboundSmsParams({ MessageSid: 'SMextractOff' }));

    expect(res.status).toBe(200);
    expect(scheduleCalls).toHaveLength(0);
  });

  it('does NOT schedule for a landlord_1to1 conversation (landlord is not a v1 source)', async () => {
    const { repo, scheduleCalls } = stubExtractionRepo();
    const { app, world } = makeWebhookHarness({ extractionRepo: repo });
    world.contacts.push({ contactId: 'contact-LL', type: 'landlord', phone: TENANT_PHONE });

    await signedTwilioPost(app, SMS_PATH, inboundSmsParams({ MessageSid: 'SMextractLL' }));

    const conv = [...world.conversations.values()][0]!;
    expect(conv.type).toBe('landlord_1to1');
    expect(scheduleCalls).toHaveLength(0);
  });

  it('does NOT schedule for a relay-group inbound (relay is out of scope in v1)', async () => {
    const { repo, scheduleCalls } = stubExtractionRepo();
    const { app, world } = makeWebhookHarness({ extractionRepo: repo });
    const POOL = '+15550109000';
    const MEMBER = '+15550100002';
    const now = new Date().toISOString();
    // Seed a relay group directly on the pool number so To=POOL routes to the
    // relay path (which never schedules extraction). No fan-out handler needed:
    // the enqueue is best-effort and the schedule assertion is what matters.
    const relay: ConversationItem = {
      conversationId: 'conv-relay-1',
      participant_phone: POOL,
      pool_number: POOL,
      status: 'open',
      last_activity_at: now,
      type: 'relay_group',
      ai_mode: 'manual',
      participants: [
        { contactId: 'c-a', phone: MEMBER, name: 'A' },
        { contactId: 'c-b', phone: '+15550100003', name: 'B' },
      ],
      created_at: now,
    };
    world.conversations.set(relay.conversationId, relay);

    const res = await signedTwilioPost(
      app,
      SMS_PATH,
      inboundSmsParams({ From: MEMBER, To: POOL, MessageSid: 'SMextractRelay' }),
    );

    expect(res.status).toBe(200);
    expect(scheduleCalls).toHaveLength(0);
  });

  it('a scheduleExtraction failure NEVER fails the webhook ack (still 200, message persisted, WARN logged)', async () => {
    const { repo } = stubExtractionRepo({
      async scheduleExtraction() {
        throw new Error('schedule exploded');
      },
    });
    const { app, world, capture } = makeWebhookHarness({ extractionRepo: repo });

    const res = await signedTwilioPost(app, SMS_PATH, inboundSmsParams({ MessageSid: 'SMextractThrow' }));

    expect(res.status).toBe(200);
    expect(world.messages).toHaveLength(1);
    const warn = capture.atLevel(WARN).find((l) => String(l['msg']).includes('extraction schedule failed'));
    expect(warn).toBeDefined();
  });
});
