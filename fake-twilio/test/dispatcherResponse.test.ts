// fake-twilio/test/dispatcherResponse.test.ts
import { describe, expect, it, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import twilio from 'twilio';
import { WebhookDispatcher } from '../src/engine/dispatcher.js';
import { buildInboundVoiceParams } from '../src/engine/signer.js';

const TWIML = '<?xml version="1.0"?><Response><Hangup/></Response>';

let server: Server | undefined;
afterEach(() => server?.close());

describe('WebhookDispatcher.postForResponse', () => {
  it('returns the TwiML body for a signed voice webhook the app validator accepts', async () => {
    const TOKEN = 'shared-secret-token';
    let port = 0;
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        const sig = String(req.headers['x-twilio-signature'] ?? '');
        // The app reconstructs `${appPublicBaseUrl}${path}` and validates the signature.
        const url = `http://127.0.0.1:${port}${req.url ?? ''}`;
        const parsed = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
        if (!twilio.validateRequest(TOKEN, sig, url, parsed)) {
          res.statusCode = 403;
          res.end('forbidden');
          return;
        }
        res.statusCode = 200;
        res.setHeader('content-type', 'text/xml');
        res.end(TWIML);
      });
    });
    await new Promise<void>((r) => server!.listen(0, r));
    const addr = server!.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    port = addr.port;

    const dispatcher = new WebhookDispatcher({
      appBaseUrl: `http://127.0.0.1:${port}`,
      appPublicBaseUrl: `http://127.0.0.1:${port}`,
      authToken: TOKEN,
    });
    const params = buildInboundVoiceParams({ callSid: 'CA1', from: '+15550100001', to: '+15550199001' });
    const result = await dispatcher.postForResponse('/webhooks/twilio/voice', params);

    // 200 (not 403) proves the dispatcher signed correctly; body proves we read the TwiML.
    expect(result).toEqual({ status: 200, body: TWIML });
  });
});
