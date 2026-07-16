// Placement nudges repo integration tests against DynamoDB Local (Post-Tour &
// Application, Task 3).
//
// Covers:
//   1. create → get-back round-trip (nudgeId, _nudgePartition, timestamps)
//   2. listDue boundary: dueAt <= now INCLUSIVE; future rows excluded
//   3. claimSend wins exactly once (two concurrent claims: one true, one false)
//   4. canceled rows lose the claim (claimSend returns false after cancel)
//   5. cancelForPlacement hides pending rows from listDue but leaves sent rows'
//      sentAt intact
//
// Mirrors toursRepo.integration.test.ts harness idioms (throwaway-prefix table,
// self-skipping when no DynamoDB Local answers at DYNAMODB_ENDPOINT).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createLogger } from '../src/lib/logger.js';
import { createPlacementNudgesRepo } from '../src/repos/placementNudgesRepo.js';
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
    `[placementNudgesRepo.integration] SKIPPED — no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

describe.skipIf(!reachable)('placementNudgesRepo against DynamoDB Local (throwaway prefix)', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const nudges = createPlacementNudgesRepo({ doc, env: testEnv, logger });

  beforeAll(async () => {
    await ensureTable(
      client,
      getTableSpec('placementNudges'),
      tableName('placementNudges', testEnv),
    );
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, tableName('placementNudges', testEnv));
    doc.destroy();
    client.destroy();
  }, 120_000);

  it('create stamps a nudgeId, the fixed partition and createdAt', async () => {
    const row = await nudges.create({
      placementId: 'placement-create-1',
      kind: 'receipt_check',
      dueAt: '2026-07-04T10:00:00.000Z',
    });

    expect(row.nudgeId).toMatch(/^nudge-/);
    expect(row.placementId).toBe('placement-create-1');
    expect(row.kind).toBe('receipt_check');
    expect(row.dueAt).toBe('2026-07-04T10:00:00.000Z');
    expect(row._nudgePartition).toBe('nudges');
    expect(row.createdAt).toBeDefined();
    expect(row.sentAt).toBeUndefined();
    expect(row.canceledAt).toBeUndefined();
  });

  it('listDue returns rows with dueAt <= now (inclusive) and excludes future rows', async () => {
    const placementId = `placement-due-${randomUUID().slice(0, 6)}`;
    const past = await nudges.create({ placementId, kind: 'receipt_check', dueAt: '2026-07-01T00:00:00.000Z' });
    const boundary = await nudges.create({ placementId, kind: 'completion_check', dueAt: '2026-07-02T00:00:00.000Z' });
    const future = await nudges.create({ placementId, kind: 'approval_check', dueAt: '2026-07-03T00:00:00.000Z' });

    const now = '2026-07-02T00:00:00.000Z';
    const due = await nudges.listDue(now);
    const dueIds = due.map((r) => r.nudgeId);

    // past (before now) and boundary (exactly now) are due; future is excluded.
    expect(dueIds).toContain(past.nudgeId);
    expect(dueIds).toContain(boundary.nudgeId); // dueAt === now is inclusive
    expect(dueIds).not.toContain(future.nudgeId);
  });

  it('claimSend wins exactly once under two concurrent claims', async () => {
    const row = await nudges.create({
      placementId: `placement-claim-${randomUUID().slice(0, 6)}`,
      kind: 'receipt_check',
      dueAt: '2026-07-01T00:00:00.000Z',
    });

    const [a, b] = await Promise.all([
      nudges.claimSend(row.nudgeId, '2026-07-02T00:00:00.000Z'),
      nudges.claimSend(row.nudgeId, '2026-07-02T00:00:00.000Z'),
    ]);

    // Exactly one claim wins.
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect([a, b].filter((x) => !x)).toHaveLength(1);

    // A claimed row is no longer due.
    const due = await nudges.listDue('2026-07-02T00:00:00.000Z');
    expect(due.map((r) => r.nudgeId)).not.toContain(row.nudgeId);
  });

  it('a claim-skipped row leaves listDue exactly once (real byDueAt FilterExpression)', async () => {
    const placementId = `placement-skip-${randomUUID().slice(0, 6)}`;
    const row = await nudges.create({ placementId, kind: 'approval_check', dueAt: '2026-07-01T00:00:00.000Z' });

    expect(await nudges.claimSkip(row.nudgeId, '2026-07-02T00:00:00.000Z', 'no_landlord')).toBe(true);

    // The retired row never re-surfaces as due — the perpetual re-list bug guard.
    const due = await nudges.listDue('2026-07-02T00:00:00.000Z');
    expect(due.map((r) => r.nudgeId)).not.toContain(row.nudgeId);

    // And it can no longer be sent or canceled.
    expect(await nudges.claimSend(row.nudgeId, '2026-07-02T01:00:00.000Z')).toBe(false);
    expect(await nudges.cancel(row.nudgeId, '2026-07-02T01:00:00.000Z')).toBe(false);
    const stored = (await nudges.listByPlacement(placementId)).find((r) => r.nudgeId === row.nudgeId);
    expect(stored?.skippedAt).toBe('2026-07-02T00:00:00.000Z');
    expect(stored?.skipReason).toBe('no_landlord');
  });

  it('a canceled row loses the claim (claimSend returns false)', async () => {
    const placementId = `placement-cancel-claim-${randomUUID().slice(0, 6)}`;
    const row = await nudges.create({ placementId, kind: 'receipt_check', dueAt: '2026-07-01T00:00:00.000Z' });

    await nudges.cancelForPlacement(placementId);

    const claimed = await nudges.claimSend(row.nudgeId, '2026-07-02T00:00:00.000Z');
    expect(claimed).toBe(false);

    // And the canceled row is excluded from listDue.
    const due = await nudges.listDue('2026-07-02T00:00:00.000Z');
    expect(due.map((r) => r.nudgeId)).not.toContain(row.nudgeId);
  });

  it('cancelForPlacement hides pending rows from listDue but leaves sent rows sentAt intact', async () => {
    const placementId = `placement-cancel-mixed-${randomUUID().slice(0, 6)}`;
    const pending = await nudges.create({ placementId, kind: 'receipt_check', dueAt: '2026-07-01T00:00:00.000Z' });
    const sent = await nudges.create({ placementId, kind: 'completion_check', dueAt: '2026-07-01T00:00:00.000Z' });

    // Claim (send) one of the two rows first.
    const sentAt = '2026-07-01T12:00:00.000Z';
    expect(await nudges.claimSend(sent.nudgeId, sentAt)).toBe(true);

    await nudges.cancelForPlacement(placementId);

    // Pending row is now canceled → not due.
    const due = await nudges.listDue('2026-07-02T00:00:00.000Z');
    const dueIds = due.map((r) => r.nudgeId);
    expect(dueIds).not.toContain(pending.nudgeId);
    expect(dueIds).not.toContain(sent.nudgeId); // sent rows never re-surface

    // The already-sent row keeps its sentAt (cancel must not touch it).
    const rows = await nudges.listByPlacement(placementId);
    const sentRow = rows.find((r) => r.nudgeId === sent.nudgeId);
    const pendingRow = rows.find((r) => r.nudgeId === pending.nudgeId);
    expect(sentRow?.sentAt).toBe(sentAt);
    expect(sentRow?.canceledAt).toBeUndefined();
    expect(pendingRow?.sentAt).toBeUndefined();
    expect(pendingRow?.canceledAt).toBeDefined();
  });
});
