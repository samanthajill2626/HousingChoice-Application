// M1.1 unit tests: MessagingAdapter drivers + factory. No network calls —
// the Twilio driver gets a fake injected client (TwilioClientLike, same
// pattern as SchedulerClientLike in scheduler.test.ts).
import { describe, expect, it } from 'vitest';
import {
  ConsoleMessagingDriver,
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
    expect(loadConfig({ ...TWILIO_ENV, NODE_ENV: 'production', CF_ORIGIN_SECRET: 's', MESSAGING_DRIVER: undefined }).messagingDriver).toBe('twilio');
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
