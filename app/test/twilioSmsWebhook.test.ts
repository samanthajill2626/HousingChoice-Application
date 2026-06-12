// M1.1 golden suite — POST /webhooks/twilio/sms (inbound webhook ingress).
// Signature verification is exercised for REAL (computed HMAC-SHA1 via the
// twilio package, validated by the middleware) — only repos/adapter/S3 are
// in-memory fakes. Covers the doc-§7.1 echo defenses, redelivery dedupe,
// STOP/START recording, and MMS mirroring.
import { describe, expect, it } from 'vitest';
import { createSendMessageService } from '../src/services/sendMessage.js';
import { loadConfig } from '../src/lib/config.js';
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
      author: 'tenant',
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
    // The body must never be logged.
    expect(JSON.stringify(capture.lines)).not.toContain('looking for a 2 bed');
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
    // production, no TWILIO_AUTH_TOKEN / PUBLIC_BASE_URL
    const prod = makeWebhookHarness({
      env: {
        NODE_ENV: 'production',
        TWILIO_AUTH_TOKEN: undefined,
        PUBLIC_BASE_URL: undefined,
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

  it('REDELIVERY: the identical inbound webhook twice persists exactly one message', async () => {
    const { app, world } = makeWebhookHarness();
    const params = inboundSmsParams({ MessageSid: 'SMredeliver01' });

    const first = await signedTwilioPost(app, SMS_PATH, params);
    const second = await signedTwilioPost(app, SMS_PATH, params);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(world.messages).toHaveLength(1);
    expect(world.conversations.size).toBe(1);
    // The redelivery acked BEFORE the side-effect pipeline: one touch only.
    expect(world.touches).toHaveLength(1);
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

  it('unknown phones get a tenant_1to1 conversation and a touch with the body preview + 200', async () => {
    const { app, world } = makeWebhookHarness();
    await signedTwilioPost(app, SMS_PATH, inboundSmsParams());

    const conv = [...world.conversations.values()][0]!;
    expect(conv.type).toBe('tenant_1to1');
    expect(conv.participant_phone).toBe(TENANT_PHONE);
    expect(world.touches).toEqual([
      {
        conversationId: conv.conversationId,
        previewText: 'hello, looking for a 2 bed',
        ts: world.messages[0]!.provider_ts,
      },
    ]);
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
      eventType: 'sms_opt_out_recorded',
    });
    expect(world.messages).toHaveLength(1); // the STOP itself is on the timeline
    expect(world.messages[0]!.body).toBe('STOP');
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
    expect(world.auditEvents[0]).toMatchObject({ eventType: 'sms_opt_out_cleared' });
    expect(world.contacts[0]!.sms_opt_out).toBe(false);
  });

  it('a STOP from an unknown phone WARNs (nothing to flag) but the message persists', async () => {
    const { app, world, capture } = makeWebhookHarness();
    await signedTwilioPost(app, SMS_PATH, inboundSmsParams({ Body: 'STOP' }));

    expect(world.flagWrites).toHaveLength(0);
    expect(world.messages).toHaveLength(1);
    const warn = capture.atLevel(WARN).find((l) => String(l['msg']).includes('no contact record'));
    expect(warn).toBeDefined();
  });

  it('an ordinary message containing "stop" mid-sentence is NOT an opt-out', async () => {
    const { app, world } = makeWebhookHarness();
    world.contacts.push({ contactId: 'contact-T', type: 'tenant', phone: TENANT_PHONE });
    await signedTwilioPost(app, SMS_PATH, inboundSmsParams({ Body: 'please stop by the unit at 5' }));
    expect(world.flagWrites).toHaveLength(0);
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
      media_s3_keys: expectedKeys,
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
    expect(world.messages[0]!.media_s3_keys).toEqual([`media/${conv.conversationId}/MMmedia02/1`]);
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
