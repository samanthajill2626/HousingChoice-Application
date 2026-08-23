// Guard suite for the per-file DynamoDB Local residue sweep.
//
// The gap this covers, measured 2026-08-23 on a CLEAN, GREEN, uninterrupted
// run: `app/test/setup/dynamoAccessKey.ts` gives each test FILE its own access
// key and therefore its own database, while `globalTeardown` ran under ONE key.
// A suite whose own drop never happens (a crash, a timeout, Ctrl-C) left its
// throwaway tables in a database nothing could reach, and DynamoDB Local can
// neither enumerate nor drop a database.
//
// The two claims worth pinning are the two that make the sweep work at all:
//   1. building a local client RECORDS its key, so the sweep knows where to look
//      (walking every per-file key instead would materialise ~327 databases -
//      see app/test/helpers/dynamoKeyLedger.ts for the measurements);
//   2. the sweep really reaches a table under a key that is NOT this run's key,
//      and prunes the marker afterwards so the ledger stays bounded.
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { LEDGER_ENV_VAR, forgetLedgerKey, readLedgerKeys } from './helpers/dynamoKeyLedger.js';
import { ensureKeyedLocalTables } from './globalSetup.js';
import { dropKeyedLocalTables, sweepLedgerResidue } from './globalTeardown.js';

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
  console.warn(`[dynamoKeyLedger] SKIPPED - no DynamoDB Local at ${endpoint}.`);
}

/**
 * FIXED, never random. A random key per run would strand one database per run
 * forever - DynamoDB Local has no way to drop one, and -inMemory only reclaims
 * on container stop. This is the same rule `fileAccessKeyId` follows, and this
 * suite would be a poor place to break it.
 */
const PROBE_KEY = 'hcledgersweepprobe';
const PROBE_PREFIX = 'hc-test-ledgerprobe-';

