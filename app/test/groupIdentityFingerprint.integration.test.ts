// The group-identity fingerprint's FIRST-WRITE RACE against DynamoDB Local.
//
// Deployed stacks run more than one instance, so two boots can claim the
// fingerprint at the same instant. The claim is a CONDITIONAL create (never the
// settings repo's unconditional upsert, which would let the second boot's list
// silently overwrite the first's and bless a changed identity contract). With
// two UNEQUAL lists racing, exactly one instance may start.
//
// Self-skipping like the other integration suites (`npm run db:start` to run it
// for real).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { createLogger } from '../src/lib/logger.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createSettingsRepo } from '../src/repos/settingsRepo.js';
import { verifyGroupIdentityFingerprint } from '../src/services/groupIdentityFingerprint.js';
import { createLogCapture } from './helpers/logCapture.js';

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
    `[groupIdentityFingerprint.integration] SKIPPED - no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

describe.skipIf(!reachable)('group identity fingerprint against DynamoDB Local', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const settings = createSettingsRepo({ doc, env: testEnv, logger });
  const table = tableName('settings', testEnv);

  // The fingerprint is a SINGLETON record, so the sequential-claim test needs a
  // settings table of its own rather than the one the race test has claimed.
  const soloEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const soloSettings = createSettingsRepo({ doc, env: soloEnv, logger });
  const soloTable = tableName('settings', soloEnv);

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('settings'), table);
    await ensureTable(client, getTableSpec('settings'), soloTable);
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, table);
    await deleteTableIfExists(client, soloTable);
    doc.destroy();
    client.destroy();
  }, 120_000);

  it('two concurrent UNEQUAL fingerprints: exactly one boots, the other throws', async () => {
    const listA = ['+15550001111'];
    const listB = ['+15550002222', '+15550003333'];
    const boot = (numbers: string[]) =>
      verifyGroupIdentityFingerprint({
        store: settings,
        excludedNumbers: numbers,
        deployed: true,
        logger,
      });

    const results = await Promise.allSettled([boot(listA), boot(listB)]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((fulfilled[0] as PromiseFulfilledResult<string>).value).toBe('created');
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(
      /GROUP_IDENTITY_EXCLUDED_NUMBERS/,
    );

    // The WINNER's list is what stays pinned: it reboots, the loser's does not.
    const winner = results[0]!.status === 'fulfilled' ? listA : listB;
    const loser = results[0]!.status === 'fulfilled' ? listB : listA;
    await expect(boot(winner)).resolves.toBe('matched');
    await expect(boot(loser)).rejects.toThrow(/GROUP_IDENTITY_EXCLUDED_NUMBERS/);
  });

  it('writes on first boot, matches on the next, and refuses a changed list', async () => {
    const numbers = ['+15550004444', '+15550005555'];
    const boot = (list: string[]) =>
      verifyGroupIdentityFingerprint({
        store: soloSettings,
        excludedNumbers: list,
        deployed: true,
        logger,
      });

    await expect(boot(numbers)).resolves.toBe('created');
    // Order is not semantic - the same SET must still match.
    await expect(boot([...numbers].reverse())).resolves.toBe('matched');
    await expect(boot([...numbers, '+15550006666'])).rejects.toThrow(/RUNBOOK/);
  });
});
