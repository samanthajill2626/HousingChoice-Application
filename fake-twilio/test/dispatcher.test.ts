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
});
