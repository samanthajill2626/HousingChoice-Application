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
  DynamoDBServiceException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import {
  createAiRunsRepo,
  runExpiresAt,
  type AiRunRecordInput,
  type AiRunsRepo,
} from '../src/repos/aiRunsRepo.js';
import { createLogCapture, type LogCapture } from './helpers/logCapture.js';

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
  return token.split('.').map((part) => names[part] ?? part).join('.');
}

function valueAt(row: Row, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) =>
    value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined,
  row);
}

/**
 * The DynamoDB error the SDK raises for an invalid expression. It is NOT a
 * modeled exception class in @aws-sdk/client-dynamodb - it arrives as a
 * DynamoDBServiceException whose `name` is 'ValidationException', which is what
 * src detects (suggestionResolutionRepo.ts's isValidationFailure).
 */
function validationException(message: string): DynamoDBServiceException {
  return new DynamoDBServiceException({
    name: 'ValidationException',
    $fault: 'client',
    $metadata: { httpStatusCode: 400 },
    message,
  });
}

/**
 * Split on top-level AND while keeping `BETWEEN :a AND :b` whole. A naive
 * split shatters a BETWEEN clause into two unparseable fragments.
 */
function splitConditions(expr: string): string[] {
  const parts = expr.split(/\s+AND\s+/i);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!.trim();
    if (/\sBETWEEN\s/i.test(` ${part} `) && i + 1 < parts.length) {
      out.push(`${part} AND ${parts[i + 1]!.trim()}`);
      i += 1;
      continue;
    }
    out.push(part);
  }
  return out;
}

