// rankingRunsRepo, the RUN family (WP1 B2a spec D11; plan PR5): the run
// record and its two pointers in one write, the 350 KB guard, the
// matchesWritten stamp, and the listing (newest first, by day, by cursor,
// a pointer whose run is gone reads expired).
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { createLogger } from '../src/lib/logger.js';
import { getTableSpec } from '../src/lib/tables.js';
import { gzipBase64, rankingExpiresAt } from '../src/repos/matchesRepo.js';
import {
  RANKING_RUNS_GLOBAL_ENTITY,
  RANKING_RUN_ITEM_MAX_BYTES,
  RANKING_RUN_SUMMARY_FIELDS,
  createRankingRunsRepo,
  rankingPointerItemId,
  rankingRunEntityKey,
  rankingRunItemId,
  rankingRunSortKey,
  withRankingRunSizeGuard,
  type RankingRunRecord,
  type RankingRunRecordInput,
} from '../src/repos/rankingRunsRepo.js';
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
  console.warn(`[rankingRunsRepoRuns.integration] DynamoDB Local is required at ${endpoint}`);
}

function runInput(runId: string, over: Partial<RankingRunRecordInput> = {}): RankingRunRecordInput {
  const startedAt = over.startedAt ?? '2026-10-28T11:00:00.000Z';
  return {
    runId,
    anchorKind: 'unit',
    anchorId: 'unit-a',
    direction: 'tenants_for_property',
    jobGeneration: 'gen-1',
    batchIndex: 0,
    candidateCount: 2,
    driver: 'fake',
    model: 'fake',
    rubricVersion: 'r1',
    examplesVersion: 'e1',
    promptFingerprint: 'f'.repeat(64),
    usage: { inputTokens: 1200, outputTokens: 300 },
    costUsd: 0,
    latencyMs: 15,
    startedAt,
    finishedAt: '2026-10-28T11:00:01.000Z',
    outcome: 'scored',
    rawText: '{"candidates":[]}',
    inputGzip: gzipBase64('{"anchor":{}}'),
    handles: [
      { handle: 'c1', candidateId: 'contact-1', display: 'Pat Doe' },
      { handle: 'c2', candidateId: 'contact-2', display: 'Lee Roe' },
    ],
    results: [
      {
        handle: 'c1',
        candidateId: 'contact-1',
        display: 'Pat Doe',
        returned: true,
        score: 81,
        for: [{ text: 'Size fits', source: 'voucher_size' }],
        against: [],
        unknowns: ['Move-in date'],
        missing: [{ key: 'payment_standard', text: 'Payment standard' }, { text: 'Move-in date' }],
        failedRequirements: [],
        fairHousingFlags: [],
        cappedAtRun: { capped: false, capReason: null },
      },
      // The model left c2 out: recorded, with no score (charter 7.4).
      { handle: 'c2', candidateId: 'contact-2', display: 'Lee Roe', returned: false },
    ],
    droppedUnlawfulFlags: 0,
    environment: 'local',
    expires_at: rankingExpiresAt(startedAt, 180),
    ...over,
  };
}

describe('ranking run keys and the size guard', () => {
  it('rrun#, the pointer ids, the entity keys and the sort key', () => {
    expect(rankingRunItemId('r1')).toBe('rrun#r1');
    expect(RANKING_RUNS_GLOBAL_ENTITY).toBe('rankings#global');
    expect(rankingRunEntityKey()).toBe('rankings#global');
    expect(rankingRunEntityKey({ kind: 'unit', id: 'unit-1' })).toBe('rankings#unit#unit-1');
    expect(rankingRunEntityKey({ kind: 'tenant', id: 'contact-1' })).toBe('rankings#tenant#contact-1');
    expect(rankingRunSortKey('2026-10-28T11:00:00.000Z', 'r1')).toBe('2026-10-28T11:00:00.000Z#r1');
    expect(rankingPointerItemId('rankings#global', '2026-10-28T11:00:00.000Z', 'r1')).toBe(
      'ptr#rankings#global#2026-10-28T11:00:00.000Z#r1',
    );
  });

  it('the guard drops inputGzip and marks inputOmitted only above 350 KB', () => {
    expect(RANKING_RUN_ITEM_MAX_BYTES).toBe(350 * 1024);
    const small = { ...runInput('r-small'), itemId: 'rrun#r-small', kind: 'ranking' } as RankingRunRecord;
    expect(withRankingRunSizeGuard(small)).toBe(small);
    const big = {
      ...runInput('r-big', { inputGzip: randomBytes(300 * 1024).toString('base64') }),
      itemId: 'rrun#r-big',
      kind: 'ranking',
    } as RankingRunRecord;
    const guarded = withRankingRunSizeGuard(big);
    expect(guarded.inputOmitted).toBe(true);
    expect(guarded).not.toHaveProperty('inputGzip');
    expect(guarded.rawText).toBe(big.rawText);
  });
});