describe('dynamo key ledger', () => {
  let dir: string;
  let prevLedger: string | undefined;
  let prevKey: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'hc-ledger-'));
    prevLedger = process.env[LEDGER_ENV_VAR];
    prevKey = process.env.AWS_ACCESS_KEY_ID;
  });

  afterEach(() => {
    if (prevLedger === undefined) delete process.env[LEDGER_ENV_VAR];
    else process.env[LEDGER_ENV_VAR] = prevLedger;
    if (prevKey === undefined) delete process.env.AWS_ACCESS_KEY_ID;
    else process.env.AWS_ACCESS_KEY_ID = prevKey;
    rmSync(dir, { recursive: true, force: true });
  });

  it('records the access key when a client is built against a local endpoint', () => {
    process.env[LEDGER_ENV_VAR] = dir;
    // A key this process has not seen: recordLocalKeyUse memoises per key, and
    // the file's own key was already recorded when this module was imported.
    process.env.AWS_ACCESS_KEY_ID = 'hcledgerrecordprobe';

    createDynamoClient({ endpoint }).destroy();

    expect(readLedgerKeys(dir)).toContain('hcledgerrecordprobe');
  });

  it('records NOTHING when the ledger env var is unset - the deployed shape', () => {
    delete process.env[LEDGER_ENV_VAR];
    process.env.AWS_ACCESS_KEY_ID = 'hcledgerunsetprobe';

    createDynamoClient({ endpoint }).destroy();

    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuses a key that is not plain alphanumeric - it becomes a filename', () => {
    process.env[LEDGER_ENV_VAR] = dir;
    process.env.AWS_ACCESS_KEY_ID = '../../escaped';

    createDynamoClient({ endpoint }).destroy();

    expect(readdirSync(dir)).toEqual([]);
  });

  describe.skipIf(!reachable)('sweeping a database this run does not own', () => {
    afterAll(async () => {
      // Belt and braces: if an assertion below fails before the sweep, do not
      // leave the very kind of table this suite exists to eliminate.
      const prev = process.env.AWS_ACCESS_KEY_ID;
      process.env.AWS_ACCESS_KEY_ID = PROBE_KEY;
      const client = createDynamoClient({ endpoint });
      try {
        await deleteTableIfExists(client, `${PROBE_PREFIX}contacts`);
      } finally {
        client.destroy();
        if (prev === undefined) delete process.env.AWS_ACCESS_KEY_ID;
        else process.env.AWS_ACCESS_KEY_ID = prev;
      }
    }, 60_000);

    it('deletes the leaked table and prunes the marker', async () => {
      // Leave a throwaway table under a key that is NOT this file's key -
      // standing in for a suite that died before its own afterAll.
      process.env.AWS_ACCESS_KEY_ID = PROBE_KEY;
      const probeClient = createDynamoClient({ endpoint });
      try {
        await ensureTable(probeClient, getTableSpec('contacts'), `${PROBE_PREFIX}contacts`);
        const before = await probeClient.send(new ListTablesCommand({}));
        expect(before.TableNames).toContain(`${PROBE_PREFIX}contacts`);
      } finally {
        probeClient.destroy();
      }

      // Back to this file's own key: the sweep must reach across, not rely on
      // the caller happening to hold the right credentials.
      if (prevKey === undefined) delete process.env.AWS_ACCESS_KEY_ID;
      else process.env.AWS_ACCESS_KEY_ID = prevKey;

      writeFileSync(path.join(dir, PROBE_KEY), '');
      const result = await sweepLedgerResidue(endpoint, { dir });

      expect(result.keys).toBe(1);
      expect(result.tables).toBe(1);
      expect(existsSync(path.join(dir, PROBE_KEY))).toBe(false);

      process.env.AWS_ACCESS_KEY_ID = PROBE_KEY;
      const check = createDynamoClient({ endpoint });
      try {
        const after = await check.send(new ListTablesCommand({}));
        expect(after.TableNames ?? []).not.toContain(`${PROBE_PREFIX}contacts`);
      } finally {
        check.destroy();
      }
    }, 60_000);
  });

  describe.skipIf(!reachable)('the ledger sweep stays out of the reusable core', () => {
    // REGRESSION GUARD, and this one was earned. `ensureKeyedLocalTables` and
    // `dropKeyedLocalTables` are exported, and globalSetupEnsure.test.ts calls
    // them with a throwaway key WHILE THE REST OF THE SUITE IS RUNNING. Every
    // other thing they do is confined to the key they were handed; a ledger
    // sweep is not - it reaches every database this worktree has open. Wiring
    // it into them deleted 43 live tables out from under concurrently running
    // suites and failed performanceSeed.integration.test.ts, whose
    // `hc-local-<lane>-` prefix is one of the residue families.
    //
    // The sweep therefore belongs only to globalSetup's run-level entry points.
    // Nothing else would notice if it moved back: the symptom is a DIFFERENT
    // file failing, intermittently, with no pointer to the cause.
    const GUARD_KEY = 'hctestledgercoreguard';
    const BYSTANDER_KEY = 'hcledgercoreprobe';
    const BYSTANDER_TABLE = 'hc-test-ledgercoreprobe-contacts';

    async function bystanderExists(): Promise<boolean> {
      const prev = process.env.AWS_ACCESS_KEY_ID;
      process.env.AWS_ACCESS_KEY_ID = BYSTANDER_KEY;
      const c = createDynamoClient({ endpoint });
      try {
        const { TableNames } = await c.send(new ListTablesCommand({}));
        return (TableNames ?? []).includes(BYSTANDER_TABLE);
      } finally {
        c.destroy();
        if (prev === undefined) delete process.env.AWS_ACCESS_KEY_ID;
        else process.env.AWS_ACCESS_KEY_ID = prev;
      }
    }

    it('ensure/drop leave a bystander database alone even when its key is on the ledger', async () => {
      // A table under a key that is NOT the one ensure/drop are given, with a
      // marker on the REAL ledger saying so - i.e. a live suite's database.
      process.env.AWS_ACCESS_KEY_ID = BYSTANDER_KEY;
      const bystander = createDynamoClient({ endpoint });
      try {
        await ensureTable(bystander, getTableSpec('contacts'), BYSTANDER_TABLE);
      } finally {
        bystander.destroy();
      }
      if (prevKey === undefined) delete process.env.AWS_ACCESS_KEY_ID;
      else process.env.AWS_ACCESS_KEY_ID = prevKey;

      // createDynamoClient above already recorded BYSTANDER_KEY on the real
      // ledger, which is exactly the state a live suite would leave.
      expect(readLedgerKeys()).toContain(BYSTANDER_KEY);

      try {
        await ensureKeyedLocalTables({ endpoint, key: GUARD_KEY });
        expect(await bystanderExists(), 'ensureKeyedLocalTables swept the ledger').toBe(true);

        await dropKeyedLocalTables({ endpoint, key: GUARD_KEY });
        expect(await bystanderExists(), 'dropKeyedLocalTables swept the ledger').toBe(true);
      } finally {
        // Leave nothing behind: this file must not be the thing that leaks.
        process.env.AWS_ACCESS_KEY_ID = BYSTANDER_KEY;
        const cleanup = createDynamoClient({ endpoint });
        try {
          await deleteTableIfExists(cleanup, BYSTANDER_TABLE);
        } finally {
          cleanup.destroy();
          if (prevKey === undefined) delete process.env.AWS_ACCESS_KEY_ID;
          else process.env.AWS_ACCESS_KEY_ID = prevKey;
        }
        forgetLedgerKey(BYSTANDER_KEY);
        forgetLedgerKey(GUARD_KEY);
      }
    }, 120_000);
  });

  it('forgetLedgerKey ignores a key that is not plain alphanumeric', () => {
    const victim = path.join(dir, 'keep-me');
    writeFileSync(victim, '');
    forgetLedgerKey('keep-me', dir);
    expect(existsSync(victim)).toBe(true);
  });
});
