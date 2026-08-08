import {
  BatchGetCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import {
  createAiRunsRepo,
  type AiRunRecordInput,
  type AiRunsRepo,
} from '../src/repos/aiRunsRepo.js';
import { createLogCapture } from './helpers/logCapture.js';

type Row = Record<string, unknown>;

function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') {
      depth += 1;
      cur += ch;
    } else if (ch === ')') {
      depth -= 1;
      cur += ch;
    } else if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim().length > 0) out.push(cur);
  return out.map((x) => x.trim());
}

function attrOf(token: string, names: Record<string, string>): string {
  return names[token] ?? token;
}

function conditionHolds(
  expr: string,
  names: Record<string, string>,
  values: Record<string, unknown>,
  row: Row | undefined,
): boolean {
  return expr.split(/\s+AND\s+/i).every((clauseRaw) => {
    const clause = clauseRaw.trim();
    const fn = /^(attribute_exists|attribute_not_exists)\(\s*([#\w]+)\s*\)$/.exec(clause);
    if (fn) {
      const attr = attrOf(fn[2]!, names);
      const exists = row !== undefined && row[attr] !== undefined;
      return fn[1] === 'attribute_exists' ? exists : !exists;
    }
    const cmp = /^([#\w]+)\s*(<=|>=|<|>|=)\s*(:[\w]+)$/.exec(clause);
    if (cmp) {
      if (row === undefined) return false;
      const left = row[attrOf(cmp[1]!, names)];
      if (left === undefined) return false;
      const l = left as string;
      const r = values[cmp[3]!] as string;
      switch (cmp[2]) {
        case '=':
          return l === r;
        case '<=':
          return l <= r;
        case '<':
          return l < r;
        case '>=':
          return l >= r;
        case '>':
          return l > r;
        default:
          throw new Error(`fake doc: unsupported operator ${cmp[2]}`);
      }
    }
    throw new Error(`fake doc: unsupported condition clause "${clause}"`);
  });
}

function applyUpdate(
  expr: string,
  names: Record<string, string>,
  values: Record<string, unknown>,
  row: Row,
): void {
  const kw = /\b(SET|REMOVE|ADD|DELETE)\b/gi;
  const marks: { keyword: string; start: number; bodyStart: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = kw.exec(expr)) !== null) {
    marks.push({ keyword: m[1]!.toUpperCase(), start: m.index, bodyStart: kw.lastIndex });
  }
  for (let i = 0; i < marks.length; i += 1) {
    const start = marks[i]!.bodyStart;
    const stop = i + 1 < marks.length ? marks[i + 1]!.start : expr.length;
    const body = expr.slice(start, stop).trim();
    const keyword = marks[i]!.keyword;
    if (keyword === 'SET') {
      for (const pair of splitTopLevel(body)) {
        const eq = pair.indexOf('=');
        const lhs = pair.slice(0, eq).trim();
        const rhs = pair.slice(eq + 1).trim();
        const path = lhs.split('.').map((tok) => attrOf(tok, names));
        const ine = /^if_not_exists\(\s*([#\w.]+)\s*,\s*(:[\w]+)\s*\)$/i.exec(rhs);
        let target: Record<string, unknown> = row;
        for (const seg of path.slice(0, -1)) {
          const next = target[seg];
          if (next === undefined || typeof next !== 'object') {
            throw new Error(`fake doc: nested SET into a missing path segment ${seg}`);
          }
          target = next as Record<string, unknown>;
        }
        const leaf = path[path.length - 1]!;
        if (ine) {
          const existing = target[attrOf(ine[1]!, names)];
          target[leaf] = existing !== undefined ? existing : values[ine[2]!];
        } else {
          target[leaf] = values[rhs];
        }
      }
    } else if (keyword === 'REMOVE') {
      for (const tok of splitTopLevel(body)) delete row[attrOf(tok, names)];
    } else if (keyword === 'ADD') {
      for (const tok of splitTopLevel(body)) {
        const [nameTok, valTok] = tok.split(/\s+/);
        const attr = attrOf(nameTok!, names);
        const prev = (row[attr] as number | undefined) ?? 0;
        row[attr] = prev + (values[valTok!] as number);
      }
    } else {
      throw new Error(`fake doc: unsupported update keyword ${keyword}`);
    }
  }
}

const INDEX_RANGE: Record<string, string> = { byEntity: 'sortKey' };

interface FakeDoc {
  doc: DynamoDBDocumentClient;
  store: Map<string, Row>;
  batchGetCalls: () => number;
  queryInputs: () => QueryCommandInput[];
}

function makeFakeDoc(opts: { throttleFirstN?: number; failTransactAfter?: number } = {}): FakeDoc {
  const store = new Map<string, Row>();
  let batchGetCalls = 0;
  const queryInputs: QueryCommandInput[] = [];
  const throttleFirstN = opts.throttleFirstN ?? 0;
  const failTransactAfter = opts.failTransactAfter;
  const doc = {
    send: async (cmd: unknown) => {
      if (cmd instanceof GetCommand) {
        const key = cmd.input.Key as { itemId: string };
        const row = store.get(key.itemId);
        return { Item: row ? { ...row } : undefined };
      }
      if (cmd instanceof TransactWriteCommand) {
        const items = (cmd.input.TransactItems ?? []) as Array<{ Put?: { Item: Row } }>;
        if (failTransactAfter !== undefined && items.length > failTransactAfter) {
          throw new TransactionCanceledException({ message: 'cancelled', $metadata: {} });
        }
        for (const it of items) {
          const item = it.Put?.Item;
          if (item === undefined) throw new Error('fake doc: only Put is modelled in transactions');
          const stored: Row = {};
          for (const [k, v] of Object.entries(item)) if (v !== undefined) stored[k] = v;
          store.set(item['itemId'] as string, stored);
        }
        return {};
      }
      if (cmd instanceof BatchGetCommand) {
        batchGetCalls += 1;
        const table = Object.keys(cmd.input.RequestItems ?? {})[0]!;
        const req = cmd.input.RequestItems![table] as { Keys?: Array<{ itemId: string }> };
        const keys = req.Keys ?? [];
        const withhold = batchGetCalls <= throttleFirstN ? keys.slice(Math.ceil(keys.length / 2)) : [];
        const served = keys.filter((k) => !withhold.some((w) => w.itemId === k.itemId));
        const items = served
          .map((k) => store.get(k.itemId))
          .filter((r): r is Row => r !== undefined)
          .map((r) => ({ ...r }))
          .reverse();
        return {
          Responses: { [table]: items },
          ...(withhold.length > 0 && { UnprocessedKeys: { [table]: { Keys: withhold } } }),
        };
      }
      if (cmd instanceof UpdateCommand) {
        const key = cmd.input.Key as { itemId: string };
        const names = cmd.input.ExpressionAttributeNames ?? {};
        const values = cmd.input.ExpressionAttributeValues ?? {};
        const existing = store.get(key.itemId);
        const cond = cmd.input.ConditionExpression;
        if (cond && !conditionHolds(cond, names, values, existing)) {
          throw new ConditionalCheckFailedException({ message: 'update cond', $metadata: {} });
        }
        const row = existing ?? { ...key };
        applyUpdate(cmd.input.UpdateExpression!, names, values, row);
        store.set(key.itemId, row);
        return {};
      }
      if (cmd instanceof QueryCommand) {
        queryInputs.push(cmd.input);
        const names = cmd.input.ExpressionAttributeNames ?? {};
        const values = cmd.input.ExpressionAttributeValues ?? {};
        const rangeAttr = INDEX_RANGE[cmd.input.IndexName!];
        const matched = [...store.values()].filter((row) =>
          conditionHolds(cmd.input.KeyConditionExpression!, names, values, row),
        );
        if (rangeAttr) {
          matched.sort((a, b) => String(a[rangeAttr]).localeCompare(String(b[rangeAttr])));
          if (cmd.input.ScanIndexForward === false) matched.reverse();
        }
        const rows = typeof cmd.input.Limit === 'number' ? matched.slice(0, cmd.input.Limit) : matched;
        // Complete the plan fake so the repository paging contract is exercisable.
        const last = rows[rows.length - 1];
        return {
          Items: rows.map((r) => ({ ...r })),
          ...(last !== undefined && rows.length < matched.length && {
            LastEvaluatedKey: {
              itemId: last['itemId'],
              entityKey: last['entityKey'],
              sortKey: last['sortKey'],
            },
          }),
        };
      }
      throw new Error(`fake doc: unexpected command ${String(cmd)}`);
    },
  } as unknown as DynamoDBDocumentClient;
  return { doc, store, batchGetCalls: () => batchGetCalls, queryInputs: () => queryInputs };
}

function repoWith(doc: DynamoDBDocumentClient) {
  return createAiRunsRepo({
    doc,
    env: { TABLE_PREFIX: 'hc-fake-' } as NodeJS.ProcessEnv,
    logger: createLogger({ destination: createLogCapture().stream }),
  });
}

const STARTED = '2026-08-06T10:00:00.000Z';

function draftRecord(over: Partial<AiRunRecordInput> = {}): AiRunRecordInput {
  return {
    runId: 'run-1',
    startedAt: STARTED,
    finishedAt: '2026-08-06T10:00:02.000Z',
    durationMs: 2000,
    conversationId: 'conv-1',
    contactId: 'contact-1',
    trigger: 'sms',
    outcome: 'applied',
    driver: 'fake',
    decisions: {},
    notedLines: 0,
    ...over,
  };
}

describe('aiRunsRepo - putRun', () => {
  it('writes ONE run# row plus one ptr# row per dimension, all sharing expires_at', async () => {
    const { doc, store } = makeFakeDoc();
    const saved = await repoWith(doc).putRun(draftRecord());

    expect(saved.itemId).toBe('run#run-1');
    const ttl = Math.floor(Date.parse(STARTED) / 1000) + 90 * 24 * 60 * 60;
    expect(saved.expires_at).toBe(ttl);

    expect([...store.keys()].sort()).toEqual([
      'ptr#contacts#contact-1#2026-08-06T10:00:00.000Z#run-1',
      'ptr#conversations#conv-1#2026-08-06T10:00:00.000Z#run-1',
      'ptr#global#2026-08-06T10:00:00.000Z#run-1',
      'ptr#outcome#applied#2026-08-06T10:00:00.000Z#run-1',
      'run#run-1',
    ]);
    for (const id of store.keys()) expect(store.get(id)!['expires_at']).toBe(ttl);
  });

  it('writes the run and its pointers ATOMICALLY - a rejected transaction leaves nothing', async () => {
    const { doc, store } = makeFakeDoc({ failTransactAfter: 2 });
    await expect(repoWith(doc).putRun(draftRecord())).rejects.toThrow();
    expect([...store.keys()]).toEqual([]);
  });

  it('the run# row carries NO entityKey/sortKey, so it never enters byEntity', async () => {
    const { doc, store } = makeFakeDoc();
    await repoWith(doc).putRun(draftRecord());
    expect(store.get('run#run-1')!['entityKey']).toBeUndefined();
    expect(store.get('run#run-1')!['sortKey']).toBeUndefined();
  });

  it('pointer rows are PURE pointers - keys, runId, ttl, nothing denormalized', async () => {
    const { doc, store } = makeFakeDoc();
    await repoWith(doc).putRun(draftRecord());
    const ptr = store.get('ptr#global#2026-08-06T10:00:00.000Z#run-1')!;
    expect(Object.keys(ptr).sort()).toEqual(['entityKey', 'expires_at', 'itemId', 'runId', 'sortKey']);
    expect(ptr['sortKey']).toBe('2026-08-06T10:00:00.000Z#run-1');
  });

  it('omits the contacts pointer when no contact resolved', async () => {
    const { doc, store } = makeFakeDoc();
    const input = draftRecord();
    delete (input as { contactId?: string }).contactId;
    await repoWith(doc).putRun(input);
    expect([...store.keys()].filter((k) => k.startsWith('ptr#'))).toHaveLength(3);
    expect([...store.keys()].some((k) => k.startsWith('ptr#contacts#'))).toBe(false);
  });

  it('round-trips the full record through getRun', async () => {
    const { doc } = makeFakeDoc();
    const repo = repoWith(doc);
    await repo.putRun(draftRecord({
      rawText: '{"fields":{}}',
      notedLines: 2,
      decisions: {
        pets: { proposedOp: 'write', proposedValue: 'one cat', outcome: 'wrote', verdict: 'auto_applied' },
      },
    }));
    const got = await repo.getRun('run-1');
    expect(got?.decisions['pets']?.verdict).toBe('auto_applied');
    expect(got?.notedLines).toBe(2);
    expect(got?.rawText).toBe('{"fields":{}}');
  });
});

describe('aiRunsRepo - listByEntity', () => {
  async function seed(repo: AiRunsRepo, n: number): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      await repo.putRun(draftRecord({
        runId: `run-${String(i).padStart(2, '0')}`,
        startedAt: `2026-08-06T10:${String(i).padStart(2, '0')}:00.000Z`,
      }));
    }
  }

  it('returns runs NEWEST-FIRST and never trusts BatchGetItem response order', async () => {
    const { doc } = makeFakeDoc();
    const repo = repoWith(doc);
    await seed(repo, 5);
    const { entries } = await repo.listByEntity('global');
    expect(entries.map((e) => e.runId)).toEqual(['run-04', 'run-03', 'run-02', 'run-01', 'run-00']);
  });

  it('declares the sortKey alias only when its query condition uses sortKey', async () => {
    const { doc, queryInputs } = makeFakeDoc();
    const repo = repoWith(doc);
    await seed(repo, 2);

    await repo.listByEntity('global');
    await repo.listByEntity('global', { before: '2026-08-06T10:01:00.000Z#run-01' });
    await repo.listByEntity('global', { from: '2026-08-06T10:00:00.000Z' });
    await repo.listByEntity('global', { to: '2026-08-06T10:01:00.000Z' });

    expect(queryInputs()[0]!.ExpressionAttributeNames).toEqual({ '#ek': 'entityKey' });
    for (const input of queryInputs().slice(1)) {
      expect(input.ExpressionAttributeNames).toEqual({ '#ek': 'entityKey', '#sk': 'sortKey' });
    }
  });

  it('pages at 25 by default and hands back a nextBefore cursor', async () => {
    const { doc } = makeFakeDoc();
    const repo = repoWith(doc);
    await seed(repo, 30);
    const page1 = await repo.listByEntity('global');
    expect(page1.entries).toHaveLength(25);
    expect(page1.nextBefore).toBe(page1.entries[24]!.sortKey);
    const page2 = await repo.listByEntity('global', { before: page1.nextBefore });
    expect(page2.entries).toHaveLength(5);
    expect(page2.nextBefore).toBeUndefined();
    expect(new Set([...page1.entries, ...page2.entries].map((e) => e.runId)).size).toBe(30);
  });

  it('retries UnprocessedKeys before rendering a partial page', async () => {
    const { doc, batchGetCalls } = makeFakeDoc({ throttleFirstN: 2 });
    const repo = repoWith(doc);
    await seed(repo, 6);
    const { entries } = await repo.listByEntity('global');
    expect(entries).toHaveLength(6);
    expect(entries.every((e) => e.expired === false)).toBe(true);
    expect(batchGetCalls()).toBeGreaterThan(1);
  });

  it('renders a pointer whose run# row already TTLd as expired, never erroring', async () => {
    const { doc, store } = makeFakeDoc();
    const repo = repoWith(doc);
    await seed(repo, 3);
    store.delete('run#run-01');
    const { entries } = await repo.listByEntity('global');
    expect(entries.map((e) => `${e.runId}:${String(e.expired)}`)).toEqual([
      'run-02:false', 'run-01:true', 'run-00:false',
    ]);
  });

  it('scopes by outcome, conversation and contact through their pointer partitions', async () => {
    const { doc } = makeFakeDoc();
    const repo = repoWith(doc);
    await repo.putRun(draftRecord({ runId: 'a', startedAt: '2026-08-06T10:00:00.000Z' }));
    await repo.putRun(draftRecord({
      runId: 'b',
      startedAt: '2026-08-06T10:01:00.000Z',
      outcome: 'no_op',
      conversationId: 'conv-2',
      contactId: 'contact-2',
    }));
    const ids = async (k: string) => (await repo.listByEntity(k)).entries.map((e) => e.runId);
    expect(await ids('outcome#applied')).toEqual(['a']);
    expect(await ids('outcome#no_op')).toEqual(['b']);
    expect(await ids('conversations#conv-2')).toEqual(['b']);
    expect(await ids('contacts#contact-1')).toEqual(['a']);
    expect(await ids('global')).toEqual(['b', 'a']);
  });

  it('narrows to a date range on sortKey', async () => {
    const { doc } = makeFakeDoc();
    const repo = repoWith(doc);
    await seed(repo, 5);
    const { entries } = await repo.listByEntity('global', {
      from: '2026-08-06T10:01:00.000Z',
      to: '2026-08-06T10:03:00.000Z',
    });
    expect(entries.map((e) => e.runId)).toEqual(['run-03', 'run-02', 'run-01']);
  });

  it('returns an empty page for an unknown scope without erroring', async () => {
    const { doc } = makeFakeDoc();
    const out = await repoWith(doc).listByEntity('contacts#nobody');
    expect(out.entries).toEqual([]);
    expect(out.nextBefore).toBeUndefined();
  });
});

describe('aiRunsRepo - setVerdict', () => {
  it('stamps verdict, verdictAt and verdictBy on ONE decision, leaving siblings untouched', async () => {
    const { doc } = makeFakeDoc();
    const repo = repoWith(doc);
    await repo.putRun(draftRecord({
      decisions: {
        pets: { proposedOp: 'suggest', outcome: 'suggested', verdict: 'pending' },
        tenure: { proposedOp: 'suggest', outcome: 'suggested', verdict: 'pending' },
      },
    }));
    const ok = await repo.setVerdict('run-1', 'pets', 'accepted', {
      at: '2026-08-06T11:00:00.000Z',
      by: 'usr_1',
    });
    expect(ok).toBe(true);
    const run = await repo.getRun('run-1');
    expect(run?.decisions['pets']).toEqual({
      proposedOp: 'suggest',
      outcome: 'suggested',
      verdict: 'accepted',
      verdictAt: '2026-08-06T11:00:00.000Z',
      verdictBy: 'usr_1',
    });
    expect(run?.decisions['tenure']?.verdict).toBe('pending');
  });

  it('returns false and creates NOTHING when the run row has already expired', async () => {
    const { doc, store } = makeFakeDoc();
    const ok = await repoWith(doc).setVerdict('run-gone', 'pets', 'accepted', {
      at: '2026-08-06T11:00:00.000Z',
    });
    expect(ok).toBe(false);
    expect([...store.keys()]).toHaveLength(0);
  });

  it('omits verdictBy when no actor is known (a job-written superseded stamp)', async () => {
    const { doc } = makeFakeDoc();
    const repo = repoWith(doc);
    await repo.putRun(draftRecord({
      decisions: { pets: { proposedOp: 'suggest', outcome: 'suggested', verdict: 'pending' } },
    }));
    await repo.setVerdict('run-1', 'pets', 'superseded', { at: '2026-08-06T11:00:00.000Z' });
    const run = await repo.getRun('run-1');
    expect(run?.decisions['pets']?.verdict).toBe('superseded');
    expect(run?.decisions['pets']?.verdictBy).toBeUndefined();
  });
});
