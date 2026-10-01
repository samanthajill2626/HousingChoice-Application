// Tests for the globalSetup ensureKeyedLocalTables() core logic.
//
// Verifies:
//   1. An EMPTY key (this suite's own, emptied first) gets every table -
//      calling ensureKeyedLocalTables creates them (hc-local-tours among them).
//   2. A second call is an idempotent no-op (no throw, no error).
//   3. A non-local endpoint is skipped with a console.warn (no throw).
//
// Self-skipping: follows the same pattern as dynamo.integration.test.ts —
// when nothing answers at DYNAMODB_ENDPOINT (default http://localhost:8000)
// the whole suite is skipped so `npm test` stays green without Docker.
import {
  DeleteTableCommand,
  ListTablesCommand,
  waitUntilTableNotExists,
} from '@aws-sdk/client-dynamodb';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { testAccessKeyId } from '../../e2e/support/lane.mjs';
import { createDynamoClient } from '../src/lib/dynamo.js';
import { isLocalEndpoint, LOCAL_DEFAULT_ENDPOINT } from '../scripts/db-create.js';
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

/**
 * hc:dynamo-lane worktree-derived-keys
 *
 * NOT random. DynamoDB Local opens a database - a SQLite connection plus four
 * threads that live until the JVM exits - for every access key it sees, and
 * dropping a key's tables does not close it: no API can. This suite used to
 * mint TWO random keys per run, the one per-RUN source of new databases among
 * the test keys (measured 2026-10-01: 67 -> 69 -> 71 -> 73 databases over four
 * runs; test time creeps with the count). See
 * docs/issues/dynamodb-local-slows-after-sustained-concurrent-load.md.
 *
 * NOT a fixed literal either: each run empties its keys first, so two worktrees
 * sharing one would wreck each other's runs. Derived from the WORKTREE identity
 * - the same answer dynamoKeyLedger.test.ts reached for its probe key - so the
 * cost is two databases per worktree, bounded, and never shared. The marker
 * above tells dynamoAccessKeyGuard.test.ts this is the mechanism in use.
 * "Empty" is now a precondition the suite ESTABLISHES (emptyKey) and then
 * asserts, instead of a property a never-seen random key happened to have.
 */
const freshKey = `${testAccessKeyId()}fresh`;
const dropKey = `${testAccessKeyId()}drop`;

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

/** Every table name in `key`'s own database (paged - never trust one page). */
async function tablesUnderKey(key: string): Promise<string[]> {
  const client = clientForKey(key);
  try {
    const names: string[] = [];
    let start: string | undefined;
    do {
      const out = await client.send(new ListTablesCommand({ ExclusiveStartTableName: start }));
      names.push(...(out.TableNames ?? []));
      start = out.LastEvaluatedTableName;
    } while (start !== undefined);
    return names;
  } finally {
    client.destroy();
  }
}

/**
 * Delete EVERY table under one of this suite's own keys - the precondition that
 * replaced "a random key has never been used". A killed earlier run can leave
 * tables under a fixed key, so each run empties its keys before relying on them.
 *
 * Deliberately NOT dropKeyedLocalTables (nor dropAllTables, which it wraps):
 * those are what this suite TESTS, and a precondition built on the code under
 * test would let a broken drop hide itself. Local only - it deletes.
 */
async function emptyKey(key: string): Promise<void> {
  if (!isLocalEndpoint(endpoint)) {
    throw new Error(`[globalSetupEnsure] refusing to empty ${key} on non-local ${endpoint}`);
  }
  const names = await tablesUnderKey(key);
  const client = clientForKey(key);
  try {
    for (const name of names) {
      await client.send(new DeleteTableCommand({ TableName: name }));
      await waitUntilTableNotExists({ client, maxWaitTime: 60 }, { TableName: name });
    }
  } finally {
    client.destroy();
  }
}

describe.skipIf(!reachable)('ensureKeyedLocalTables()', () => {
  afterAll(async () => {
    // Drop what this suite created, so its databases sit EMPTY between runs. The
    // keys are fixed now, so nothing is stranded either way - the next run would
    // empty them - but an empty database is the cheapest kind to keep alive.
    await dropKeyedLocalTables({ endpoint, key: freshKey });
  }, 60_000);

  beforeAll(async () => {
    // Establish, then REQUIRE, an empty key - asked through a client BOUND to
    // freshKey. (Before 2026-08-16 this asked the worktree key's database, where
    // hc-local-tours always exists, so the test could not fail.)
    await emptyKey(freshKey);
    expect(await tablesUnderKey(freshKey)).toEqual([]);
  }, 60_000);

  it('creates all hc-local- tables under an empty key', async () => {
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
    // Rebuild under the suite's second key so this cannot race the tests above,
    // and empty it first (a killed run can leave tables under a fixed key).
    await emptyKey(dropKey);

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
