// Integration test for RecordingMessagingDriver against DynamoDB Local.
//
// Self-skipping: follows the same pattern as dynamo.integration.test.ts —
// when nothing answers at DYNAMODB_ENDPOINT (default http://localhost:8000),
// the whole suite is skipped so `npm test` stays green without Docker.
// Start the container with `npm run db:start` to make this suite run for real.
import { describe, expect, it } from 'vitest';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { RecordingMessagingDriver, OUTBOX_TABLE_BASE } from '../src/adapters/recordingMessaging.js';
import type { MessagingAdapter } from '../src/adapters/messaging.js';
import { loadConfig, tableName } from '../src/lib/config.js';
import { createDocumentClient } from '../src/lib/dynamo.js';

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
    `[recordingMessaging.integration] SKIPPED — no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

const config = loadConfig({
  NODE_ENV: 'test',
  CF_ORIGIN_SECRET: 's',
  DYNAMODB_ENDPOINT: endpoint,
  TABLE_PREFIX: 'hc-local-',
});

const fakeInner: MessagingAdapter = {
  sendMessage: async (p) => ({ providerSid: `SMtest-${p.idempotencyKey ?? 'x'}`, status: 'sent', providerTs: '2026-06-15T00:00:00.000Z' }),
  getMediaStream: async () => { throw new Error('n/a'); },
  getRecordingStream: async () => { throw new Error('n/a'); },
  provisionPhoneNumber: async () => { throw new Error('n/a'); },
  setVoiceWebhook: async () => {},
  initiateCall: async () => { throw new Error('n/a'); },
  createViTranscript: async () => { throw new Error('n/a'); },
  fetchViTranscript: async () => { throw new Error('n/a'); },
  listViSentences: async () => { throw new Error('n/a'); },
};

describe.skipIf(!reachable)('RecordingMessagingDriver (integration)', () => {
  it('delegates to inner and persists the send to the outbox table', async () => {
    const driver = new RecordingMessagingDriver({ inner: fakeInner, config });
    const to = `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
    const res = await driver.sendMessage({ to, body: 'hello outbox', idempotencyKey: 'k1' });
    expect(res.providerSid).toBe('SMtest-k1'); // delegated to inner

    const doc = createDocumentClient({ config });
    const scan = await doc.send(new ScanCommand({ TableName: tableName(OUTBOX_TABLE_BASE) }));
    const mine = (scan.Items ?? []).filter((m) => m['to'] === to);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ to, body: 'hello outbox', providerSid: 'SMtest-k1', status: 'sent' });
  });
});
