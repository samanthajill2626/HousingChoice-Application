// M1.1 unit tests: MessagingAdapter drivers + factory. No network calls —
// the Twilio driver gets a fake injected client (TwilioClientLike, same
// pattern as SchedulerClientLike in scheduler.test.ts).
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConsoleMessagingDriver,
  MAX_MEDIA_CONTENT_LENGTH,
  MediaFetchRefusedError,
  TwilioMessagingDriver,
  createMessagingAdapter,
  mapTwilioStatus,
  type TwilioClientLike,
} from '../src/adapters/messaging.js';
import { loadConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import { createLogCapture } from './helpers/logCapture.js';

const TWILIO_ENV = {
  NODE_ENV: 'test',
  MESSAGING_DRIVER: 'twilio',
  TWILIO_ACCOUNT_SID: 'ACtest',
  TWILIO_API_KEY_SID: 'SKtest',
  TWILIO_API_KEY_SECRET: 'secret',
  TWILIO_AUTH_TOKEN: 'token',
  TWILIO_MESSAGING_SERVICE_SID: 'MGtest',
};

// NODE_ENV=production fail-fasts without the M1.2 job-delivery wiring and
// the M1.3 auth wiring — production-shaped configs in this suite carry both.
const JOB_DELIVERY_ENV = {
  JOBS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/000000000000/hc-test-jobs',
  SCHEDULER_TARGET_ARN: 'arn:aws:sqs:us-east-1:000000000000:hc-test-jobs',
  SCHEDULER_ROLE_ARN: 'arn:aws:iam::000000000000:role/hc-test-scheduler',
  SESSION_SECRET: 'test-session-secret',
  GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
  OAUTH_ALLOWED_DOMAINS: 'housingchoice.org,abt-industries.com',
};

function makeFakeTwilioClient() {
  const created: Record<string, unknown>[] = [];
  const client: TwilioClientLike = {
    messages: {
      create: async (params) => {
        created.push(params as unknown as Record<string, unknown>);
        return { sid: 'SM123', status: 'accepted', dateCreated: new Date('2026-06-12T10:00:00.000Z') };
      },
    },
  };
  return { client, created };
}

describe('driver factory (MESSAGING_DRIVER)', () => {
  it('defaults to console for local NODE_ENVs and twilio for production', () => {
    expect(loadConfig({ NODE_ENV: 'development' }).messagingDriver).toBe('console');
    expect(loadConfig({ NODE_ENV: 'test' }).messagingDriver).toBe('console');
    expect(
      loadConfig({
        ...TWILIO_ENV,
        ...JOB_DELIVERY_ENV,
        NODE_ENV: 'production',
        CF_ORIGIN_SECRET: 's',
        MESSAGING_DRIVER: undefined,
        OUR_PHONE_NUMBERS: '+15550009999',
      }).messagingDriver,
    ).toBe('twilio');
  });

  it('honors an explicit MESSAGING_DRIVER and rejects unknown values', () => {
    expect(loadConfig(TWILIO_ENV).messagingDriver).toBe('twilio');
    expect(() => loadConfig({ NODE_ENV: 'development', MESSAGING_DRIVER: 'carrier-pigeon' })).toThrow(
      /MESSAGING_DRIVER/,
    );
  });

  it('fail-fasts when MESSAGING_DRIVER=twilio and TWILIO_* values are missing', () => {
    expect(() => loadConfig({ NODE_ENV: 'development', MESSAGING_DRIVER: 'twilio' })).toThrow(
      /TWILIO_ACCOUNT_SID.*TWILIO_MESSAGING_SERVICE_SID/,
    );
  });

  it('fail-fasts when twilio runs in production with an empty OUR_PHONE_NUMBERS (echo defense 1)', () => {
    const prodTwilio = { ...TWILIO_ENV, ...JOB_DELIVERY_ENV, NODE_ENV: 'production', CF_ORIGIN_SECRET: 's' };
    expect(() => loadConfig(prodTwilio)).toThrow(/OUR_PHONE_NUMBERS/);
    // Configured list → boots.
    expect(loadConfig({ ...prodTwilio, OUR_PHONE_NUMBERS: '+15550009999' }).ourPhoneNumbers).toEqual([
      '+15550009999',
    ]);
    // The guard is twilio+production only: console-in-production and
    // twilio-in-dev both still boot with an empty list (SID dedupe is layer 2).
    expect(
      loadConfig({
        ...JOB_DELIVERY_ENV,
        NODE_ENV: 'production',
        CF_ORIGIN_SECRET: 's',
        MESSAGING_DRIVER: 'console',
      }).ourPhoneNumbers,
    ).toEqual([]);
    expect(loadConfig(TWILIO_ENV).ourPhoneNumbers).toEqual([]);
  });

  it('builds the matching driver for each config', () => {
    expect(createMessagingAdapter({ config: loadConfig({ NODE_ENV: 'test' }) })).toBeInstanceOf(
      ConsoleMessagingDriver,
    );
    expect(
      createMessagingAdapter({
        config: loadConfig(TWILIO_ENV),
        twilioClient: makeFakeTwilioClient().client,
      }),
    ).toBeInstanceOf(TwilioMessagingDriver);
  });
});

describe('TwilioMessagingDriver', () => {
  it('sends via the Messaging Service (no per-message statusCallback) and maps the result', async () => {
    const { client, created } = makeFakeTwilioClient();
    const driver = new TwilioMessagingDriver({
      accountSid: 'ACtest',
      apiKeySid: 'SKtest',
      apiKeySecret: 'secret',
      messagingServiceSid: 'MGtest',
      client,
      logger: createLogger({ destination: createLogCapture().stream }),
    });

    const result = await driver.sendMessage({ to: '+15550100001', body: 'hello', mediaUrls: ['https://m/1'] });

    expect(created).toHaveLength(1);
    expect(created[0]).toEqual({
      to: '+15550100001',
      body: 'hello',
      mediaUrl: ['https://m/1'],
      messagingServiceSid: 'MGtest',
    });
    // The service-level delivery callback covers status events — the driver
    // must NOT set a per-message statusCallback (it would override it).
    expect(created[0]).not.toHaveProperty('statusCallback');
    expect(result).toEqual({
      providerSid: 'SM123',
      status: 'queued', // accepted -> queued on our machine
      providerTs: '2026-06-12T10:00:00.000Z',
    });
  });

  it('emits ONE send_throttled marker on a 429/30022 send and re-throws unchanged (doc §9)', async () => {
    // The single shared send boundary: a Twilio 429/30022 thrown by
    // messages.create is the throttle signal every path (relay/broadcast/retry)
    // funnels through. The driver logs the countable marker ONCE, then re-throws
    // so the caller's existing back-off classification is untouched.
    for (const code of [429, 30022]) {
      const capture = createLogCapture();
      const driver = new TwilioMessagingDriver({
        accountSid: 'ACtest',
        apiKeySid: 'SKtest',
        apiKeySecret: 'secret',
        messagingServiceSid: 'MGtest',
        client: {
          messages: {
            create: async () => {
              throw Object.assign(new Error('rate limited'), { code });
            },
          },
        },
        logger: createLogger({ level: 'info', destination: capture.stream }),
      });

      await expect(
        driver.sendMessage({ to: '+15550100001', body: 'super secret PII body' }),
      ).rejects.toThrow('rate limited');

      // Exactly one marker, WARN (40), carrying only the code — never the body.
      const markers = capture.lines.filter((l) => l['event'] === 'send_throttled');
      expect(markers).toHaveLength(1);
      expect(markers[0]!['level']).toBe(40);
      expect(markers[0]!['errorCode']).toBe(String(code));
      expect(JSON.stringify(capture.lines)).not.toContain('super secret');
    }
  });

  it('does NOT emit send_throttled for a non-throttle send error (re-throws only)', async () => {
    const capture = createLogCapture();
    const driver = new TwilioMessagingDriver({
      accountSid: 'ACtest',
      apiKeySid: 'SKtest',
      apiKeySecret: 'secret',
      messagingServiceSid: 'MGtest',
      client: {
        messages: {
          create: async () => {
            throw Object.assign(new Error('carrier filtered'), { code: 30007 });
          },
        },
      },
      logger: createLogger({ level: 'info', destination: capture.stream }),
    });

    await expect(driver.sendMessage({ to: '+15550100001', body: 'x' })).rejects.toThrow('carrier filtered');
    expect(capture.lines.some((l) => l['event'] === 'send_throttled')).toBe(false);
  });

  it('maps every Twilio status onto the delivery-status machine', () => {
    expect(mapTwilioStatus('accepted')).toBe('queued');
    expect(mapTwilioStatus('queued')).toBe('queued');
    expect(mapTwilioStatus('sending')).toBe('queued');
    expect(mapTwilioStatus('sent')).toBe('sent');
    expect(mapTwilioStatus('delivered')).toBe('delivered');
    expect(mapTwilioStatus('read')).toBe('delivered');
    expect(mapTwilioStatus('undelivered')).toBe('undelivered');
    expect(mapTwilioStatus('failed')).toBe('failed');
    expect(mapTwilioStatus('canceled')).toBe('failed');
    expect(mapTwilioStatus('something-new')).toBe('queued');
  });
});

describe('TwilioMessagingDriver.getMediaStream — SSRF guard + size cap', () => {
  function makeDriver() {
    return new TwilioMessagingDriver({
      accountSid: 'ACtest',
      apiKeySid: 'SKtest',
      apiKeySecret: 'secret',
      messagingServiceSid: 'MGtest',
      client: makeFakeTwilioClient().client,
      logger: createLogger({ destination: createLogCapture().stream }),
    });
  }

  /** Minimal fetch-Response shape the driver reads (ok/status/headers/body). */
  function fakeResponse(contentLength: number) {
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-length': String(contentLength) }),
      body: {}, // truthy is enough — refusal throws before the stream is touched
    };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refuses a non-Twilio host with a typed error BEFORE fetching (credentials never leave)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(makeDriver().getMediaStream('https://attacker.example/media/0')).rejects.toMatchObject({
      name: 'MediaFetchRefusedError',
      reason: 'host_not_allowed',
    });
    // Subdomain confusion must not pass the exact-host check either.
    await expect(
      makeDriver().getMediaStream('https://api.twilio.com.attacker.example/media/0'),
    ).rejects.toBeInstanceOf(MediaFetchRefusedError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses plain http even on the Twilio host (no basic auth over cleartext)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(makeDriver().getMediaStream('http://api.twilio.com/media/0')).rejects.toMatchObject({
      reason: 'host_not_allowed',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses an oversize Content-Length (> 25 MB) after the fetch, before streaming', async () => {
    const fetchSpy = vi.fn(async () => fakeResponse(MAX_MEDIA_CONTENT_LENGTH + 1));
    vi.stubGlobal('fetch', fetchSpy);

    await expect(makeDriver().getMediaStream('https://api.twilio.com/media/big')).rejects.toMatchObject({
      name: 'MediaFetchRefusedError',
      reason: 'too_large',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // The guard runs first, so the allowed URL did reach fetch with basic auth.
    const [, init] = fetchSpy.mock.calls[0] as unknown as [URL, RequestInit];
    expect((init.headers as Record<string, string>)['authorization']).toMatch(/^Basic /);
  });
});

describe('ConsoleMessagingDriver', () => {
  it('returns deterministic fake SIDs, status sent, and never logs the body', async () => {
    const capture = createLogCapture();
    const driver = new ConsoleMessagingDriver({
      logger: createLogger({ level: 'info', destination: capture.stream }),
    });

    const result = await driver.sendMessage({
      to: '+15550100001',
      body: 'super secret PII body',
      idempotencyKey: 'fixed-key',
    });

    expect(result.providerSid).toBe('SMconsole-fixed-key');
    expect(result.status).toBe('sent');
    expect(Date.parse(result.providerTs)).not.toBeNaN();

    expect(capture.lines).toHaveLength(1);
    const line = capture.lines[0]!;
    expect(line['to']).toBe('+15550100001');
    expect(line['bodyLength']).toBe(21);
    expect(JSON.stringify(line)).not.toContain('super secret');
  });

  it('generates unique SIDs without an idempotencyKey', async () => {
    const driver = new ConsoleMessagingDriver({
      logger: createLogger({ destination: createLogCapture().stream }),
    });
    const a = await driver.sendMessage({ to: '+15550100001', body: 'x' });
    const b = await driver.sendMessage({ to: '+15550100001', body: 'x' });
    expect(a.providerSid).toMatch(/^SMconsole-/);
    expect(a.providerSid).not.toBe(b.providerSid);
  });

  it('initiateCall returns a deterministic CAconsole-* CallSid, no network, never logs to/from (M1.9a)', async () => {
    const capture = createLogCapture();
    const driver = new ConsoleMessagingDriver({
      logger: createLogger({ level: 'info', destination: capture.stream }),
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await driver.initiateCall({
      to: '+15550100002',
      from: '+15550109000',
      twimlUrl: 'https://x.example/webhooks/twilio/voice/whisper',
      idempotencyKey: 'fixed-call-key',
    });

    // Deterministic when an idempotencyKey is supplied; never hits the network.
    expect(result.callSid).toBe('CAconsole-fixed-call-key');
    expect(fetchSpy).not.toHaveBeenCalled();
    // PII (doc §9): the log carries the CallSid only — never to/from numbers.
    expect(JSON.stringify(capture.lines)).not.toContain('+15550100002');
    expect(JSON.stringify(capture.lines)).not.toContain('+15550109000');

    // Unique without an idempotencyKey.
    const a = await driver.initiateCall({ to: '+1', from: '+2', twimlUrl: 'https://x/y' });
    const b = await driver.initiateCall({ to: '+1', from: '+2', twimlUrl: 'https://x/y' });
    expect(a.callSid).toMatch(/^CAconsole-/);
    expect(a.callSid).not.toBe(b.callSid);
  });
});

describe('TwilioMessagingDriver.initiateCall (M1.9a)', () => {
  it('calls client.calls.create with to/from/url and returns the CallSid', async () => {
    const calls: { to: string; from: string; url: string }[] = [];
    const client: TwilioClientLike = {
      messages: { create: async () => ({ sid: 'SM', status: 'queued', dateCreated: new Date() }) },
      calls: {
        create: async (params) => {
          calls.push(params);
          return { sid: 'CA-real-123' };
        },
      },
    };
    const driver = new TwilioMessagingDriver({
      accountSid: 'ACtest',
      apiKeySid: 'SKtest',
      apiKeySecret: 'secret',
      messagingServiceSid: 'MGtest',
      client,
      logger: createLogger({ destination: createLogCapture().stream }),
    });
    const result = await driver.initiateCall({
      to: '+15550100002',
      from: '+15550109000',
      twimlUrl: 'https://x.example/webhooks/twilio/voice/whisper',
    });
    expect(result).toEqual({ callSid: 'CA-real-123' });
    expect(calls).toEqual([
      { to: '+15550100002', from: '+15550109000', url: 'https://x.example/webhooks/twilio/voice/whisper' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// M1.7 — pool-number provisioning + the `from` send param.
// ---------------------------------------------------------------------------

/** Fake Twilio client covering the number-provisioning + voice-webhook APIs. */
function makeFakeProvisioningClient(opts: { voice?: boolean } = {}) {
  const created: Record<string, unknown>[] = [];
  const updated: { sid: string; params: { voiceUrl?: string } }[] = [];
  const listed: { phoneNumber: string }[] = [];
  const voice = opts.voice ?? true;
  const incoming = ((sid: string) => ({
    update: async (params: { voiceUrl?: string }) => {
      updated.push({ sid, params });
      return { sid, phoneNumber: '+15550109001', capabilities: { sms: true, voice: true } };
    },
  })) as TwilioClientLike['incomingPhoneNumbers'] & object;
  Object.assign(incoming as object, {
    create: async (params: { phoneNumber: string; smsUrl?: string; voiceUrl?: string }) => {
      created.push(params);
      return { sid: 'PN123', phoneNumber: params.phoneNumber, capabilities: { sms: true, voice } };
    },
    list: async (params: { phoneNumber: string }) => {
      listed.push(params);
      return [{ sid: 'PN123', phoneNumber: params.phoneNumber, capabilities: { sms: true, voice } }];
    },
  });
  const client: TwilioClientLike = {
    messages: {
      create: async () => ({ sid: 'SM123', status: 'accepted', dateCreated: new Date() }),
    },
    availablePhoneNumbers: () => ({
      local: {
        list: async () => [
          { phoneNumber: '+15550109001', capabilities: { sms: true, voice } },
        ],
      },
    }),
    incomingPhoneNumbers: incoming as TwilioClientLike['incomingPhoneNumbers'],
  };
  return { client, created, updated, listed };
}

describe('TwilioMessagingDriver — pool-number provisioning (M1.7)', () => {
  it('searches, purchases, pre-wires SmsUrl + VoiceUrl, and returns voice+sms capabilities', async () => {
    const { client, created } = makeFakeProvisioningClient({ voice: true });
    const driver = new TwilioMessagingDriver({
      accountSid: 'ACtest',
      apiKeySid: 'SKtest',
      apiKeySecret: 'secret',
      messagingServiceSid: 'MGtest',
      publicBaseUrl: 'https://dxxxx.cloudfront.example',
      client,
      logger: createLogger({ destination: createLogCapture().stream }),
    });
    const result = await driver.provisionPhoneNumber({ voiceCapable: true });
    expect(result.phoneNumber).toBe('+15550109001');
    expect(result.capabilities).toEqual({ sms: true, voice: true });
    expect(result.sid).toBe('PN123');
    // Pre-wired both webhooks at purchase.
    expect(created[0]).toMatchObject({
      phoneNumber: '+15550109001',
      smsUrl: 'https://dxxxx.cloudfront.example/webhooks/twilio/sms',
      voiceUrl: 'https://dxxxx.cloudfront.example/webhooks/twilio/voice',
    });
  });

  it('throws VoiceCapabilityError when the purchased number lacks voice', async () => {
    const { client } = makeFakeProvisioningClient({ voice: false });
    const driver = new TwilioMessagingDriver({
      accountSid: 'ACtest',
      apiKeySid: 'SKtest',
      apiKeySecret: 'secret',
      messagingServiceSid: 'MGtest',
      client,
      logger: createLogger({ destination: createLogCapture().stream }),
    });
    const { VoiceCapabilityError } = await import('../src/adapters/messaging.js');
    await expect(driver.provisionPhoneNumber({ voiceCapable: true })).rejects.toBeInstanceOf(
      VoiceCapabilityError,
    );
  });

  it('setVoiceWebhook resolves the resource SID then updates VoiceUrl', async () => {
    const { client, updated } = makeFakeProvisioningClient();
    const driver = new TwilioMessagingDriver({
      accountSid: 'ACtest',
      apiKeySid: 'SKtest',
      apiKeySecret: 'secret',
      messagingServiceSid: 'MGtest',
      client,
      logger: createLogger({ destination: createLogCapture().stream }),
    });
    await driver.setVoiceWebhook('+15550109001', 'https://x.example/webhooks/twilio/voice');
    expect(updated).toEqual([{ sid: 'PN123', params: { voiceUrl: 'https://x.example/webhooks/twilio/voice' } }]);
  });

  it('passes `from` straight through to messages.create (relay fan-out pins the pool number)', async () => {
    const { client, created } = makeFakeTwilioClient();
    const driver = new TwilioMessagingDriver({
      accountSid: 'ACtest',
      apiKeySid: 'SKtest',
      apiKeySecret: 'secret',
      messagingServiceSid: 'MGtest',
      client,
      logger: createLogger({ destination: createLogCapture().stream }),
    });
    await driver.sendMessage({ to: '+15550100002', from: '+15550109001', body: 'relayed' });
    expect(created[0]).toMatchObject({
      to: '+15550100002',
      from: '+15550109001',
      messagingServiceSid: 'MGtest',
    });
  });
});

describe('ConsoleMessagingDriver — provisioning (M1.7)', () => {
  it('returns a deterministic voice+sms-capable number with a PN sid, never hits Twilio', async () => {
    const driver = new ConsoleMessagingDriver({
      logger: createLogger({ destination: createLogCapture().stream }),
    });
    const a = await driver.provisionPhoneNumber({ voiceCapable: true });
    const b = await driver.provisionPhoneNumber({ voiceCapable: true });
    expect(a.capabilities).toEqual({ sms: true, voice: true });
    expect(a.phoneNumber).toMatch(/^\+1555010\d{4}$/);
    expect(a.sid).toMatch(/^PNconsole-/);
    expect(a.phoneNumber).not.toBe(b.phoneNumber); // deterministic, monotonic
    await expect(driver.setVoiceWebhook('+15550100001', 'https://x/voice')).resolves.toBeUndefined();
  });

  it('echoes `from` in the send (relay path)', async () => {
    const capture = createLogCapture();
    const driver = new ConsoleMessagingDriver({ logger: createLogger({ destination: capture.stream }) });
    await driver.sendMessage({ to: '+15550100002', from: '+15550109001', body: 'x' });
    expect(capture.lines[0]!['from']).toBe('+15550109001');
  });
});
