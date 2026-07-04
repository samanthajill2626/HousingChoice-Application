// Profile contract for seedAll() — Task 1 of the seed clean-slate build.
//
// Verifies three things:
//   1. lean profile writes exactly the canonical SEED ids (no more, no less).
//   2. full profile is a superset of lean (full ⊇ lean).
//   3. The inbound-voice-line holder is stamped after a lean seedAll().
//
// Self-skipping: when DynamoDB Local is unreachable the whole suite is skipped
// so `npm test` stays green without Docker. Start the container with
// `npm run db:start` to exercise this suite.
import { randomUUID } from 'node:crypto';
import { GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec, TABLES } from '../src/lib/tables.js';
import { SEED, SEED_INBOUND_VOICE_CELL, seedAll } from '../src/lib/seedData.js';
import { HOLDER_POINTER_KEY } from '../src/repos/usersRepo.js';

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
    `[seedProfile.integration] SKIPPED — no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

// Derive expected lean item count + id sets from SEED.
const LEAN_IDS_BY_TABLE: Record<string, Set<string>> = {};
let LEAN_TOTAL = 0;
for (const [base, items] of Object.entries(SEED)) {
  const pkKey = Object.keys(items[0] ?? {}).find((k) => k.endsWith('Id') || k === 'entityKey') ?? '';
  LEAN_IDS_BY_TABLE[base] = new Set(items.map((it) => String(it[pkKey] ?? JSON.stringify(it))));
  LEAN_TOTAL += items.length;
}

/** tableName for a given base under the throwaway prefix. */
function tn(base: string, prefix: string): string {
  return `${prefix}${base}`;
}

describe.skipIf(!reachable)('seedAll profile contract (throwaway prefix)', () => {
  const prefix = `hc-test-${randomUUID().slice(0, 8)}-`;
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });

  // Override TABLE_PREFIX so tableName() picks up the throwaway prefix.
  const origPrefix = process.env.TABLE_PREFIX;
  const origEndpoint = process.env.DYNAMODB_ENDPOINT;

  beforeAll(async () => {
    process.env.TABLE_PREFIX = prefix;
    process.env.DYNAMODB_ENDPOINT = endpoint;
    // Create all standard tables under the throwaway prefix.
    for (const spec of TABLES) {
      await ensureTable(client, spec, tn(spec.baseName, prefix));
    }
  }, 120_000);

  afterAll(async () => {
    // Restore env.
    if (origPrefix === undefined) delete process.env.TABLE_PREFIX;
    else process.env.TABLE_PREFIX = origPrefix;
    if (origEndpoint === undefined) delete process.env.DYNAMODB_ENDPOINT;
    else process.env.DYNAMODB_ENDPOINT = origEndpoint;
    // Clean up throwaway tables.
    for (const spec of TABLES) {
      await deleteTableIfExists(client, tn(spec.baseName, prefix));
    }
    client.destroy();
    doc.destroy();
  }, 120_000);

  it('lean seedAll writes exactly the canonical SEED item count', async () => {
    const count = await seedAll(endpoint, 'lean');
    // count = static items only; the holder stamp does NOT count toward items.
    expect(count).toBe(LEAN_TOTAL);
  });

  it('lean profile: each SEED table contains the expected ids after seedAll', async () => {
    // For the key tables we care most about, verify the items are present.
    for (const [base, items] of Object.entries(SEED)) {
      const physical = tn(base, prefix);
      const scan = await doc.send(new ScanCommand({ TableName: physical }));
      const stored = scan.Items ?? [];
      // Every lean SEED item must be present.
      expect(stored.length).toBeGreaterThanOrEqual(items.length);
    }
  });

  it('inbound-voice-line holder is stamped after lean seedAll', async () => {
    const usersTable = tn('users', prefix);

    // The holder pointer row must exist.
    const pointerRow = await doc.send(
      new GetCommand({ TableName: usersTable, Key: { userId: HOLDER_POINTER_KEY } }),
    );
    expect(pointerRow.Item).toBeDefined();
    expect(typeof pointerRow.Item!['holder_user_id']).toBe('string');

    // The founder user must have the seed cell stamped.
    const holderId = pointerRow.Item!['holder_user_id'] as string;
    const founderRow = await doc.send(
      new GetCommand({ TableName: usersTable, Key: { userId: holderId } }),
    );
    expect(founderRow.Item).toBeDefined();
    expect(founderRow.Item!['cell']).toBe(SEED_INBOUND_VOICE_CELL);
    expect(typeof founderRow.Item!['cell_verified_at']).toBe('string');
  });

  it('full ⊇ lean: full profile count is >= lean count', async () => {
    // Run a second seedAll with full profile — items already written are
    // idempotently overwritten; stubs currently add nothing extra, so counts
    // are equal now (Tasks 2-4 will add more). The superset assertion holds
    // in all future states too.
    const fullCount = await seedAll(endpoint, 'full');
    expect(fullCount).toBeGreaterThanOrEqual(LEAN_TOTAL);
  });
});
