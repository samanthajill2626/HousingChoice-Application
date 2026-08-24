// Integration test for RecordingMessagingDriver against DynamoDB Local.
//
// THROWAWAY PREFIX - this suite deliberately carries NO shared-tables marker
// (changed 2026-08-23; the marker is named in setup/dynamoAccessKey.ts, and is
// deliberately not spelled out here: an early draft of this comment quoted it
// verbatim and the substring match silently re-opted the file into the shared
// key it was escaping). The suite used to pin itself to the worktree key and
// the shared `hc-local-dev-outbox` table - which /__dev/reseed CLEARS
// (devReset.ts wipes `[...TABLES, OUTBOX_TABLE_BASE]`), and
// devOutbox.integration.test.ts calls /__dev/reseed from the same shared key.
// Vitest runs files in parallel, so a reseed landing between this suite's
// write and its scan turned `toHaveLength(1)` into 0 - a latent cross-file
// race that only needed an unlucky interleaving.
//
// The driver creates its outbox table ON DEMAND from the injected config's
// tablePrefix, so this suite never needed the globalSetup bootstrap at all.
// A per-run `hc-test-` prefix gives it its own table in its own per-file
// database; the afterAll drops it, and a crashed run's leftover is covered by
// the residue sweep (RESIDUE_PREFIXES matches `hc-test-`).
//
// Self-skipping: follows the same pattern as dynamo.integration.test.ts —
// when nothing answers at DYNAMODB_ENDPOINT (default http://localhost:8000),
// the whole suite is skipped so `npm test` stays green without Docker.
// Start the container with `npm run db:start` to make this suite run for real.
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { RecordingMessagingDriver, OUTBOX_TABLE_BASE } from '../src/adapters/recordingMessaging.js';
import type { MessagingAdapter } from '../src/adapters/messaging.js';
import { loadConfig, tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists } from '../src/lib/dynamoAdmin.js';

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

const testEnv = { TABLE_PREFIX: `hc-test-outbox-${randomUUID().slice(0, 8)}-` };

const config = loadConfig({
  NODE_ENV: 'test',
  CF_ORIGIN_SECRET: 's',
  DYNAMODB_ENDPOINT: endpoint,
  TABLE_PREFIX: testEnv.TABLE_PREFIX,
});

const fakeInner: MessagingAdapter = {
  sendMessage: async (p) => ({ providerSid: `SMtest-${p.idempotencyKey ?? 'x'}`, status: 'sent', providerTs: '2026-06-15T00:00:00.000Z' }),
  getMediaStream: async () => { throw new Error('n/a'); },
  getRecordingStream: async () => { throw new Error('n/a'); },
  provisionPhoneNumber: async () => { throw new Error('n/a'); },
  setVoiceWebhook: async () => {},
  releasePhoneNumber: async () => {},
  attachToMessagingService: async () => {},
  detachFromMessagingService: async () => {},
  initiateCall: async () => { throw new Error('n/a'); },
  createViTranscript: async () => { throw new Error('n/a'); },
  fetchViTranscript: async () => { throw new Error('n/a'); },
  listViSentences: async () => { throw new Error('n/a'); },
};

describe.skipIf(!reachable)('RecordingMessagingDriver (integration)', () => {
  it.skipIf(process.env.HC_TEST_EXPLICIT_ACCESS_KEY)(
    'runs in its OWN per-file database, not the worktree key',
    () => {
      // The ENFORCED version of this file's isolation claim. The first draft
      // of this rewrite believed it had left the shared key and had not - its
      // own header comment quoted the opt-in marker, and the then-substring
      // matcher opted it back in. Every test here stayed green either way, so
      // only an assertion on the key itself can hold the property.
      expect(process.env.AWS_ACCESS_KEY_ID).toBeTruthy();
      expect(process.env.AWS_ACCESS_KEY_ID).not.toBe(process.env.HC_TEST_WORKTREE_ACCESS_KEY);
    },
  );

  afterAll(async () => {
    const client = createDynamoClient({ config });
    try {
      await deleteTableIfExists(client, tableName(OUTBOX_TABLE_BASE, testEnv));
    } finally {
      client.destroy();
    }
  }, 60_000);

  it('delegates to inner and persists the send to the outbox table the CONFIG names', async () => {
    const driver = new RecordingMessagingDriver({ inner: fakeInner, config });
    const to = `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
    const res = await driver.sendMessage({ to, body: 'hello outbox', idempotencyKey: 'k1' });
    expect(res.providerSid).toBe('SMtest-k1'); // delegated to inner

    // Scanned under the THROWAWAY prefix. This is also the regression pin for
    // the config-injection fix: the driver used to name its table from bare
    // process.env, so with an injected prefix this scan would hit a
    // just-created EMPTY table and fail 0 !== 1.
    const doc = createDocumentClient({ config });
    const scan = await doc.send(
      new ScanCommand({ TableName: tableName(OUTBOX_TABLE_BASE, testEnv) }),
    );
    const mine = (scan.Items ?? []).filter((m) => m['to'] === to);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ to, body: 'hello outbox', providerSid: 'SMtest-k1', status: 'sent' });
    doc.destroy();
  });
});