describe.skipIf(!reachable)('rankingRunsRepo run family against DynamoDB Local', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const repo = createRankingRunsRepo({ doc, env: testEnv, logger });
  const table = tableName('ai_runs', testEnv);
  const runId = (): string => `rank-${randomUUID().slice(0, 8)}`;

  async function raw(itemId: string): Promise<Record<string, unknown> | undefined> {
    const { Item } = await doc.send(new GetCommand({ TableName: table, Key: { itemId }, ConsistentRead: true }));
    return Item as Record<string, unknown> | undefined;
  }

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('ai_runs'), table);
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, table);
    doc.destroy();
    client.destroy();
  }, 120_000);

  it('putRun writes the run (kind ranking) and its global and per-anchor pointers, all with the 180-day TTL', async () => {
    const id = runId();
    const input = runInput(id, { anchorId: 'unit-ptr' });

    const record = await repo.putRun(input);

    expect(record).toEqual({ ...input, itemId: `rrun#${id}`, kind: 'ranking' });
    expect(await raw(`rrun#${id}`)).toEqual(record);
    const sortKey = `${input.startedAt}#${id}`;
    for (const entityKey of ['rankings#global', 'rankings#unit#unit-ptr']) {
      expect(await raw(`ptr#${entityKey}#${sortKey}`), entityKey).toEqual({
        itemId: `ptr#${entityKey}#${sortKey}`,
        entityKey,
        sortKey,
        runId: id,
        expires_at: input.expires_at,
      });
    }
    expect(input.expires_at).toBe(Math.floor(Date.parse(input.startedAt) / 1000) + 180 * 86400);
  });

  it('putRun refuses a run id already written (one transaction: nothing half-written)', async () => {
    const id = runId();
    await repo.putRun(runInput(id));
    await expect(repo.putRun(runInput(id, { batchIndex: 9 }))).rejects.toThrow();
    expect((await raw(`rrun#${id}`))!['batchIndex']).toBe(0);
  });

  it('putRun applies the 350 KB guard to the stored item', async () => {
    const id = runId();
    const record = await repo.putRun(runInput(id, { inputGzip: randomBytes(300 * 1024).toString('base64') }));

    expect(record.inputOmitted).toBe(true);
    const stored = await raw(`rrun#${id}`);
    expect(stored).not.toHaveProperty('inputGzip');
    expect(stored!['inputOmitted']).toBe(true);
  });

  it('getRun reads the run; an unknown id answers undefined', async () => {
    const id = runId();
    const record = await repo.putRun(runInput(id));
    expect(await repo.getRun(id)).toEqual(record);
    expect(await repo.getRun('rank-none')).toBeUndefined();
  });

  it('results[] keep a returned pair with its merged missing list and cap, and a not-returned one with no score (IR3, PR14)', async () => {
    const id = runId();
    await repo.putRun(runInput(id));

    const [returned, omitted] = (await repo.getRun(id))!.results;
    expect(returned).toMatchObject({
      returned: true,
      score: 81,
      missing: [{ key: 'payment_standard', text: 'Payment standard' }, { text: 'Move-in date' }],
      cappedAtRun: { capped: false, capReason: null },
    });
    expect(omitted).toEqual({ handle: 'c2', candidateId: 'contact-2', display: 'Lee Roe', returned: false });
    expect(omitted).not.toHaveProperty('score');
  });

  it('markMatchesWritten stamps the count and time on an existing run only', async () => {
    const id = runId();
    await repo.putRun(runInput(id));

    expect(await repo.markMatchesWritten(id, { count: 2, at: '2026-10-28T11:00:02.000Z' })).toBe(true);
    expect((await repo.getRun(id))!.matchesWritten).toEqual({ count: 2, at: '2026-10-28T11:00:02.000Z' });
    expect(await repo.markMatchesWritten('rank-none', { count: 1, at: '2026-10-28T11:00:02.000Z' })).toBe(false);
    expect(await raw('rrun#rank-none')).toBeUndefined();
  });

  it('listRuns: global newest first across anchors; a per-anchor key lists only that anchor', async () => {
    const day = '2026-10-20';
    const a = runId();
    const b = runId();
    const c = runId();
    await repo.putRun(runInput(a, { anchorId: 'unit-list', startedAt: `${day}T11:00:00.000Z` }));
    await repo.putRun(runInput(b, { anchorId: 'unit-list', startedAt: `${day}T11:05:00.000Z` }));
    await repo.putRun(
      runInput(c, {
        anchorKind: 'tenant',
        anchorId: 'contact-list',
        direction: 'properties_for_tenant',
        startedAt: `${day}T11:10:00.000Z`,
      }),
    );

    const global = await repo.listRuns({ entityKey: rankingRunEntityKey(), from: day, to: day });
    expect(global.entries.map((e) => e.runId)).toEqual([c, b, a]);
    expect(global.entries.every((e) => !e.expired)).toBe(true);

    const unit = await repo.listRuns({ entityKey: rankingRunEntityKey({ kind: 'unit', id: 'unit-list' }) });
    expect(unit.entries.map((e) => e.runId)).toEqual([b, a]);
    const tenant = await repo.listRuns({ entityKey: rankingRunEntityKey({ kind: 'tenant', id: 'contact-list' }) });
    expect(tenant.entries.map((e) => e.runId)).toEqual([c]);
    const first = tenant.entries[0]!;
    expect(!first.expired && first.run.direction).toBe('properties_for_tenant');
  });

  it('listRuns pages by cursor with no overlap, also inside a day range', async () => {
    const ids = [runId(), runId(), runId(), runId(), runId()];
    for (const [i, id] of ids.entries()) {
      await repo.putRun(runInput(id, { anchorId: 'unit-page', startedAt: `2026-10-21T10:0${i}:00.000Z` }));
    }
    const entityKey = rankingRunEntityKey({ kind: 'unit', id: 'unit-page' });
    const newestFirst = [...ids].reverse();

    const page1 = await repo.listRuns({ entityKey, limit: 2 });
    expect(page1.entries.map((e) => e.runId)).toEqual(newestFirst.slice(0, 2));
    expect(page1.nextCursor).toBe(page1.entries[1]!.sortKey);

    const page2 = await repo.listRuns({ entityKey, limit: 2, cursor: page1.nextCursor });
    expect(page2.entries.map((e) => e.runId)).toEqual(newestFirst.slice(2, 4));
    const page3 = await repo.listRuns({ entityKey, limit: 2, cursor: page2.nextCursor });
    expect(page3.entries.map((e) => e.runId)).toEqual(newestFirst.slice(4));
    expect(page3.nextCursor).toBeUndefined();

    const ranged = await repo.listRuns({ entityKey, limit: 2, from: '2026-10-21', to: '2026-10-21', cursor: page1.nextCursor });
    expect(ranged.entries.map((e) => e.runId)).toEqual(newestFirst.slice(2, 4));
  });

  it('a pointer whose run is gone reads expired; an inverted range answers an empty page', async () => {
    const id = runId();
    const startedAt = '2026-10-22T09:00:00.000Z';
    const entityKey = rankingRunEntityKey({ kind: 'unit', id: 'unit-gone' });
    await doc.send(
      new PutCommand({
        TableName: table,
        Item: {
          itemId: rankingPointerItemId(entityKey, startedAt, id),
          entityKey,
          sortKey: rankingRunSortKey(startedAt, id),
          runId: id,
          expires_at: rankingExpiresAt(startedAt, 180),
        },
      }),
    );

    const listed = await repo.listRuns({ entityKey });
    expect(listed.entries).toEqual([{ runId: id, sortKey: rankingRunSortKey(startedAt, id), expired: true }]);
    // Expired by TTL is not "unread": the page is not incomplete.
    expect(listed.incomplete).toBeUndefined();
    expect(await repo.listRuns({ entityKey, from: '2026-10-23', to: '2026-10-22' })).toEqual({ entries: [] });
  });

  it('listRuns reads SUMMARIES only - never rawText, inputGzip, handles or results (PR34)', async () => {
    const id = runId();
    await repo.putRun(runInput(id, { anchorId: 'unit-summary', startedAt: '2026-10-23T09:00:00.000Z' }));

    const page = await repo.listRuns({ entityKey: rankingRunEntityKey({ kind: 'unit', id: 'unit-summary' }) });

    const entry = page.entries[0]!;
    if (entry.expired) throw new Error('expected a live entry');
    // The fixture carries no failure and no message, so those two are absent.
    expect(Object.keys(entry.run).sort()).toEqual(
      RANKING_RUN_SUMMARY_FIELDS.filter((field) => field !== 'failure' && field !== 'message').sort(),
    );
    expect(entry.run).toMatchObject({
      runId: id,
      kind: 'ranking',
      costUsd: 0,
      usage: { inputTokens: 1200, outputTokens: 300 },
      environment: 'local',
      outcome: 'scored',
    });
    for (const heavy of ['rawText', 'inputGzip', 'handles', 'results', 'promptFingerprint']) {
      expect(entry.run, heavy).not.toHaveProperty(heavy);
    }
    expect(page.incomplete).toBeUndefined();
  });
});
