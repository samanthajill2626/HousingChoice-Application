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

// NODE_ENV=production fail-fasts without the M1.2 job-delivery wiring —
// production-shaped configs in this suite must carry it.
const JOB_DELIVERY_ENV = {
  JOBS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/000000000000/hc-test-jobs',
  SCHEDULER_TARGET_ARN: 'arn:aws:sqs:us-east-1:000000000000:hc-test-jobs',
  SCHEDULER_ROLE_ARN: 'arn:aws:iam::000000000000:role/hc-test-scheduler',
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
});
