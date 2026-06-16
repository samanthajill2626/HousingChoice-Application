// app/test/messagingApiBaseUrl.test.ts
import { describe, expect, it, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createMessagingAdapter } from '../src/adapters/messaging.js';
import { loadConfig } from '../src/lib/config.js';

let server: Server | undefined;
afterEach(() => server?.close());

describe('messaging driver honors TWILIO_API_BASE_URL', () => {
  it('sends messages.create to the fake host when apiBaseUrl is set', async () => {
    let hitPath = '';
    server = createServer((req, res) => {
      hitPath = req.url ?? '';
      res.statusCode = 201;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ sid: 'SMfake1', status: 'queued', date_created: 'Sun, 15 Jun 2026 14:00:00 +0000' }));
    });
    await new Promise<void>((r) => server!.listen(0, r));
    const addr = server!.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');

    const config = loadConfig({
      NODE_ENV: 'test',
      CF_ORIGIN_SECRET: 's',
      MESSAGING_DRIVER: 'twilio',
      TWILIO_ACCOUNT_SID: 'ACtest',
      TWILIO_API_KEY_SID: 'SKtest',
      TWILIO_API_KEY_SECRET: 'secret',
      TWILIO_AUTH_TOKEN: 'token',
      TWILIO_MESSAGING_SERVICE_SID: 'MGtest',
      TWILIO_API_BASE_URL: `http://127.0.0.1:${addr.port}`,
      OUR_PHONE_NUMBERS: '+15550009999',
      // The A2P kill-switch defaults OFF for the twilio driver; enable it so the
      // send reaches the (redirected) REST call this test is asserting on.
      SMS_SENDING_ENABLED: 'true',
    });
    const adapter = createMessagingAdapter({ config });
    const result = await adapter.sendMessage({ to: '+15550100001', body: 'hi', idempotencyKey: 'k1' });

    expect(result.providerSid).toBe('SMfake1');
    expect(hitPath).toContain('/2010-04-01/Accounts/ACtest/Messages.json');
  });
});
