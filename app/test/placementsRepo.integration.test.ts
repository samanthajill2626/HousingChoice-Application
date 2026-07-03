// M1.10 integration tests against DynamoDB Local — the REAL UpdateExpression +
// SPARSE-KEY semantics the in-memory fakes cannot validate:
//   • null→REMOVE actually drops a placement from the sparse byTourDate index
//     (a key attribute set to null would be REJECTED; it must be ABSENT).
//   • the combined `SET … REMOVE …` expression raises no ValidationException.
//   • first-class placementDeadlines arm/retire/listDue/clearForPlacement over
//     the real byPlacement + byDueAt GSIs (placement-deadline-model).
// Plus the CRUD + each GSI, mirroring unitsRepo.integration.
//
// Self-skipping like the other integration suites: when nothing answers at
// DYNAMODB_ENDPOINT (default http://localhost:8000) the suite is skipped so
// `npm test` stays green without Docker (`npm run db:start` to run for real).
import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createLogger } from '../src/lib/logger.js';
import { createPlacementsRepo } from '../src/repos/placementsRepo.js';
import {
  createPlacementDeadlinesRepo,
  soonestDeadline,
} from '../src/repos/placementDeadlinesRepo.js';
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
    `[placementsRepo.integration] SKIPPED — no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

describe.skipIf(!reachable)('placementsRepo against DynamoDB Local (throwaway prefix)', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const placements = createPlacementsRepo({ doc, env: testEnv, logger });
  const deadlines = createPlacementDeadlinesRepo({ doc, env: testEnv, logger });

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('placements'), tableName('placements', testEnv));
    await ensureTable(
      client,
      getTableSpec('placementDeadlines'),
      tableName('placementDeadlines', testEnv),
    );
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, tableName('placements', testEnv));
    await deleteTableIfExists(client, tableName('placementDeadlines', testEnv));
    doc.destroy();
    client.destroy();
  }, 120_000);

  it('create generates a placementId, stamps timestamps, and getById reads it back', async () => {
    const c = await placements.create({
      tenantId: 'contact-tenant-1',
      unitId: 'unit-1',
      stage: 'send_application',
      placement_tag: 'Keisha @ 123 Main',
    });
    expect(c.placementId).toMatch(/^placement-/);
    expect(c.created_at).toBeDefined();
    expect(c.updated_at).toBeDefined();

    const read = await placements.getById(c.placementId);
    expect(read).toMatchObject({
      placementId: c.placementId,
      tenantId: 'contact-tenant-1',
      unitId: 'unit-1',
      stage: 'send_application',
      placement_tag: 'Keisha @ 123 Main',
    });
  });

  it('update SET-merges (leaves unset fields untouched) and bumps updated_at', async () => {
    const c = await placements.create({
      tenantId: 'contact-tenant-2',
      unitId: 'unit-2',
      stage: 'awaiting_inspection',
      application: { rung1: 'submitted' },
    });
    const before = c.updated_at;

    const updated = await placements.update(c.placementId, {
      stage: 'awaiting_approval',
      group_thread: 'conv-relay-9',
    });
    expect(updated.stage).toBe('awaiting_approval');
    expect(updated.group_thread).toBe('conv-relay-9');
    // Untouched fields survive the merge.
    expect(updated.application).toEqual({ rung1: 'submitted' });
    expect(updated.tenantId).toBe('contact-tenant-2');
    expect(updated.updated_at).not.toBe(before);
  });

  it('update throws ConditionalCheckFailedException for an unknown placement', async () => {
    await expect(placements.update('placement-ghost', { stage: 'lost' })).rejects.toBeInstanceOf(
      ConditionalCheckFailedException,
    );
  });

  it('null→REMOVE clears a sparse byTourDate key: the placement drops out of the index', async () => {
    // byTourDate is a plain string partition; a per-run unique YYYY-MM-DD
    // isolates this assertion (DynamoDB doesn't validate the date — uniqueness
    // is all we need).
    const dd = (1 + (parseInt(randomUUID().slice(0, 4), 16) % 28)).toString().padStart(2, '0');
    const date = `2026-08-${dd}`;

    const c = await placements.create({
      tenantId: 'contact-tenant-3',
      unitId: 'unit-3',
      stage: 'awaiting_inspection',
      tour_date: date,
    });
    // Present in byTourDate while the sparse key exists.
    const found = await placements.listByTourDate(date);
    expect(found.items.some((x) => x.placementId === c.placementId)).toBe(true);

    // Clear it with a TRUE mixed SET+REMOVE (`SET stage=…, updated_at=… REMOVE
    // tour_date`) — must not raise a ValidationException, must APPLY the SET, and
    // must drop the placement from the sparse byTourDate index.
    const cleared = await placements.update(c.placementId, { stage: 'lost', tour_date: null });
    expect(cleared.tour_date).toBeUndefined();
    expect(cleared.stage).toBe('lost');

    const afterClear = await placements.listByTourDate(date);
    expect(afterClear.items.some((x) => x.placementId === c.placementId)).toBe(false);
  });

  it('placementDeadlines: arm is queryable+range-bounded (byDueAt), retire drops it', async () => {
    const c = await placements.create({
      tenantId: 'contact-tenant-4',
      unitId: 'unit-4',
      stage: 'awaiting_authority_approval',
    });
    // Not due until armed.
    const beforeArm = await deadlines.listDue('2026-06-17T00:00:00.000Z');
    expect(beforeArm.some((d) => d.placementId === c.placementId)).toBe(false);

    const at = '2026-06-16T12:00:00.000Z';
    const armed = await deadlines.arm(c.placementId, 'rta_window', at);
    expect(armed.deadlineId).toBe(`${c.placementId}#rta_window`);
    expect(armed.at).toBe(at);

    // Range query: due AT or BEFORE a cutoff after `at` finds it; before `at` doesn't.
    const dueByLater = await deadlines.listDue('2026-06-17T00:00:00.000Z');
    expect(dueByLater.some((d) => d.placementId === c.placementId)).toBe(true);
    const dueByEarlier = await deadlines.listDue('2026-06-15T00:00:00.000Z');
    expect(dueByEarlier.some((d) => d.placementId === c.placementId)).toBe(false);

    // byPlacement enumerates it; soonestDeadline computes over it.
    const rows = await deadlines.listByPlacement(c.placementId);
    expect(rows).toHaveLength(1);
    expect(soonestDeadline(rows)).toEqual({ type: 'rta_window', at });

    // Retire: drops out of byDueAt + byPlacement.
    await deadlines.retire(c.placementId, 'rta_window');
    const afterRetire = await deadlines.listDue('2026-06-17T00:00:00.000Z');
    expect(afterRetire.some((d) => d.placementId === c.placementId)).toBe(false);
    expect(await deadlines.listByPlacement(c.placementId)).toHaveLength(0);
  });

  it('lists via each single-key GSI and the unfiltered Scan', async () => {
    const tenantId = `contact-tenant-gsi-${randomUUID().slice(0, 6)}`;
    const unitId = `unit-gsi-${randomUUID().slice(0, 6)}`;
    await placements.create({ tenantId, unitId, stage: 'send_application' });
    await placements.create({ tenantId, unitId, stage: 'send_application' });

    const byTenant = await placements.listByTenant(tenantId);
    expect(byTenant.items).toHaveLength(2);
    expect(byTenant.items.every((x) => x.tenantId === tenantId)).toBe(true);

    const byUnit = await placements.listByUnit(unitId);
    expect(byUnit.items).toHaveLength(2);
    expect(byUnit.items.every((x) => x.unitId === unitId)).toBe(true);

    // A unique stage partition isolates this assertion from sibling tests.
    const stage = 'schedule_inspection' as const;
    const isoTenant = `contact-tenant-stage-${randomUUID().slice(0, 6)}`;
    await placements.create({ tenantId: isoTenant, unitId: 'unit-x', stage });
    const byStage = await placements.listByStage(stage);
    expect(byStage.items.some((x) => x.tenantId === isoTenant)).toBe(true);
    expect(byStage.items.every((x) => x.stage === stage)).toBe(true);

    const all = await placements.list({ limit: 100 });
    expect(all.items.length).toBeGreaterThanOrEqual(2);

    // Zero-arg list() — the board's "all placements" fallback (the no-Limit/no-cursor
    // Scan branch).
    const allNoArgs = await placements.list();
    expect(Array.isArray(allNoArgs.items)).toBe(true);
    expect(allNoArgs.items.length).toBeGreaterThanOrEqual(2);
  });

  it('paginates a GSI query via LastEvaluatedKey', async () => {
    const tenantId = `contact-tenant-page-${randomUUID().slice(0, 6)}`;
    for (let i = 0; i < 3; i++) {
      await placements.create({ tenantId, unitId: `unit-p${i}`, stage: 'send_application' });
    }
    const collected: string[] = [];
    let cursor: Record<string, unknown> | undefined;
    let pages = 0;
    do {
      const page = await placements.listByTenant(tenantId, {
        limit: 1,
        ...(cursor !== undefined && { exclusiveStartKey: cursor }),
      });
      collected.push(...page.items.map((x) => x.placementId));
      cursor = page.lastEvaluatedKey;
      pages += 1;
    } while (cursor !== undefined && pages < 10);

    expect(new Set(collected).size).toBe(3); // no gaps or dupes
    expect(pages).toBeGreaterThanOrEqual(3); // really paginated
  });

  it('placementDeadlines.listDue walks the whole byDueAt partition soonest-first', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const c = await placements.create({
        tenantId: `contact-vt-${randomUUID().slice(0, 6)}`,
        unitId: `unit-vt-${i}`,
        stage: 'awaiting_approval',
      });
      // Distinct instants, all in the PAST relative to the cutoff below.
      await deadlines.arm(c.placementId, 'voucher_expiration', `2026-09-0${i + 1}T00:00:00.000Z`);
      ids.push(c.placementId);
    }
    // One soonest-first walk of the fixed 'deadlines' partition (pages internally).
    const due = await deadlines.listDue('2026-12-31T00:00:00.000Z');
    const ours = due.filter((d) => ids.includes(d.placementId));
    expect(ours.map((d) => d.placementId)).toEqual(ids); // soonest-first, no gaps/dupes
    // listAllPending returns them too (whole partition, unbounded by `now`).
    const all = await deadlines.listAllPending();
    expect(ids.every((id) => all.some((d) => d.placementId === id))).toBe(true);
  });
});