const BETWEEN_CLAUSE = /^([#\w.]+)\s+BETWEEN\s+(:[\w]+)\s+AND\s+(:[\w]+)$/i;
const COMPARE_CLAUSE = /^([#\w.]+)\s*(<=|>=|<|>|=)\s*(:[\w]+)$/;
const FUNCTION_CLAUSE = /^(attribute_exists|attribute_not_exists)\(\s*([#\w.]+)\s*\)$/;

/** The attribute one clause constrains, resolved through the name aliases. */
function clauseAttribute(clause: string, names: Record<string, string>): string | undefined {
  const fn = FUNCTION_CLAUSE.exec(clause);
  if (fn) return attrOf(fn[2]!, names);
  const btw = BETWEEN_CLAUSE.exec(clause);
  if (btw) return attrOf(btw[1]!, names);
  const cmp = COMPARE_CLAUSE.exec(clause);
  return cmp ? attrOf(cmp[1]!, names) : undefined;
}

function conditionHolds(
  expr: string,
  names: Record<string, string>,
  values: Record<string, unknown>,
  row: Row | undefined,
): boolean {
  return splitConditions(expr).every((clauseRaw) => {
    const clause = clauseRaw.trim();
    const fn = FUNCTION_CLAUSE.exec(clause);
    if (fn) {
      const attr = attrOf(fn[2]!, names);
      const exists = row !== undefined && valueAt(row, attr) !== undefined;
      return fn[1] === 'attribute_exists' ? exists : !exists;
    }
    const btw = BETWEEN_CLAUSE.exec(clause);
    if (btw) {
      if (row === undefined) return false;
      const left = valueAt(row, attrOf(btw[1]!, names));
      if (left === undefined) return false;
      const l = left as string;
      // DynamoDB BETWEEN is inclusive on BOTH bounds.
      return l >= (values[btw[2]!] as string) && l <= (values[btw[3]!] as string);
    }
    const cmp = COMPARE_CLAUSE.exec(clause);
    if (cmp) {
      if (row === undefined) return false;
      const left = valueAt(row, attrOf(cmp[1]!, names));
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
            // Real DynamoDB rejects a SET into a missing document path with a
            // ValidationException, NOT a ConditionalCheckFailedException.
            throw validationException(
              `The document path provided in the update expression is invalid for update: ${seg}`,
            );
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
  getInputs: () => GetCommand[];
  rejectedTransactionKeys: () => string[][];
}

function makeFakeDoc(opts: {
  throttleFirstN?: number;
  /**
   * Echo exactly these itemIds as UnprocessedKeys on EVERY BatchGet that asks
   * for them - a chunk-local, call-count-independent withhold. `throttleFirstN`
   * cannot express this: it halves the withheld set on each retry and counts
   * calls across chunks, so it always drains and can never leave a FIXED
   * leftover behind after the retry budget. When this option is absent the
   * `throttleFirstN` behaviour is untouched.
   */
  withholdItemIds?: string[];
  failTransactAfter?: number;
  beforeFirstMarkerTransaction?: (store: Map<string, Row>) => void;
  hideFirstMarkerGet?: boolean;
} = {}): FakeDoc {
  const store = new Map<string, Row>();
  let batchGetCalls = 0;
  const queryInputs: QueryCommandInput[] = [];
  const getInputs: GetCommand[] = [];
  const rejectedTransactionKeys: string[][] = [];
  const throttleFirstN = opts.throttleFirstN ?? 0;
  const withholdItemIds = new Set(opts.withholdItemIds ?? []);
  const failTransactAfter = opts.failTransactAfter;
  let markerTransactionIntercepted = false;
  let markerGets = 0;
  const doc = {
    send: async (cmd: unknown) => {
      if (cmd instanceof GetCommand) {
        getInputs.push(cmd);
        const key = cmd.input.Key as { itemId: string };
        if (key.itemId.startsWith('inflight#') && opts.hideFirstMarkerGet && markerGets++ === 0) {
          return { Item: undefined };
        }
        const row = store.get(key.itemId);
        return { Item: row ? { ...row } : undefined };
      }
      if (cmd instanceof TransactWriteCommand) {
        const items = (cmd.input.TransactItems ?? []) as Array<{
          Put?: { Item: Row; ConditionExpression?: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown> };
          Delete?: { Key: { itemId: string }; ConditionExpression?: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown> };
          ConditionCheck?: { Key: { itemId: string }; ConditionExpression: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown> };
        }>;
        if (failTransactAfter !== undefined && items.length > failTransactAfter) {
          throw new TransactionCanceledException({ message: 'cancelled', $metadata: {} });
        }
        if (!markerTransactionIntercepted && items.some((item) => item.Delete?.Key.itemId.startsWith('inflight#'))) {
          markerTransactionIntercepted = true;
          opts.beforeFirstMarkerTransaction?.(store);
        }
        for (const it of items) {
          const conditional = it.ConditionCheck ?? it.Delete ?? it.Put;
          const conditionKey = it.ConditionCheck?.Key ?? it.Delete?.Key ?? { itemId: it.Put?.Item['itemId'] as string };
          if (conditional !== undefined && conditional.ConditionExpression && !conditionHolds(conditional.ConditionExpression, conditional.ExpressionAttributeNames ?? {}, conditional.ExpressionAttributeValues ?? {}, store.get(conditionKey.itemId))) {
            rejectedTransactionKeys.push([...store.keys()].sort());
            // Do not provide CancellationReasons: the SDK does not always expose
            // them, and putRun must still retry a marker-backed cancellation.
            throw new TransactionCanceledException({ message: 'cancelled', $metadata: {} });
          }
        }
        for (const it of items) {
          const item = it.Put?.Item;
          if (it.Delete !== undefined) { store.delete(it.Delete.Key.itemId); continue; }
          if (it.ConditionCheck !== undefined) continue;
          if (item === undefined) throw new Error('fake doc: transaction item missing action');
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
        // Real BatchGetItem rejects more than 100 keys per request with a
        // ValidationException. The fake used to serve any number, which is why
        // an unchunked BatchGet passed its own unit tests.
        if (keys.length > 100) {
          throw validationException('Too many items requested for the BatchGetItem call');
        }
        const withhold = withholdItemIds.size > 0
          ? keys.filter((k) => withholdItemIds.has(k.itemId))
          : (batchGetCalls <= throttleFirstN ? keys.slice(Math.ceil(keys.length / 2)) : []);
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
        // A KeyConditionExpression may carry AT MOST ONE condition on the range
        // key. Real DynamoDB raises a ValidationException for a second one; the
        // fake used to evaluate them as an ordinary JS conjunction, which is why
        // an invalid from+to query passed its own unit test.
        if (rangeAttr !== undefined) {
          const rangeClauses = splitConditions(cmd.input.KeyConditionExpression!)
            .filter((clause) => clauseAttribute(clause, names) === rangeAttr);
          if (rangeClauses.length > 1) {
            throw validationException(
              'Invalid KeyConditionExpression: The expression can only contain one condition on the range key',
            );
          }
        }
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
  return {
    doc,
    store,
    batchGetCalls: () => batchGetCalls,
    queryInputs: () => queryInputs,
    getInputs: () => getInputs,
    rejectedTransactionKeys: () => rejectedTransactionKeys,
  };
}

function repoWith(doc: DynamoDBDocumentClient, capture: LogCapture = createLogCapture()) {
  return createAiRunsRepo({
    doc,
    env: { TABLE_PREFIX: 'hc-fake-' } as NodeJS.ProcessEnv,
    logger: createLogger({ destination: capture.stream }),
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

  it('retries a marker version race without cancellation reasons and commits only the merged envelope', async () => {
    const { doc, store, rejectedTransactionKeys } = makeFakeDoc({
      beforeFirstMarkerTransaction: (rows) => {
        const marker = rows.get('inflight#run-1')!;
        marker['verdicts'] = { pets: { verdict: 'accepted', at: '2026-08-06T10:01:00.000Z', by: 'usr_1' } };
        marker['version'] = 1;
      },
    });
    const repo = repoWith(doc);
    await repo.beginFinalization('run-1', STARTED);

    const saved = await repo.putRun(draftRecord({
      decisions: { pets: { proposedOp: 'suggest', outcome: 'suggested', verdict: 'pending' } },
    }));

    expect(rejectedTransactionKeys()).toEqual([['inflight#run-1']]);
    expect(saved.decisions['pets']).toEqual({
      proposedOp: 'suggest', outcome: 'suggested', verdict: 'accepted',
      verdictAt: '2026-08-06T10:01:00.000Z', verdictBy: 'usr_1',
    });
    expect([...store.keys()].sort()).toEqual([
      'ptr#contacts#contact-1#2026-08-06T10:00:00.000Z#run-1',
      'ptr#conversations#conv-1#2026-08-06T10:00:00.000Z#run-1',
      'ptr#global#2026-08-06T10:00:00.000Z#run-1',
      'ptr#outcome#applied#2026-08-06T10:00:00.000Z#run-1',
      'run#run-1',
    ]);
    expect((store.get('run#run-1')!['decisions'] as Record<string, Row>)['pets']).toEqual(saved.decisions['pets']);
  });

  it('retries a stale marker read after a late marker atomically blocks the first envelope write', async () => {
    const { doc, store, getInputs, rejectedTransactionKeys } = makeFakeDoc({ hideFirstMarkerGet: true });
    const repo = repoWith(doc);
    await repo.beginFinalization('run-1', STARTED);
    await repo.setVerdict('run-1', 'pets', 'accepted', { at: '2026-08-06T10:01:00.000Z', expectedVerdict: 'pending' });

    const saved = await repo.putRun(draftRecord({
      decisions: { pets: { proposedOp: 'suggest', outcome: 'suggested', verdict: 'pending' } },
    }));

    expect(getInputs()[0]!.input.ConsistentRead).toBe(true);
    expect(rejectedTransactionKeys()).toEqual([['inflight#run-1']]);
    expect(saved.decisions['pets']?.verdict).toBe('accepted');
    expect([...store.keys()].sort()).toEqual([
      'ptr#contacts#contact-1#2026-08-06T10:00:00.000Z#run-1',
      'ptr#conversations#conv-1#2026-08-06T10:00:00.000Z#run-1',
      'ptr#global#2026-08-06T10:00:00.000Z#run-1',
      'ptr#outcome#applied#2026-08-06T10:00:00.000Z#run-1',
      'run#run-1',
    ]);
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

  // `seed` interpolates i into the MINUTES field, so it only yields real,
  // lexicographically ordered timestamps up to n=60. Past the 100-key
  // BatchGet ceiling we need genuine ones, so walk seconds too.
  async function seedMany(repo: AiRunsRepo, n: number): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      const minutes = String(Math.floor(i / 60)).padStart(2, '0');
      const seconds = String(i % 60).padStart(2, '0');
      await repo.putRun(draftRecord({
        runId: `run-${String(i).padStart(3, '0')}`,
        startedAt: `2026-08-06T10:${minutes}:${seconds}.000Z`,
      }));
    }
  }

  it('chunks a BatchGet above the 100-key ceiling instead of faulting', async () => {
    const { doc, batchGetCalls } = makeFakeDoc();
    const repo = repoWith(doc);
    await seedMany(repo, 150);
    const { entries } = await repo.listByEntity('global', { limit: 150 });
    expect(entries).toHaveLength(150);
    expect(entries.every((entry) => entry.expired === false)).toBe(true);
    expect(batchGetCalls()).toBe(2);
  });

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
    await repo.listByEntity('global', { from: '2026-08-06T10:00:00.000Z', to: '2026-08-06T10:01:00.000Z' });

    expect(queryInputs()[0]!.ExpressionAttributeNames).toEqual({ '#ek': 'entityKey' });
    for (const input of queryInputs().slice(1)) {
      expect(input.ExpressionAttributeNames).toEqual({ '#ek': 'entityKey', '#sk': 'sortKey' });
    }
    // One emitted form per bound combination, and never an unbound alias/value.
    expect(queryInputs().map((i) => i.KeyConditionExpression)).toEqual([
      '#ek = :ek',
      '#ek = :ek AND #sk < :upper',
      '#ek = :ek AND #sk >= :lower',
      '#ek = :ek AND #sk <= :upper',
      '#ek = :ek AND #sk BETWEEN :lower AND :upper',
    ]);
    expect(Object.keys(queryInputs()[0]!.ExpressionAttributeValues!).sort()).toEqual([':ek']);
    expect(Object.keys(queryInputs()[1]!.ExpressionAttributeValues!).sort()).toEqual([':ek', ':upper']);
    expect(Object.keys(queryInputs()[2]!.ExpressionAttributeValues!).sort()).toEqual([':ek', ':lower']);
    expect(Object.keys(queryInputs()[3]!.ExpressionAttributeValues!).sort()).toEqual([':ek', ':upper']);
    expect(Object.keys(queryInputs()[4]!.ExpressionAttributeValues!).sort()).toEqual([':ek', ':lower', ':upper']);
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

  // Keys STILL unprocessed after the whole 4-attempt budget are sustained
  // pressure, not a TTL reap. Rendering them as plain expired told an operator
  // the forensic record was gone when it was merely unread.
  it('reports keys unprocessed after the retry budget as unavailable, not expired', async () => {
    const { doc, batchGetCalls } = makeFakeDoc({ withholdItemIds: ['run#run-01', 'run#run-03'] });
    const repo = repoWith(doc);
    await seed(repo, 5);
    const { entries } = await repo.listByEntity('global');
    expect(entries).toHaveLength(5);
    expect(entries.filter((e) => e.expired && e.unavailable === true).map((e) => e.runId))
      .toEqual(['run-03', 'run-01']);
    // The rest of the page is untouched - one throttled key does not degrade it.
    expect(entries.filter((e) => !e.expired).map((e) => e.runId)).toEqual(['run-04', 'run-02', 'run-00']);
    // The full retry budget was spent before giving up on those two keys.
    expect(batchGetCalls()).toBe(4);
  });

  it('leaves a genuinely absent run# row a plain expired entry, with no unavailable key', async () => {
    const { doc, store } = makeFakeDoc({ withholdItemIds: ['run#run-02'] });
    const repo = repoWith(doc);
    await seed(repo, 4);
    store.delete('run#run-01');
    const { entries } = await repo.listByEntity('global');
    const reaped = entries.find((e) => e.runId === 'run-01');
    const throttled = entries.find((e) => e.runId === 'run-02');
    expect(reaped).toEqual({ runId: 'run-01', sortKey: '2026-08-06T10:01:00.000Z#run-01', expired: true });
    // toEqual treats an explicit `undefined` as absent, so assert the KEY.
    expect(Object.hasOwn(reaped!, 'unavailable')).toBe(false);
    expect(throttled).toEqual({
      runId: 'run-02', sortKey: '2026-08-06T10:02:00.000Z#run-02', expired: true, unavailable: true,
    });
  });

  // The leftovers are chunk-local: the first chunk's `keys` binding is gone by
  // the time the second chunk runs, so they have to be accumulated per call.
  it('accumulates unprocessed keys across BOTH chunks, not just the last one', async () => {
    const { doc, batchGetCalls } = makeFakeDoc({ withholdItemIds: ['run#run-149', 'run#run-000'] });
    const repo = repoWith(doc);
    await seedMany(repo, 150);
    const { entries } = await repo.listByEntity('global', { limit: 150 });
    expect(entries).toHaveLength(150);
    // run-149 is newest (first chunk); run-000 is oldest (second chunk).
    expect(entries.filter((e) => e.expired && e.unavailable === true).map((e) => e.runId))
      .toEqual(['run-149', 'run-000']);
    expect(entries.filter((e) => e.expired).map((e) => e.runId)).toEqual(['run-149', 'run-000']);
    expect(batchGetCalls()).toBe(8);
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

  // F4: two sort-key conditions in one KeyConditionExpression is a real
  // ValidationException. Both bounds must arrive as a single BETWEEN.
  it('emits exactly ONE sort-key condition - a BETWEEN - when both bounds are present', async () => {
    const { doc, queryInputs } = makeFakeDoc();
    const repo = repoWith(doc);
    await seed(repo, 5);

    await repo.listByEntity('global', {
      from: '2026-08-06T10:01:00.000Z',
      to: '2026-08-06T10:03:00.000Z',
    });
    await repo.listByEntity('global', {
      from: '2026-08-06T10:01:00.000Z',
      before: '2026-08-06T10:04:00.000Z#run-04',
    });

    expect(queryInputs()[0]!.KeyConditionExpression).toBe('#ek = :ek AND #sk BETWEEN :lower AND :upper');
    expect(queryInputs()[1]!.KeyConditionExpression).toBe('#ek = :ek AND #sk BETWEEN :lower AND :upper');
  });

  // F4: the paged path. `before` is the LAST sortKey already returned, so it
  // must stay EXCLUSIVE even though BETWEEN is inclusive on both bounds.
  it('keeps the before cursor exclusive under BETWEEN when a from filter is active', async () => {
    const { doc } = makeFakeDoc();
    const repo = repoWith(doc);
    await seed(repo, 5);
    const { entries } = await repo.listByEntity('global', {
      from: '2026-08-06T10:01:00.000Z',
      before: '2026-08-06T10:03:00.000Z#run-03',
    });
    expect(entries.map((e) => e.runId)).toEqual(['run-02', 'run-01']);
  });

  // F4: the boundary this bug hides behind - a from-filtered list walked page by
  // page must lose no row and repeat no row across the cursor seam.
  it('pages a from-filtered list with no duplicate and no skipped row', async () => {
    const { doc } = makeFakeDoc();
    const repo = repoWith(doc);
    await seed(repo, 10);
    const from = '2026-08-06T10:02:00.000Z';

    const seenIds: string[] = [];
    let before: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const out: { entries: Array<{ runId: string }>; nextBefore?: string } =
        await repo.listByEntity('global', { from, limit: 3, ...(before !== undefined && { before }) });
      seenIds.push(...out.entries.map((e) => e.runId));
      if (out.nextBefore === undefined) break;
      before = out.nextBefore;
    }

    expect(seenIds).toEqual(['run-09', 'run-08', 'run-07', 'run-06', 'run-05', 'run-04', 'run-03', 'run-02']);
    expect(new Set(seenIds).size).toBe(seenIds.length);
  });

  // F4: a caller-supplied `before` beyond the `to` ceiling must NOT over-return.
  // Today `before` silently shadows `to` (the ternary), dropping the ceiling.
  it('applies the TIGHTER of before and the to ceiling when both are supplied', async () => {
    const { doc } = makeFakeDoc();
    const repo = repoWith(doc);
    await seed(repo, 5);
    const { entries } = await repo.listByEntity('global', {
      to: '2026-08-06T10:02:00.000Z',
      before: '2026-08-06T10:04:00.000Z#run-04',
    });
    expect(entries.map((e) => e.runId)).toEqual(['run-02', 'run-01', 'run-00']);
  });

  it('returns an empty page for an unknown scope without erroring', async () => {
    const { doc } = makeFakeDoc();
    const out = await repoWith(doc).listByEntity('contacts#nobody');
    expect(out.entries).toEqual([]);
    expect(out.nextBefore).toBeUndefined();
  });

  // conf P2-1: the two shipped date inputs are independent <input type="date">
  // controls, so From LATER than To is one click away. DynamoDB rejects a
  // BETWEEN whose upper bound is below its lower bound ("the BETWEEN operator
  // requires upper bound to be greater than or equal to lower bound"), which
  // reached the route as a 500. An inverted range truthfully matches nothing,
  // so the repository must answer the empty page WITHOUT querying. The emulator
  // models BETWEEN as an inclusive JS comparison and cannot reproduce the
  // engine's rejection, so the load-bearing assertion here is that no Query is
  // sent at all (the engine's own refusal is pinned in the integration suite).
  it('returns an empty page for an inverted range WITHOUT sending a query', async () => {
    const { doc, queryInputs } = makeFakeDoc();
    const repo = repoWith(doc);
    await seed(repo, 5);
    const queriesAfterSeed = queryInputs().length;

    const inverted = await repo.listByEntity('global', {
      from: '2026-08-06T10:04:00.000Z',
      to: '2026-08-06T10:01:00.000Z',
    });
    const invertedCursor = await repo.listByEntity('global', {
      from: '2026-08-06T10:04:00.000Z',
      before: '2026-08-06T10:01:00.000Z#run-01',
    });

    expect(inverted.entries).toEqual([]);
    expect(inverted.nextBefore).toBeUndefined();
    expect(invertedCursor.entries).toEqual([]);
    expect(invertedCursor.nextBefore).toBeUndefined();
    expect(queryInputs().length).toBe(queriesAfterSeed);
  });

  // The boundary next to it: `from` EQUAL to the upper bound is a legal BETWEEN
  // and must still be queried, so the guard cannot be widened to `>=`.
  it('still queries when from EQUALS the to ceiling', async () => {
    const { doc, queryInputs } = makeFakeDoc();
    const repo = repoWith(doc);
    await seed(repo, 5);
    const queriesAfterSeed = queryInputs().length;

    const { entries } = await repo.listByEntity('global', {
      from: '2026-08-06T10:02:00.000Z',
      to: '2026-08-06T10:02:00.000Z',
    });

    expect(entries.map((e) => e.runId)).toEqual(['run-02']);
    expect(queryInputs().length).toBe(queriesAfterSeed + 1);
  });
});

describe('aiRunsRepo - setVerdict', () => {
  it('carries a marker verdict into the one final envelope transaction', async () => {
    const { doc } = makeFakeDoc();
    const repo = repoWith(doc);
    await repo.beginFinalization('run-1', '2026-08-06T10:00:00.000Z');
    expect(await repo.setVerdict('run-1', 'pets', 'accepted', { at: '2026-08-06T10:01:00.000Z', expectedVerdict: 'pending' })).toBe(true);
    await repo.putRun(draftRecord({ decisions: { pets: { proposedOp: 'suggest', outcome: 'suggested', verdict: 'pending' } } }));
    expect((await repo.getRun('run-1'))?.decisions['pets']?.verdict).toBe('accepted');
  });

  it('uses the final row after marker finalization and never creates intent for a missing run', async () => {
    const { doc, store } = makeFakeDoc();
    const repo = repoWith(doc);
    expect(await repo.setVerdict('gone', 'pets', 'accepted', { expectedVerdict: 'pending' })).toBe(false);
    expect([...store.keys()]).toEqual([]);
    await repo.beginFinalization('run-1', '2026-08-06T10:00:00.000Z');
    await repo.putRun(draftRecord({ decisions: { pets: { proposedOp: 'suggest', outcome: 'suggested', verdict: 'pending' } } }));
    expect(await repo.setVerdict('run-1', 'pets', 'accepted', { expectedVerdict: 'pending' })).toBe(true);
    expect((await repo.getRun('run-1'))?.decisions['pets']?.verdict).toBe('accepted');
  });

  it('creates a fresh fallback marker so a pre-envelope resolution merges after marker creation failed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-08T00:00:00.000Z'));
    try {
      const { doc, store } = makeFakeDoc();
      const repo = repoWith(doc);
      expect(await repo.setVerdict('run-1', 'pets', 'accepted', {
        at: '2026-08-06T10:01:00.000Z', expectedVerdict: 'pending', freshSuggestionCreatedAt: STARTED,
      })).toBe(true);
      expect([...store.keys()]).toEqual(['inflight#run-1']);

      await repo.putRun(draftRecord({ decisions: { pets: { proposedOp: 'suggest', outcome: 'suggested', verdict: 'pending' } } }));
      expect((await repo.getRun('run-1'))?.decisions['pets']?.verdict).toBe('accepted');
      expect(store.has('inflight#run-1')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not create a fallback marker for an expired suggestion', async () => {
    const { doc, store } = makeFakeDoc();
    expect(await repoWith(doc).setVerdict('run-gone', 'pets', 'accepted', {
      expectedVerdict: 'pending', freshSuggestionCreatedAt: '2000-01-01T00:00:00.000Z',
    })).toBe(false);
    expect([...store.keys()]).toEqual([]);
  });

  it('does not create a fallback marker at the integer TTL boundary or its final fractional second', async () => {
    const freshSuggestionCreatedAt = '2026-08-06T10:00:00.500Z';
    const expiresAt = runExpiresAt(freshSuggestionCreatedAt);
    vi.useFakeTimers();
    try {
      for (const nowMs of [expiresAt * 1000, expiresAt * 1000 + 999]) {
        vi.setSystemTime(nowMs);
        const { doc, store } = makeFakeDoc();
        expect(await repoWith(doc).setVerdict('run-gone', 'pets', 'accepted', {
          expectedVerdict: 'pending', freshSuggestionCreatedAt,
        })).toBe(false);
        expect([...store.keys()]).toEqual([]);
      }
    } finally {
      vi.useRealTimers();
    }
  });

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

  // F9: setVerdict's contract is Promise<boolean> and every caller treats it as
  // best-effort. A run row whose decisions map lacks the target makes the
  // document-path SET invalid - a ValidationException, not a condition failure -
  // and that must not escape as a throw. (With expectedVerdict the guard on the
  // same absent path fails first; without one the SET is reached, which is the
  // rethrow point this pins.)
  it('returns false without throwing when the run has no decision for the target', async () => {
    const { doc } = makeFakeDoc();
    const capture = createLogCapture();
    const repo = repoWith(doc, capture);
    await repo.putRun(draftRecord({
      decisions: { tenure: { proposedOp: 'suggest', outcome: 'suggested', verdict: 'pending' } },
    }));

    await expect(repo.setVerdict('run-1', 'pets', 'accepted', {
      at: '2026-08-06T11:00:00.000Z',
    })).resolves.toBe(false);
    expect((await repo.getRun('run-1'))?.decisions['tenure']?.verdict).toBe('pending');
    expect((await repo.getRun('run-1'))?.decisions['pets']).toBeUndefined();

    // adv P2-6: ValidationException is DynamoDB's catch-all for EVERY malformed
    // expression, so swallowing it as a silent `false` would let a future
    // expression bug stop all verdict stamping with no signal anywhere. The
    // return value stays best-effort; the warn is the signal. Ids only - a
    // verdict line never carries a suggested value.
    const rejected = capture.atLevel(40).filter(
      (line) => line['msg'] === 'ai run verdict stamp rejected (ValidationException)',
    );
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected[0]).toMatchObject({ runId: 'run-1', target: 'pets' });
    expect((rejected[0]!['err'] as { message?: string } | undefined)?.message)
      .toMatch(/document path/i);
    const payloadKeys = Object.keys(rejected[0]!)
      .filter((k) => !['level', 'time', 'pid', 'hostname', 'msg'].includes(k))
      .sort();
    expect(payloadKeys).toEqual(['err', 'runId', 'target']);
  });

  it('does not overwrite a terminal verdict when another resolver won first', async () => {
    const { doc } = makeFakeDoc();
    const repo = repoWith(doc);
    await repo.putRun(draftRecord({ decisions: { pets: { proposedOp: 'suggest', outcome: 'suggested', verdict: 'pending' } } }));
    expect(await repo.setVerdict('run-1', 'pets', 'accepted', { expectedVerdict: 'pending' })).toBe(true);
    expect(await repo.setVerdict('run-1', 'pets', 'dismissed', { expectedVerdict: 'pending' })).toBe(false);
    expect((await repo.getRun('run-1'))?.decisions['pets']?.verdict).toBe('accepted');
  });
});
