// fake-twilio/test/dispatcher.test.ts
import { describe, expect, it, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import twilio from 'twilio';
import { WebhookDispatcher } from '../src/engine/dispatcher.js';
import { buildInboundSmsParams } from '../src/engine/signer.js';

let server: Server | undefined;
afterEach(() => server?.close());

describe('WebhookDispatcher', () => {
  it('POSTs a signed, form-encoded inbound SMS the app validator accepts', async () => {
    const TOKEN = 'shared-secret-token';
    let received: { path: string; sig: string; body: string } | undefined;
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        received = {
          path: req.url ?? '',
          sig: String(req.headers['x-twilio-signature'] ?? ''),
          body: Buffer.concat(chunks).toString('utf8'),
        };
        res.statusCode = 200;
        res.end('<Response/>');
      });
    });
    await new Promise<void>((r) => server!.listen(0, r));
    const addr = server!.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    const port = addr.port;

    const dispatcher = new WebhookDispatcher({
      appBaseUrl: `http://127.0.0.1:${port}`,
      appPublicBaseUrl: `http://127.0.0.1:${port}`,
      authToken: TOKEN,
    });
    const params = buildInboundSmsParams({ messageSid: 'SMin1', from: '+15550100001', to: '+15550009999', body: 'hi' });
    const status = await dispatcher.post('/webhooks/twilio/sms', params);

    expect(status).toBe(200);
    expect(received?.path).toBe('/webhooks/twilio/sms');
    // The app reconstructs `${appPublicBaseUrl}/webhooks/twilio/sms` and validates.
    const url = `http://127.0.0.1:${port}/webhooks/twilio/sms`;
    const parsed = Object.fromEntries(new URLSearchParams(received!.body));
    expect(twilio.validateRequest(TOKEN, received!.sig, url, parsed)).toBe(true);
  });

  it('postEventsBatch POSTs raw JSON with the origin secret and NO Twilio signature (T9 events sink)', async () => {
    let received:
      | { path: string; ct: string; origin: string; sig: string; body: string }
      | undefined;
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        received = {
          path: req.url ?? '',
          ct: String(req.headers['content-type'] ?? ''),
          origin: String(req.headers['x-origin-verify'] ?? ''),
          sig: String(req.headers['x-twilio-signature'] ?? ''),
          body: Buffer.concat(chunks).toString('utf8'),
        };
        res.statusCode = 200;
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((r) => server!.listen(0, r));
    const addr = server!.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    const port = addr.port;

    const dispatcher = new WebhookDispatcher({
      appBaseUrl: `http://127.0.0.1:${port}`,
      appPublicBaseUrl: `http://127.0.0.1:${port}`,
      authToken: 'unused-for-the-events-sink',
      originSecret: 'origin-xyz',
    });
    const batch = [
      {
        specversion: '1.0',
        type: 'com.twilio.messaging.compliance.number-registration.successful',
        data: { phonenumbersid: 'PNfake00000001' },
      },
    ];
    const status = await dispatcher.postEventsBatch('/webhooks/twilio/events', batch);

    expect(status).toBe(200);
    expect(received?.path).toBe('/webhooks/twilio/events');
    expect(received?.ct).toMatch(/application\/json/);
    expect(received?.origin).toBe('origin-xyz');
    // NOT the classic form-signature scheme (the events sink authorizes by
    // shared-secret / origin-verify, app T3) - so no X-Twilio-Signature is sent.
    expect(received?.sig).toBe('');
    expect(JSON.parse(received!.body)).toEqual(batch);
  });
});
