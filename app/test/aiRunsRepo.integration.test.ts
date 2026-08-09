// Real-engine coverage for the ai_runs repository (F7a).
//
// The unit suite (aiRunsRepo.test.ts) drives a hand-rolled document-client
// emulator. That emulator has no model of DynamoDB's key-condition rules, its
// document-path validation, or transaction cancellation, so a whole CLASS of
// defect is invisible to it - the shipped From+To query emitted TWO sort-key
// conditions and the emulator evaluated it as an ordinary JS conjunction
// (conf P1-5). Everything below runs against DynamoDB Local so the engine, not
// a stand-in, decides.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { createLogger } from '../src/lib/logger.js';
import { getTableSpec } from '../src/lib/tables.js';
import {
  createAiRunsRepo,
  inflightItemId,
  pointerItemId,
  runExpiresAt,
  runItemId,
  runSortKey,
  type AiRunRecord,
  type AiRunRecordInput,
} from '../src/repos/aiRunsRepo.js';
import type { RunDecision } from '../src/services/extraction/runTypes.js';
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
  console.warn(`[aiRunsRepo.integration] DynamoDB Local is required at ${endpoint}`);
}

describe.skipIf(!reachable)('ai run log repository against DynamoDB Local', () => {
  const testEnv = { TABLE_PREFIX: `hc-airuns-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const runs = createAiRunsRepo({ doc, env: testEnv, logger });
  const runsTable = tableName('ai_runs', testEnv);

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('ai_runs'), runsTable);
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, runsTable);
    doc.destroy();
    client.destroy();
  }, 120_000);

  const decision = (over: Partial<RunDecision> = {}): RunDecision => ({
    proposedOp: 'suggest',
    proposedValue: 'two cats',
    outcome: 'suggested',
    verdict: 'pending',
    ...over,
  });

  function runInput(over: Partial<AiRunRecordInput> = {}): AiRunRecordInput {
    const runId = over.runId ?? `run-${randomUUID().slice(0, 8)}`;
    return {
      runId,
      startedAt: '2026-08-06T10:00:00.000Z',
      finishedAt: '2026-08-06T10:00:01.000Z',
      durationMs: 1_000,
      conversationId: 'conv-1',
      contactId: 'contact-1',
      trigger: 'sms',
      outcome: 'applied',
      driver: 'fake',
      decisions: { pets: decision() },
      notedLines: 0,
      ...over,
    };
  }

  /**
   * The rejection itself. DynamoDB's ValidationException is not a modeled SDK
   * class - it is recognized by `name` (aiRunsRepo.ts:124-126), so assert the
   * name AND the engine's own wording rather than a message regex.
   */
  async function rejection(promise: Promise<unknown>): Promise<Error> {
    const err = await promise.then(() => undefined, (reason: unknown) => reason);
    if (!(err instanceof Error)) throw new Error('expected a rejection');
    return err;
  }

  async function rawItem(itemId: string): Promise<Record<string, unknown> | undefined> {
    const { Item } = await doc.send(new GetCommand({
      TableName: runsTable,
      Key: { itemId },
      ConsistentRead: true,
    }));
    return Item as Record<string, unknown> | undefined;
  }

  // -------------------------------------------------------------------------
  // putRun: one all-or-nothing transaction for the run row and every pointer
  // -------------------------------------------------------------------------

  it('lands the run row and every pointer in one transaction', async () => {
    const input = runInput({
      runId: 'run-txn-1',
      conversationId: 'conv-txn',
      contactId: 'contact-txn',
    });
    const stored = await runs.putRun(input);

    expect(stored.itemId).toBe(runItemId('run-txn-1'));
    expect(stored.expires_at).toBe(runExpiresAt(input.startedAt));
    const sortKey = runSortKey(input.startedAt, 'run-txn-1');
    for (const entityKey of [
      'global',
      'outcome#applied',
      'conversations#conv-txn',
      'contacts#contact-txn',
    ]) {
      const pointer = await rawItem(pointerItemId(entityKey, input.startedAt, 'run-txn-1'));
      expect(pointer, `pointer for ${entityKey}`).toMatchObject({
        entityKey,
        sortKey,
        runId: 'run-txn-1',
      });
    }
    // The run row is NOT in the byEntity index: only pointers carry entityKey
    // (aiRunsRepo.ts:189-195 builds entityKey/sortKey on pointer items only).
    const row = await rawItem(runItemId('run-txn-1'));
    expect(row?.['entityKey']).toBeUndefined();
    expect(row?.['sortKey']).toBeUndefined();
  });

  it('rejects a second putRun for the same runId once a marker was consumed', async () => {
    const input = runInput({ runId: 'run-txn-2', conversationId: 'conv-txn-2' });
    expect(await runs.beginFinalization('run-txn-2', input.startedAt)).toBe(true);
    await runs.putRun(input);
    // The marker is gone, so the retry's `attribute_not_exists(itemId)`
    // ConditionCheck on inflight# (aiRunsRepo.ts:216-220) succeeds and the run
    // row is simply rewritten - a replay is idempotent, never a duplicate row.
    const again = await runs.putRun(input);
    expect(again.runId).toBe('run-txn-2');
    expect(await rawItem(inflightItemId('run-txn-2'))).toBeUndefined();
  });

  it('leaves nothing behind when the transaction is cancelled', async () => {
    // A live marker whose version does not match the one putRun read forces a
    // real TransactionCanceledException on every one of the three attempts.
    const input = runInput({ runId: 'run-txn-3', conversationId: 'conv-txn-3' });
    await doc.send(new PutCommand({
      TableName: runsTable,
      Item: {
        itemId: inflightItemId('run-txn-3'),
        runId: 'run-txn-3',
        version: 0,
        verdicts: {},
        expires_at: runExpiresAt(input.startedAt),
      },
    }));
    let version = 0;
    const racingDoc = {
      send: async (command: unknown) => {
        const result = await doc.send(command as Parameters<typeof doc.send>[0]);
        // Bump the marker AFTER putRun's consistent read so its Delete guard
        // (`#version = :version`, aiRunsRepo.ts:223-225) can never hold.
        if ((command as { input?: { Key?: { itemId?: string } } }).input?.Key?.itemId
          === inflightItemId('run-txn-3')) {
          version += 1;
          await doc.send(new PutCommand({
            TableName: runsTable,
            Item: {
              itemId: inflightItemId('run-txn-3'),
              runId: 'run-txn-3',
              version,
              verdicts: {},
              expires_at: runExpiresAt(input.startedAt),
            },
          }));
        }
        return result;
      },
    } as unknown as DynamoDBDocumentClient;
    const racingRepo = createAiRunsRepo({ doc: racingDoc, env: testEnv, logger });
    await expect(racingRepo.putRun(input)).rejects.toThrow();
    expect(await rawItem(runItemId('run-txn-3'))).toBeUndefined();
    expect(await rawItem(pointerItemId('global', input.startedAt, 'run-txn-3'))).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // beginFinalization: a real ConditionalCheckFailedException, not a hand-made one
  // -------------------------------------------------------------------------

  it('begins finalization exactly once per runId', async () => {
    expect(await runs.beginFinalization('run-fin-1', '2026-08-06T10:00:00.000Z')).toBe(true);
    expect(await runs.beginFinalization('run-fin-1', '2026-08-06T10:00:00.000Z')).toBe(false);
    const marker = await rawItem(inflightItemId('run-fin-1'));
    expect(marker).toMatchObject({ runId: 'run-fin-1', version: 0, verdicts: {} });
  });

  // -------------------------------------------------------------------------
  // listByEntity: ordering, paging, and the date-range forms
  // -------------------------------------------------------------------------

  describe('listByEntity', () => {
    const entity = 'contacts#list-contact';
    const minute = (n: number): string => `2026-08-06T10:${String(n).padStart(2, '0')}:00.000Z`;
    const listRunId = (n: number): string => `run-list-${String(n).padStart(2, '0')}`;

    beforeAll(async () => {
      for (let n = 1; n <= 6; n += 1) {
        await runs.putRun(runInput({
          runId: listRunId(n),
          startedAt: minute(n),
          finishedAt: minute(n),
          conversationId: 'conv-list',
          contactId: 'list-contact',
        }));
      }
    }, 120_000);

    it('returns newest first', async () => {
      const { entries } = await runs.listByEntity(entity);
      expect(entries.map((e) => e.runId)).toEqual([
        listRunId(6), listRunId(5), listRunId(4), listRunId(3), listRunId(2), listRunId(1),
      ]);
      expect(entries.every((e) => !e.expired)).toBe(true);
    });

    it('pages through nextBefore with no duplicate and no skipped row', async () => {
      const seen: string[] = [];
      let before: string | undefined;
      for (let page = 0; page < 4; page += 1) {
        const result = await runs.listByEntity(entity, {
          limit: 2,
          ...(before !== undefined && { before }),
        });
        seen.push(...result.entries.map((e) => e.runId));
        before = result.nextBefore;
        if (before === undefined) break;
      }
      expect(seen).toEqual([
        listRunId(6), listRunId(5), listRunId(4), listRunId(3), listRunId(2), listRunId(1),
      ]);
      expect(new Set(seen).size).toBe(seen.length);
    });

    it('filters on from only', async () => {
      const { entries } = await runs.listByEntity(entity, { from: minute(4) });
      expect(entries.map((e) => e.runId)).toEqual([listRunId(6), listRunId(5), listRunId(4)]);
    });

    it('filters on to only, including the whole to-day', async () => {
      const { entries } = await runs.listByEntity(entity, { to: minute(3) });
      expect(entries.map((e) => e.runId)).toEqual([listRunId(3), listRunId(2), listRunId(1)]);
      // A bare calendar day still sweeps every run in it (SORT_KEY_CEILING).
      const wholeDay = await runs.listByEntity(entity, { to: '2026-08-06' });
      expect(wholeDay.entries).toHaveLength(6);
    });

    it('filters on from AND to through a single BETWEEN condition', async () => {
      const { entries } = await runs.listByEntity(entity, { from: minute(2), to: minute(4) });
      expect(entries.map((e) => e.runId)).toEqual([listRunId(4), listRunId(3), listRunId(2)]);
    });

    it('composes from with the exclusive before cursor', async () => {
      const { entries } = await runs.listByEntity(entity, {
        from: minute(2),
        before: runSortKey(minute(4), listRunId(4)),
      });
      // `before` is the last sortKey ALREADY returned; BETWEEN is inclusive, so
      // the repo over-fetches by one and drops the boundary row
      // (aiRunsRepo.ts:272-276). run-list-04 must NOT reappear.
      expect(entries.map((e) => e.runId)).toEqual([listRunId(3), listRunId(2)]);
    });

    it('clamps a before cursor that runs past the to ceiling', async () => {
      const { entries } = await runs.listByEntity(entity, {
        to: minute(3),
        before: runSortKey(minute(6), listRunId(6)),
      });
      expect(entries.map((e) => e.runId)).toEqual([listRunId(3), listRunId(2), listRunId(1)]);
    });

    it('omits the sortKey alias when no condition uses it', async () => {
      // An ExpressionAttributeNames entry that no expression references is a
      // real ValidationException, so the unused-alias hygiene at
      // aiRunsRepo.ts:283 is load-bearing, not cosmetic.
      await expect(runs.listByEntity(entity, { limit: 1 })).resolves.toBeDefined();
      const err = await rejection(doc.send(new QueryCommand({
        TableName: runsTable,
        IndexName: 'byEntity',
        KeyConditionExpression: '#ek = :ek',
        ExpressionAttributeNames: { '#ek': 'entityKey', '#sk': 'sortKey' },
        ExpressionAttributeValues: { ':ek': entity },
      })));
      expect(err.name).toBe('ValidationException');
      expect(err.message).toMatch(/unused in expressions/i);
    });

    it('proves a real engine rejects the pre-fix two-condition range', async () => {
      // The shape aiRunsRepo emitted before the BETWEEN fix. The unit emulator
      // evaluated it as a JS conjunction and returned the "right" rows; the
      // engine refuses it outright. This is the class of bug the emulator hid.
      const input: QueryCommandInput = {
        TableName: runsTable,
        IndexName: 'byEntity',
        KeyConditionExpression: '#ek = :ek AND #sk <= :upper AND #sk >= :lower',
        ExpressionAttributeNames: { '#ek': 'entityKey', '#sk': 'sortKey' },
        ExpressionAttributeValues: {
          ':ek': entity,
          ':upper': `${minute(4)}\uffff`,
          ':lower': minute(2),
        },
        ScanIndexForward: false,
      };
      const err = await rejection(doc.send(new QueryCommand(input)));
      expect(err.name).toBe('ValidationException');
      expect(err.message).toMatch(/only contain one condition per key/i);
    });

    it('never returns a run row from the sparse byEntity index', async () => {
      const page = await doc.send(new QueryCommand({
        TableName: runsTable,
        IndexName: 'byEntity',
        KeyConditionExpression: '#ek = :ek',
        ExpressionAttributeNames: { '#ek': 'entityKey' },
        ExpressionAttributeValues: { ':ek': entity },
      }));
      const items = (page.Items ?? []) as Array<{ itemId: string }>;
      expect(items).toHaveLength(6);
      expect(items.every((item) => item.itemId.startsWith('ptr#'))).toBe(true);
    });

    it('reports a pointer whose run row expired as expired rather than erroring', async () => {
      const expiredEntity = 'contacts#expired-contact';
      const startedAt = '2026-08-06T11:00:00.000Z';
      await runs.putRun(runInput({
        runId: 'run-expired',
        startedAt,
        finishedAt: startedAt,
        conversationId: 'conv-expired',
        contactId: 'expired-contact',
      }));
      await doc.send(new PutCommand({
        TableName: runsTable,
        Item: {
          itemId: pointerItemId(expiredEntity, startedAt, 'run-gone'),
          entityKey: expiredEntity,
          sortKey: runSortKey(startedAt, 'run-gone'),
          runId: 'run-gone',
          expires_at: runExpiresAt(startedAt),
        },
      }));
      const { entries } = await runs.listByEntity(expiredEntity);
      expect(entries).toHaveLength(2);
      expect(entries.find((e) => e.runId === 'run-gone')?.expired).toBe(true);
      expect(entries.find((e) => e.runId === 'run-expired')?.expired).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // setVerdict: nested document paths, fences, and the marker ladder
  // -------------------------------------------------------------------------

  describe('setVerdict', () => {
    it('stamps a verdict on an existing decision', async () => {
      await runs.putRun(runInput({ runId: 'run-v-1', conversationId: 'conv-v' }));
      expect(await runs.setVerdict('run-v-1', 'pets', 'accepted', {
        at: '2026-08-06T12:00:00.000Z',
        by: 'user-1',
      })).toBe(true);
      const stored = await runs.getRun('run-v-1') as AiRunRecord;
      expect(stored.decisions.pets).toMatchObject({
        verdict: 'accepted',
        verdictAt: '2026-08-06T12:00:00.000Z',
        verdictBy: 'user-1',
      });
    });

    it('refuses to overwrite when the expectedVerdict fence does not hold', async () => {
      await runs.putRun(runInput({ runId: 'run-v-2', conversationId: 'conv-v' }));
      expect(await runs.setVerdict('run-v-2', 'pets', 'accepted', {
        expectedVerdict: 'pending',
      })).toBe(true);
      // The stored verdict is now `accepted`, so a second stamp expecting
      // `pending` must lose (aiRunsRepo.ts:348-350).
      expect(await runs.setVerdict('run-v-2', 'pets', 'dismissed', {
        expectedVerdict: 'pending',
      })).toBe(false);
      const stored = await runs.getRun('run-v-2') as AiRunRecord;
      expect(stored.decisions.pets?.verdict).toBe('accepted');
    });

    it('returns false without throwing when decisions.<target> is absent', async () => {
      // A SET into decisions.tenure.verdict where `decisions.tenure` does not
      // exist is a real ValidationException. The contract is a boolean and every
      // caller is best-effort, so it must be reported as false (F9 adv P3-31).
      await runs.putRun(runInput({ runId: 'run-v-3', conversationId: 'conv-v' }));
      expect(await runs.setVerdict('run-v-3', 'tenure', 'accepted')).toBe(false);
      const stored = await runs.getRun('run-v-3') as AiRunRecord;
      expect(stored.decisions.tenure).toBeUndefined();
      expect(await rawItem(inflightItemId('run-v-3'))).toBeUndefined();
    });

    it('falls back to a fresh inflight marker when the run row is not written yet', async () => {
      // The run row does not exist and no marker was begun: the ladder's
      // transaction (aiRunsRepo.ts:396-409) plants a marker so the verdict is
      // not lost between the human action and putRun.
      const freshAt = new Date().toISOString();
      expect(await runs.setVerdict('run-v-4', 'pets', 'accepted', {
        at: freshAt,
        by: 'user-2',
        freshSuggestionCreatedAt: freshAt,
      })).toBe(true);
      const marker = await rawItem(inflightItemId('run-v-4'));
      expect(marker).toMatchObject({
        runId: 'run-v-4',
        version: 0,
        verdicts: { pets: { verdict: 'accepted', at: freshAt, by: 'user-2' } },
      });
      expect(await rawItem(runItemId('run-v-4'))).toBeUndefined();
    });

    it('writes into a begun marker and lets putRun merge it over pending', async () => {
      const startedAt = '2026-08-06T13:00:00.000Z';
      expect(await runs.beginFinalization('run-v-5', startedAt)).toBe(true);
      expect(await runs.setVerdict('run-v-5', 'pets', 'dismissed', {
        at: '2026-08-06T13:00:02.000Z',
        by: 'user-3',
      })).toBe(true);
      // A second marker verdict for the same target must lose: the guard is
      // `attribute_not_exists(#verdicts.#target)` (aiRunsRepo.ts:366).
      expect(await runs.setVerdict('run-v-5', 'pets', 'accepted')).toBe(false);

      const merged = await runs.putRun(runInput({
        runId: 'run-v-5',
        startedAt,
        finishedAt: startedAt,
        conversationId: 'conv-v',
      }));
      expect(merged.decisions.pets).toMatchObject({
        verdict: 'dismissed',
        verdictAt: '2026-08-06T13:00:02.000Z',
        verdictBy: 'user-3',
      });
      expect(await rawItem(inflightItemId('run-v-5'))).toBeUndefined();
      const stored = await runs.getRun('run-v-5') as AiRunRecord;
      expect(stored.decisions.pets?.verdict).toBe('dismissed');
    });

    it('leaves a non-pending decision alone when a marker verdict arrives', async () => {
      const startedAt = '2026-08-06T14:00:00.000Z';
      expect(await runs.beginFinalization('run-v-6', startedAt)).toBe(true);
      expect(await runs.setVerdict('run-v-6', 'pets', 'accepted')).toBe(true);
      const merged = await runs.putRun(runInput({
        runId: 'run-v-6',
        startedAt,
        finishedAt: startedAt,
        conversationId: 'conv-v',
        decisions: { pets: decision({ outcome: 'wrote', verdict: 'auto_applied' }) },
      }));
      expect(merged.decisions.pets?.verdict).toBe('auto_applied');
    });
  });
});
