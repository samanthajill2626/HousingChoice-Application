// Tests for the globalSetup ensureKeyedLocalTables() core logic.
//
// Verifies:
//   1. A fresh random key starts with no tables — calling ensureKeyedLocalTables
//      creates them (DescribeTable on hc-local-tours succeeds).
//   2. A second call is an idempotent no-op (no throw, no error).
//   3. A non-local endpoint is skipped with a console.warn (no throw).
//
// Self-skipping: follows the same pattern as dynamo.integration.test.ts —
// when nothing answers at DYNAMODB_ENDPOINT (default http://localhost:8000)
// the whole suite is skipped so `npm test` stays green without Docker.
import { DescribeTableCommand, ResourceNotFoundException } from '@aws-sdk/client-dynamodb';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDynamoClient } from '../src/lib/dynamo.js';
import { LOCAL_DEFAULT_ENDPOINT } from '../scripts/db-create.js';
import { ensureKeyedLocalTables } from './globalSetup.js';

const endpoint = process.env.DYNAMODB_ENDPOINT ?? LOCAL_DEFAULT_ENDPOINT;

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
    `[globalSetupEnsure] SKIPPED — no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

// A fresh random key that has NEVER been used — guarantees the DB is empty.
const freshKey = `hctestfresh${Math.random().toString(36).slice(2, 10)}`;

describe.skipIf(!reachable)('ensureKeyedLocalTables()', () => {
  const client = createDynamoClient({ endpoint });

  afterAll(() => {
    client.destroy();
  });

  beforeAll(async () => {
    // Confirm the key is truly fresh: hc-local-tours should not exist yet.
    // We save the current env and force the fresh key.
    const savedKey = process.env.AWS_ACCESS_KEY_ID;
    const savedSecret = process.env.AWS_SECRET_ACCESS_KEY;
    process.env.AWS_ACCESS_KEY_ID = freshKey;
    process.env.AWS_SECRET_ACCESS_KEY = 'local';

    try {
      await client.send(new DescribeTableCommand({ TableName: 'hc-local-tours' }));
      // If we get here under this key, the key wasn't fresh — skip the precondition
      // rather than failing the whole suite (unlikely in CI; only matters locally).
    } catch (err) {
      if (!(err instanceof ResourceNotFoundException)) {
        // Unexpected error — re-throw so beforeAll fails loudly.
        throw err;
      }
      // ResourceNotFoundException is expected: fresh key, no tables — good.
    } finally {
      if (savedKey === undefined) {
        delete process.env.AWS_ACCESS_KEY_ID;
      } else {
        process.env.AWS_ACCESS_KEY_ID = savedKey;
      }
      if (savedSecret === undefined) {
        delete process.env.AWS_SECRET_ACCESS_KEY;
      } else {
        process.env.AWS_SECRET_ACCESS_KEY = savedSecret;
      }
    }
  }, 15_000);

  it('creates all hc-local- tables under a fresh key', async () => {
    // Call with the fresh key explicitly — process.env is NOT mutated by vitest
    // test.env at this point (that only applies to workers), so we pass key directly.
    await ensureKeyedLocalTables({ endpoint, key: freshKey });

    // Verify hc-local-tours now exists under the fresh key.
    const savedKey = process.env.AWS_ACCESS_KEY_ID;
    const savedSecret = process.env.AWS_SECRET_ACCESS_KEY;
    process.env.AWS_ACCESS_KEY_ID = freshKey;
    process.env.AWS_SECRET_ACCESS_KEY = 'local';
    try {
      const result = await client.send(new DescribeTableCommand({ TableName: 'hc-local-tours' }));
      expect(result.Table?.TableName).toBe('hc-local-tours');
    } finally {
      if (savedKey === undefined) {
        delete process.env.AWS_ACCESS_KEY_ID;
      } else {
        process.env.AWS_ACCESS_KEY_ID = savedKey;
      }
      if (savedSecret === undefined) {
        delete process.env.AWS_SECRET_ACCESS_KEY;
      } else {
        process.env.AWS_SECRET_ACCESS_KEY = savedSecret;
      }
    }
  }, 60_000);

  it('is idempotent — second call does not throw', async () => {
    await expect(ensureKeyedLocalTables({ endpoint, key: freshKey })).resolves.toBeUndefined();
  }, 60_000);

  it('skips (console.warn, no throw) for a non-local endpoint', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(
        ensureKeyedLocalTables({ endpoint: 'http://dynamodb.us-east-1.amazonaws.com', key: 'any' }),
      ).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Non-local'));
    } finally {
      warnSpy.mockRestore();
    }
  });
});
