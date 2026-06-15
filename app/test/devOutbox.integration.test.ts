// Integration test for /__dev/outbox and /__dev/reseed against DynamoDB Local.
//
// Self-skipping: follows the same pattern as dynamo.integration.test.ts —
// when nothing answers at DYNAMODB_ENDPOINT (default http://localhost:8000),
// the whole suite is skipped so `npm test` stays green without Docker.
// Start the container with `npm run db:start` to make this suite run for real.
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { createDevRouter } from '../src/routes/dev.js';
import { RecordingMessagingDriver } from '../src/adapters/recordingMessaging.js';
import type { MessagingAdapter } from '../src/adapters/messaging.js';
import { loadConfig } from '../src/lib/config.js';

const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';

async function endpointReachable(): Promise<boolean> {
  try {
    await fetch(endpoint, { signal: AbortSignal.timeout(1_500) });
    return true;
  } catch {
    return false;
  }
}

const reachable = await endpointReachable();
if (!reachable) {
  console.warn(
    `[devOutbox.integration] SKIPPED — no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

const SECRET = 's';
const config = loadConfig({
  NODE_ENV: 'test',
  DEV_AUTH_ENABLED: '1',
  MESSAGING_RECORD_OUTBOX: '1',
  CF_ORIGIN_SECRET: SECRET,
  DYNAMODB_ENDPOINT: endpoint,
  TABLE_PREFIX: 'hc-local-',
});

const fakeInner: MessagingAdapter = {
  sendMessage: async (p) => ({ providerSid: `SMt-${p.idempotencyKey ?? 'x'}`, status: 'sent', providerTs: new Date().toISOString() }),
  getMediaStream: async () => { throw new Error('n/a'); },
  getRecordingStream: async () => { throw new Error('n/a'); },
  provisionPhoneNumber: async () => { throw new Error('n/a'); },
  setVoiceWebhook: async () => {},
  initiateCall: async () => { throw new Error('n/a'); },
};

describe.skipIf(!reachable)('/__dev/outbox + /__dev/reseed (integration)', () => {
  it('records a send, lists it via /__dev/outbox, then /__dev/reseed clears it', async () => {
    const app = buildApp({ config, devRouter: createDevRouter({ config }) });
    const driver = new RecordingMessagingDriver({ inner: fakeInner, config });
    const to = `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
    await driver.sendMessage({ to, body: 'outbox e2e', idempotencyKey: 'z1' });

    const list = await request(app).get(`/__dev/outbox?to=${encodeURIComponent(to)}`);
    expect(list.status).toBe(200);
    expect(list.body.messages.some((m: { body?: string }) => m.body === 'outbox e2e')).toBe(true);

    const reset = await request(app).post('/__dev/reseed');
    expect(reset.status).toBe(200);

    const after = await request(app).get(`/__dev/outbox?to=${encodeURIComponent(to)}`);
    expect(after.body.messages).toHaveLength(0);
  });
});
