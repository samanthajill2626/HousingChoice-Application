// Fast unit tests: placementNudgesRepo operator-facing listByPlacement + the
// per-nudge cancel/uncancel conditional writes (placement-detail-hub Task 1).
//
// These are the in-memory twins of the DynamoDB Local coverage in
// placementNudgesRepo.integration.test.ts: a tiny fake doc client that EVALUATES
// the same attribute_exists / attribute_not_exists ConditionExpressions the repo
// builds, so a lost race (sentAt already stamped) or an already-terminal row
// resolves to the honest `false` WITHOUT needing Docker. Mirrors the cancel /
// uncancel idiom of tourRemindersRepo (see app/src/repos/tourRemindersRepo.ts).
import {
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import {
  createPlacementNudgesRepo,
  type PlacementNudgeItem,
} from '../src/repos/placementNudgesRepo.js';
import { createLogCapture } from './helpers/logCapture.js';

// ---------------------------------------------------------------------------
// A fake doc client that models the nudge table well enough to exercise the
// conditional writes: a nudgeId-keyed store + a mini evaluator for the
// `attribute_exists(#x) AND attribute_not_exists(#y)` conditions the repo uses.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

/** Evaluate an AND-joined chain of attribute_exists / attribute_not_exists. */
function conditionHolds(
  expr: string,
  names: Record<string, string>,
  row: Row | undefined,
): boolean {
  return expr.split(/\s+AND\s+/i).every((clauseRaw) => {
    const clause = clauseRaw.trim();
    const m = /(attribute_exists|attribute_not_exists)\((#?[\w]+)\)/.exec(clause);
    if (!m) throw new Error(`fake doc: unsupported condition clause "${clause}"`);
    const [, fn, token] = m;
    const attr = token!.startsWith('#') ? names[token!]! : token!;
    const exists = row !== undefined && row[attr] !== undefined;
    return fn === 'attribute_exists' ? exists : !exists;
  });
}

/** Apply a single-clause `SET #a = :v` or `REMOVE #a` UpdateExpression. */
function applyUpdate(
  expr: string,
  names: Record<string, string>,
  values: Record<string, unknown>,
  row: Row,
): void {
  const set = /^SET\s+(.+)$/i.exec(expr.trim());
  if (set) {
    for (const pair of set[1]!.split(',')) {
      const [nameTok, valTok] = pair.split('=').map((s) => s.trim());
      row[names[nameTok!]!] = values[valTok!];
    }
    return;
  }
  const remove = /^REMOVE\s+(.+)$/i.exec(expr.trim());
  if (remove) {
    for (const nameTok of remove[1]!.split(',')) {
      delete row[names[nameTok!.trim()]!];
    }
    return;
  }
  throw new Error(`fake doc: unsupported UpdateExpression "${expr}"`);
}

interface FakeDoc {
  doc: DynamoDBDocumentClient;
  store: Map<string, Row>;
  lastUpdate: () => UpdateCommand | undefined;
  /** Seed a row directly (bypasses create — lets tests forge terminal states). */
  seed: (row: Row) => void;
}

function makeFakeDoc(): FakeDoc {
  const store = new Map<string, Row>();
  let lastUpdate: UpdateCommand | undefined;
  const doc = {
    send: async (cmd: unknown) => {
      if (cmd instanceof PutCommand) {
        const item = cmd.input.Item as Row;
        const cond = cmd.input.ConditionExpression;
        if (cond && !conditionHolds(cond, {}, store.get(item['nudgeId'] as string))) {
          throw new ConditionalCheckFailedException({ message: 'put cond', $metadata: {} });
        }
        store.set(item['nudgeId'] as string, { ...item });
        return {};
      }
      if (cmd instanceof UpdateCommand) {
        lastUpdate = cmd;
        const key = cmd.input.Key as { nudgeId: string };
        const row = store.get(key.nudgeId);
        const names = cmd.input.ExpressionAttributeNames ?? {};
        const cond = cmd.input.ConditionExpression;
        if (cond && !conditionHolds(cond, names, row)) {
          throw new ConditionalCheckFailedException({ message: 'update cond', $metadata: {} });
        }
        applyUpdate(
          cmd.input.UpdateExpression!,
          names,
          cmd.input.ExpressionAttributeValues ?? {},
          row!,
        );
        return {};
      }
      if (cmd instanceof QueryCommand) {
        const wantPlacement = cmd.input.ExpressionAttributeValues?.[':placementId'];
        const Items = [...store.values()].filter((r) => r['placementId'] === wantPlacement);
        return { Items };
      }
      throw new Error(`fake doc: unexpected command ${String(cmd)}`);
    },
  } as unknown as DynamoDBDocumentClient;
  return { doc, store, lastUpdate: () => lastUpdate, seed: (row) => store.set(row['nudgeId'] as string, { ...row }) };
}

function repoWith(doc: DynamoDBDocumentClient) {
  return createPlacementNudgesRepo({
    doc,
    env: { TABLE_PREFIX: 'hc-fake-' } as NodeJS.ProcessEnv,
    logger: createLogger({ destination: createLogCapture().stream }),
  });
}

function forge(overrides: Partial<PlacementNudgeItem> & { nudgeId: string; placementId: string }): Row {
  return {
    kind: 'receipt_check',
    dueAt: '2026-07-05T09:00:00.000Z',
    _nudgePartition: 'nudges',
    createdAt: '2026-07-03T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// listByPlacement
// ---------------------------------------------------------------------------

describe('placementNudgesRepo.listByPlacement', () => {
  it('returns only the requested placement rows (byPlacement GSI scoping)', async () => {
    const { doc } = makeFakeDoc();
    const repo = repoWith(doc);
    await repo.create({ placementId: 'p-1', kind: 'receipt_check', dueAt: '2026-07-05T09:00:00.000Z' });
    await repo.create({ placementId: 'p-1', kind: 'completion_check', dueAt: '2026-07-06T09:00:00.000Z' });
    await repo.create({ placementId: 'p-2', kind: 'approval_check', dueAt: '2026-07-07T09:00:00.000Z' });

    const p1 = await repo.listByPlacement('p-1');
    expect(p1).toHaveLength(2);
    expect(p1.every((r) => r.placementId === 'p-1')).toBe(true);
    expect(p1.map((r) => r.kind).sort()).toEqual(['completion_check', 'receipt_check']);

    expect(await repo.listByPlacement('p-2')).toHaveLength(1);
    expect(await repo.listByPlacement('p-missing')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

describe('placementNudgesRepo.cancel', () => {
  it('cancels a pending row (SET canceledAt) and returns true', async () => {
    const { doc, lastUpdate } = makeFakeDoc();
    const repo = repoWith(doc);
    const row = await repo.create({ placementId: 'p-1', kind: 'receipt_check', dueAt: '2026-07-05T09:00:00.000Z' });

    const canceledAt = '2026-07-04T12:00:00.000Z';
    expect(await repo.cancel(row.nudgeId, canceledAt)).toBe(true);

    // The stamp landed and the built command carries the no-terminal guard.
    const [after] = await repo.listByPlacement('p-1');
    expect(after!.canceledAt).toBe(canceledAt);
    expect(after!.sentAt).toBeUndefined();
    const cond = lastUpdate()!.input.ConditionExpression!;
    expect(cond).toContain('attribute_not_exists(#sentAt)');
    expect(cond).toContain('attribute_not_exists(#canceledAt)');
  });

  it('returns false when sentAt is already set (lost race to the poll) and leaves the row untouched', async () => {
    const { doc, seed } = makeFakeDoc();
    const repo = repoWith(doc);
    seed(forge({ nudgeId: 'nudge-sent', placementId: 'p-1', sentAt: '2026-07-04T00:00:00.000Z' }));

    expect(await repo.cancel('nudge-sent', '2026-07-04T12:00:00.000Z')).toBe(false);
    const [row] = await repo.listByPlacement('p-1');
    expect(row!.sentAt).toBe('2026-07-04T00:00:00.000Z');
    expect(row!.canceledAt).toBeUndefined();
  });

  it('returns false when the row is already canceled (idempotent no-op)', async () => {
    const { doc } = makeFakeDoc();
    const repo = repoWith(doc);
    const row = await repo.create({ placementId: 'p-1', kind: 'receipt_check', dueAt: '2026-07-05T09:00:00.000Z' });

    expect(await repo.cancel(row.nudgeId, '2026-07-04T12:00:00.000Z')).toBe(true);
    expect(await repo.cancel(row.nudgeId, '2026-07-04T13:00:00.000Z')).toBe(false);
    // The first cancel's stamp is preserved (a second cancel never overwrites it).
    const [after] = await repo.listByPlacement('p-1');
    expect(after!.canceledAt).toBe('2026-07-04T12:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// uncancel
// ---------------------------------------------------------------------------

describe('placementNudgesRepo.uncancel', () => {
  it('removes canceledAt from a canceled row (REMOVE) and returns true', async () => {
    const { doc, lastUpdate } = makeFakeDoc();
    const repo = repoWith(doc);
    const row = await repo.create({ placementId: 'p-1', kind: 'receipt_check', dueAt: '2026-07-05T09:00:00.000Z' });
    await repo.cancel(row.nudgeId, '2026-07-04T12:00:00.000Z');

    expect(await repo.uncancel(row.nudgeId)).toBe(true);
    const [after] = await repo.listByPlacement('p-1');
    expect(after!.canceledAt).toBeUndefined();
    const cond = lastUpdate()!.input.ConditionExpression!;
    expect(cond).toContain('attribute_exists(#canceledAt)');
    expect(cond).toContain('attribute_not_exists(#sentAt)');
  });

  it('returns false when the row was never canceled', async () => {
    const { doc } = makeFakeDoc();
    const repo = repoWith(doc);
    const row = await repo.create({ placementId: 'p-1', kind: 'receipt_check', dueAt: '2026-07-05T09:00:00.000Z' });

    expect(await repo.uncancel(row.nudgeId)).toBe(false);
  });

  it('never resurrects a sent row (a canceledAt+sentAt row stays sent, false)', async () => {
    const { doc, seed } = makeFakeDoc();
    const repo = repoWith(doc);
    // Forge the pathological both-stamped row: the sentAt guard must win.
    seed(
      forge({
        nudgeId: 'nudge-both',
        placementId: 'p-1',
        sentAt: '2026-07-04T00:00:00.000Z',
        canceledAt: '2026-07-04T01:00:00.000Z',
      }),
    );

    expect(await repo.uncancel('nudge-both')).toBe(false);
    const [row] = await repo.listByPlacement('p-1');
    expect(row!.sentAt).toBe('2026-07-04T00:00:00.000Z');
    expect(row!.canceledAt).toBe('2026-07-04T01:00:00.000Z');
  });
});
