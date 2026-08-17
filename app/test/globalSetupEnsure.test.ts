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
import {
  DescribeTableCommand,
  ListTablesCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDynamoClient } from '../src/lib/dynamo.js';
import { LOCAL_DEFAULT_ENDPOINT } from '../scripts/db-create.js';
import { ensureKeyedLocalTables } from './globalSetup.js';
import { dropKeyedLocalTables } from './globalTeardown.js';

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

/**
 * A client BOUND to `key`.
 *
 * The SDK resolves credentials at CONSTRUCTION, and with DynamoDB Local running
 * without -sharedDb the access key is what SELECTS WHICH DATABASE you reach. So
 * a client built under one key silently answers from that key's database no
 * matter what you set afterwards - mutating process.env around a call on an
 * already-built client does nothing at all.
 *
 * That was a live false pass here (found 2026-08-16): every assertion below used
 * one suite-level client built under this worktree's vitest key, where
 * hc-local-tours ALWAYS exists because globalSetup just made it. So
 * "creates all hc-local- tables under a fresh key" passed whether or not
 * creation under the fresh key had done anything - the one thing the test exists
 * to prove was the one thing it could not fail on.
 */
function clientForKey(key: string): ReturnType<typeof createDynamoClient> {
  const savedKey = process.env.AWS_ACCESS_KEY_ID;
  const savedSecret = process.env.AWS_SECRET_ACCESS_KEY;
  process.env.AWS_ACCESS_KEY_ID = key;
  process.env.AWS_SECRET_ACCESS_KEY = 'local';
  try {
    return createDynamoClient({ endpoint });
  } finally {
    if (savedKey === undefined) delete process.env.AWS_ACCESS_KEY_ID;
    else process.env.AWS_ACCESS_KEY_ID = savedKey;
    if (savedSecret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
    else process.env.AWS_SECRET_ACCESS_KEY = savedSecret;
  }
}

describe.skipIf(!reachable)('ensureKeyedLocalTables()', () => {
  afterAll(async () => {
    // MUST drop what this suite created. `freshKey` is random per run, so before
    // this existed every `npm test` stranded 22 tables under a key nobody could
    // ever name again - DynamoDB Local cannot enumerate databases, so they were
    // unreachable until an operator stopped the container. This suite was the
    // one source of genuinely PER-RUN accumulation (the worktree and lane keys
    // are stable and get reused).
    await dropKeyedLocalTables({ endpoint, key: freshKey });
  }, 60_000);

  beforeAll(async () => {
    // Confirm the key is truly fresh: hc-local-tours must not exist yet. Asked
    // through a client BOUND to freshKey - the previous version asked the
    // worktree key's database, where the answer is always "it exists".
    const probe = clientForKey(freshKey);
    try {
      await probe.send(new DescribeTableCommand({ TableName: 'hc-local-tours' }));
      // Reaching here means the key was not fresh - vanishingly unlikely with a
      // random suffix. Skip the precondition rather than failing the suite.
    } catch (err) {
      if (!(err instanceof ResourceNotFoundException)) {
        // Unexpected error — re-throw so beforeAll fails loudly.
        throw err;
      }
      // ResourceNotFoundException is expected: fresh key, no tables — good.
    } finally {
      probe.destroy();
    }
  }, 15_000);

  it('creates all hc-local- tables under a fresh key', async () => {
    // Call with the fresh key explicitly — process.env is NOT mutated by vitest
    // test.env at this point (that only applies to workers), so we pass key directly.
    await ensureKeyedLocalTables({ endpoint, key: freshKey });

    // Verify against freshKey's OWN database. Counting tables (rather than
    // describing one) also proves the whole manifest landed, not just that a
    // single name resolves somewhere.
    const keyed = clientForKey(freshKey);
    try {
      const listed = await keyed.send(new ListTablesCommand({}));
      const names = listed.TableNames ?? [];
      expect(names).toContain('hc-local-tours');
      expect(names.length).toBeGreaterThan(1);
    } finally {
      keyed.destroy();
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

  // The teardown half. It DELETES, so the local-endpoint guard matters more here
  // than on the create side.
  it('dropKeyedLocalTables REFUSES a non-local endpoint (it deletes)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(
        dropKeyedLocalTables({ endpoint: 'http://dynamodb.us-east-1.amazonaws.com', key: 'any' }),
      ).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('refusing to drop'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('dropKeyedLocalTables removes the tables ensure created, and is safe to repeat', async () => {
    // Rebuild under a second throwaway key so this cannot race the suite above.
    const dropKey = `hctestdrop${Math.random().toString(36).slice(2, 10)}`;

    const keyed = clientForKey(dropKey);
    const listUnderKey = async (): Promise<number> => {
      const out = await keyed.send(new ListTablesCommand({}));
      return (out.TableNames ?? []).length;
    };
    try {
      expect(await listUnderKey()).toBe(0);
      await ensureKeyedLocalTables({ endpoint, key: dropKey });
      expect(await listUnderKey()).toBeGreaterThan(0);

      await dropKeyedLocalTables({ endpoint, key: dropKey });
      expect(await listUnderKey()).toBe(0);

      // Idempotent: dropping an already-empty key must not throw (a killed run
      // can leave a key half-torn-down, and the next teardown has to cope).
      await expect(dropKeyedLocalTables({ endpoint, key: dropKey })).resolves.toBeUndefined();
      expect(await listUnderKey()).toBe(0);
    } finally {
      keyed.destroy();
    }
  }, 60_000);
});
