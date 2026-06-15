// M1.10 integration tests against DynamoDB Local — the REAL UpdateExpression +
// SPARSE-KEY semantics the in-memory fakes cannot validate:
//   • null→REMOVE actually drops a case from the sparse byTourDate index
//     (a key attribute set to null would be REJECTED; it must be ABSENT).
//   • setNextDeadline writes/removes the byNextDeadline COMPOSITE key
//     both-or-neither, and the range query (#a <= :before) works.
//   • the combined `SET … REMOVE …` expression raises no ValidationException.
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
import { createCasesRepo } from '../src/repos/casesRepo.js';
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
    `[casesRepo.integration] SKIPPED — no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

describe.skipIf(!reachable)('casesRepo against DynamoDB Local (throwaway prefix)', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const cases = createCasesRepo({ doc, env: testEnv, logger });

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('cases'), tableName('cases', testEnv));
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, tableName('cases', testEnv));
    doc.destroy();
    client.destroy();
  }, 120_000);

  it('create generates a caseId, stamps timestamps, and getById reads it back', async () => {
    const c = await cases.create({
      tenantId: 'contact-tenant-1',
      unitId: 'unit-1',
      stage: 'interested',
      placement_tag: 'Keisha @ 123 Main',
    });
    expect(c.caseId).toMatch(/^case-/);
    expect(c.created_at).toBeDefined();
    expect(c.updated_at).toBeDefined();

    const read = await cases.getById(c.caseId);
    expect(read).toMatchObject({
      caseId: c.caseId,
      tenantId: 'contact-tenant-1',
      unitId: 'unit-1',
      stage: 'interested',
      placement_tag: 'Keisha @ 123 Main',
    });
  });

  it('update SET-merges (leaves unset fields untouched) and bumps updated_at', async () => {
    const c = await cases.create({
      tenantId: 'contact-tenant-2',
      unitId: 'unit-2',
      stage: 'touring',
      application: { rung1: 'submitted' },
    });
    const before = c.updated_at;

    const updated = await cases.update(c.caseId, {
      stage: 'applied',
      group_thread: 'conv-relay-9',
    });
    expect(updated.stage).toBe('applied');
    expect(updated.group_thread).toBe('conv-relay-9');
    // Untouched fields survive the merge.
    expect(updated.application).toEqual({ rung1: 'submitted' });
    expect(updated.tenantId).toBe('contact-tenant-2');
    expect(updated.updated_at).not.toBe(before);
  });

  it('update throws ConditionalCheckFailedException for an unknown case', async () => {
    await expect(cases.update('case-ghost', { stage: 'lost' })).rejects.toBeInstanceOf(
      ConditionalCheckFailedException,
    );
  });

  it('null→REMOVE clears a sparse byTourDate key: the case drops out of the index', async () => {
    // byTourDate is a plain string partition; a per-run unique YYYY-MM-DD
    // isolates this assertion (DynamoDB doesn't validate the date — uniqueness
    // is all we need).
    const dd = (1 + (parseInt(randomUUID().slice(0, 4), 16) % 28)).toString().padStart(2, '0');
    const date = `2026-08-${dd}`;

    const c = await cases.create({
      tenantId: 'contact-tenant-3',
      unitId: 'unit-3',
      stage: 'touring',
      tour_date: date,
    });
    // Present in byTourDate while the sparse key exists.
    const found = await cases.listByTourDate(date);
    expect(found.items.some((x) => x.caseId === c.caseId)).toBe(true);

    // Clear it with a TRUE mixed SET+REMOVE (`SET stage=…, updated_at=… REMOVE
    // tour_date`) — must not raise a ValidationException, must APPLY the SET, and
    // must drop the case from the sparse byTourDate index.
    const cleared = await cases.update(c.caseId, { stage: 'lost', tour_date: null });
    expect(cleared.tour_date).toBeUndefined();
    expect(cleared.stage).toBe('lost');

    const afterClear = await cases.listByTourDate(date);
    expect(afterClear.items.some((x) => x.caseId === c.caseId)).toBe(false);
  });

  it('setNextDeadline writes the composite key (queryable, range-bounded) and clears both on null', async () => {
    const type = 'rta_window' as const;
    const c = await cases.create({
      tenantId: 'contact-tenant-4',
      unitId: 'unit-4',
      stage: 'rta_submitted',
    });
    // Not in byNextDeadline until a deadline is set.
    const beforeSet = await cases.listByNextDeadline(type);
    expect(beforeSet.items.some((x) => x.caseId === c.caseId)).toBe(false);

    const at = '2026-06-16T12:00:00.000Z';
    const withDeadline = await cases.setNextDeadline(c.caseId, { type, at });
    expect(withDeadline.next_deadline_type).toBe(type);
    expect(withDeadline.next_deadline_at).toBe(at);

    // Range query: due AT or BEFORE a cutoff after `at` finds it; before `at` doesn't.
    const dueByLater = await cases.listByNextDeadline(type, { beforeAt: '2026-06-17T00:00:00.000Z' });
    expect(dueByLater.items.some((x) => x.caseId === c.caseId)).toBe(true);
    const dueByEarlier = await cases.listByNextDeadline(type, { beforeAt: '2026-06-15T00:00:00.000Z' });
    expect(dueByEarlier.items.some((x) => x.caseId === c.caseId)).toBe(false);

    // Clear both: drops out of byNextDeadline (sparse composite key absent).
    const cleared = await cases.setNextDeadline(c.caseId, null);
    expect(cleared.next_deadline_type).toBeUndefined();
    expect(cleared.next_deadline_at).toBeUndefined();
    const afterClear = await cases.listByNextDeadline(type);
    expect(afterClear.items.some((x) => x.caseId === c.caseId)).toBe(false);
  });

  it('lists via each single-key GSI and the unfiltered Scan', async () => {
    const tenantId = `contact-tenant-gsi-${randomUUID().slice(0, 6)}`;
    const unitId = `unit-gsi-${randomUUID().slice(0, 6)}`;
    await cases.create({ tenantId, unitId, stage: 'interested' });
    await cases.create({ tenantId, unitId, stage: 'interested' });

    const byTenant = await cases.listByTenant(tenantId);
    expect(byTenant.items).toHaveLength(2);
    expect(byTenant.items.every((x) => x.tenantId === tenantId)).toBe(true);

    const byUnit = await cases.listByUnit(unitId);
    expect(byUnit.items).toHaveLength(2);
    expect(byUnit.items.every((x) => x.unitId === unitId)).toBe(true);

    // A unique stage partition isolates this assertion from sibling tests.
    const stage = 'inspection' as const;
    const isoTenant = `contact-tenant-stage-${randomUUID().slice(0, 6)}`;
    await cases.create({ tenantId: isoTenant, unitId: 'unit-x', stage });
    const byStage = await cases.listByStage(stage);
    expect(byStage.items.some((x) => x.tenantId === isoTenant)).toBe(true);
    expect(byStage.items.every((x) => x.stage === stage)).toBe(true);

    const all = await cases.list({ limit: 100 });
    expect(all.items.length).toBeGreaterThanOrEqual(2);

    // Zero-arg list() — the board's "all cases" fallback (the no-Limit/no-cursor
    // Scan branch).
    const allNoArgs = await cases.list();
    expect(Array.isArray(allNoArgs.items)).toBe(true);
    expect(allNoArgs.items.length).toBeGreaterThanOrEqual(2);
  });

  it('paginates a GSI query via LastEvaluatedKey', async () => {
    const tenantId = `contact-tenant-page-${randomUUID().slice(0, 6)}`;
    for (let i = 0; i < 3; i++) {
      await cases.create({ tenantId, unitId: `unit-p${i}`, stage: 'interested' });
    }
    const collected: string[] = [];
    let cursor: Record<string, unknown> | undefined;
    let pages = 0;
    do {
      const page = await cases.listByTenant(tenantId, {
        limit: 1,
        ...(cursor !== undefined && { exclusiveStartKey: cursor }),
      });
      collected.push(...page.items.map((x) => x.caseId));
      cursor = page.lastEvaluatedKey;
      pages += 1;
    } while (cursor !== undefined && pages < 10);

    expect(new Set(collected).size).toBe(3); // no gaps or dupes
    expect(pages).toBeGreaterThanOrEqual(3); // really paginated
  });

  it('paginates the COMPOSITE byNextDeadline GSI via LastEvaluatedKey (4-attr cursor round-trip)', async () => {
    // 'voucher_expiration' is used by no other test, so this partition holds
    // exactly our three — soonest-first, distinct instants.
    const type = 'voucher_expiration' as const;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const c = await cases.create({
        tenantId: `contact-vt-${randomUUID().slice(0, 6)}`,
        unitId: `unit-vt-${i}`,
        stage: 'applied',
      });
      await cases.setNextDeadline(c.caseId, { type, at: `2026-09-0${i + 1}T00:00:00.000Z` });
      ids.push(c.caseId);
    }
    const collected: string[] = [];
    let cursor: Record<string, unknown> | undefined;
    let pages = 0;
    do {
      const page = await cases.listByNextDeadline(type, {
        limit: 1,
        ...(cursor !== undefined && { exclusiveStartKey: cursor }),
      });
      collected.push(...page.items.map((x) => x.caseId));
      cursor = page.lastEvaluatedKey;
      pages += 1;
    } while (cursor !== undefined && pages < 10);

    expect(ids.every((id) => collected.includes(id))).toBe(true);
    expect(new Set(collected).size).toBe(collected.length); // composite cursor never dupes
    expect(pages).toBeGreaterThanOrEqual(3);
  });
});
