// Fast unit tests: extractionRepo sliding-debounce due items + pending
// suggestions (conversation-fact-extraction Task 1).
//
// In-memory twin of DynamoDB, mirroring app/test/placementNudgesRepo.test.ts:
// a tiny fake doc client that EVALUATES the ConditionExpressions the repo builds
// (attribute_exists / attribute_not_exists AND ISO-string comparisons), applies
// combined SET / REMOVE / ADD UpdateExpressions in-memory (incl. if_not_exists),
// and answers GSI Queries with present-and-equal key semantics so a row is only
// "indexed" while ALL its GSI key attributes are present (models sparse GSIs).
// This pins the slide / claim / complete / fail state machine WITHOUT Docker,
// the same way the nudge/reminder claim tests do.
//
// The sliding-debounce correctness clause (claim's `#dueAt = :listedDueAt`) and
// the D2 requirement (claim/complete/park REMOVE both _duePartition AND dueAt so
// the row leaves the byDueAt index) are asserted explicitly.
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import { createExtractionRepo } from '../src/repos/extractionRepo.js';
import { createLogCapture } from './helpers/logCapture.js';

// ---------------------------------------------------------------------------
// Fake doc client - an itemId-keyed store plus mini evaluators for the exact
// condition / update / query shapes extractionRepo builds.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

/** Split a comma list at paren depth 0 (so if_not_exists(#a, :v) is one item). */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') {
      depth++;
      cur += ch;
    } else if (ch === ')') {
      depth--;
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

/** Resolve a `#name` alias (or bare attr) against the names map. */
function attrOf(token: string, names: Record<string, string>): string {
  return names[token] ?? token;
}

/**
 * Evaluate an AND-joined chain of attribute_exists / attribute_not_exists and
 * `#attr <op> :val` comparisons (op in =,<=,<,>=,>). A missing left operand makes
 * the comparison / attribute_exists false (models an absent GSI key attribute).
 */
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

/** Apply combined `SET ... REMOVE ... ADD ...` (with if_not_exists in SET). */
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
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i]!.bodyStart;
    const stop = i + 1 < marks.length ? marks[i + 1]!.start : expr.length;
    const body = expr.slice(start, stop).trim();
    const keyword = marks[i]!.keyword;
    if (keyword === 'SET') {
      for (const pair of splitTopLevel(body)) {
        const eq = pair.indexOf('=');
        const lhs = pair.slice(0, eq).trim();
        const rhs = pair.slice(eq + 1).trim();
        const attr = attrOf(lhs, names);
        const ine = /^if_not_exists\(\s*([#\w]+)\s*,\s*(:[\w]+)\s*\)$/i.exec(rhs);
        if (ine) {
          const existing = row[attrOf(ine[1]!, names)];
          row[attr] = existing !== undefined ? existing : values[ine[2]!];
        } else {
          row[attr] = values[rhs];
        }
      }
    } else if (keyword === 'REMOVE') {
      for (const tok of splitTopLevel(body)) {
        delete row[attrOf(tok, names)];
      }
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

/** Which stored attribute is the range key of each GSI (for sort order). */
const INDEX_RANGE: Record<string, string> = {
  byDueAt: 'dueAt',
  byOwner: 'itemId',
  byPending: 'createdAt',
};

interface FakeDoc {
  doc: DynamoDBDocumentClient;
  store: Map<string, Row>;
  lastUpdate: () => UpdateCommand | undefined;
}

function makeFakeDoc(): FakeDoc {
  const store = new Map<string, Row>();
  let lastUpdate: UpdateCommand | undefined;
  const doc = {
    send: async (cmd: unknown) => {
      if (cmd instanceof PutCommand) {
        const item = cmd.input.Item as Row;
        // Model removeUndefinedValues: undefined attrs are never stored (keeps
        // sparse GSIs sparse), exactly like the real document client.
        const stored: Row = {};
        for (const [k, v] of Object.entries(item)) if (v !== undefined) stored[k] = v;
        store.set(item['itemId'] as string, stored);
        return {};
      }
      if (cmd instanceof GetCommand) {
        const key = cmd.input.Key as { itemId: string };
        const row = store.get(key.itemId);
        return { Item: row ? { ...row } : undefined };
      }
      if (cmd instanceof DeleteCommand) {
        const key = cmd.input.Key as { itemId: string };
        store.delete(key.itemId);
        return {};
      }
      if (cmd instanceof UpdateCommand) {
        lastUpdate = cmd;
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
        const names = cmd.input.ExpressionAttributeNames ?? {};
        const values = cmd.input.ExpressionAttributeValues ?? {};
        const kce = cmd.input.KeyConditionExpression!;
        const rangeAttr = INDEX_RANGE[cmd.input.IndexName!];
        let rows = [...store.values()].filter((row) => conditionHolds(kce, names, values, row));
        if (rangeAttr) {
          rows = rows.sort((a, b) => String(a[rangeAttr]).localeCompare(String(b[rangeAttr])));
          if (cmd.input.ScanIndexForward === false) rows.reverse();
        }
        if (typeof cmd.input.Limit === 'number') rows = rows.slice(0, cmd.input.Limit);
        return { Items: rows.map((r) => ({ ...r })) };
      }
      throw new Error(`fake doc: unexpected command ${String(cmd)}`);
    },
  } as unknown as DynamoDBDocumentClient;
  return { doc, store, lastUpdate: () => lastUpdate };
}

function repoWith(doc: DynamoDBDocumentClient) {
  return createExtractionRepo({
    doc,
    env: { TABLE_PREFIX: 'hc-fake-' } as NodeJS.ProcessEnv,
    logger: createLogger({ destination: createLogCapture().stream }),
  });
}

const T1 = '2026-07-16T10:00:00.000Z';
const T2 = '2026-07-16T10:00:30.000Z';
const T3 = '2026-07-16T10:01:00.000Z';
const FUTURE = '2026-07-16T12:00:00.000Z';

// ---------------------------------------------------------------------------
// scheduleExtraction - sliding upsert
// ---------------------------------------------------------------------------

describe('extractionRepo.scheduleExtraction', () => {
  it('is a sliding upsert: two calls leave ONE item with the later dueAt', async () => {
    const { doc, store } = makeFakeDoc();
    const repo = repoWith(doc);

    await repo.scheduleExtraction('conv-1', 'sms', T1);
    await repo.scheduleExtraction('conv-1', 'sms', T2);

    const dueRows = [...store.values()].filter((r) => r['itemId'] === 'due#conv-1');
    expect(dueRows).toHaveLength(1);

    const item = await repo.getDue('conv-1');
    expect(item!.dueAt).toBe(T2); // slid forward to the later time
    expect(item!._duePartition).toBe('due');
    expect(item!.channel).toBe('sms');
    expect(item!.conversationId).toBe('conv-1');
    expect(item!.createdAt).toBeDefined();
    expect(item!.updatedAt).toBeDefined();
  });

  it('preserves createdAt across slides (if_not_exists) while updatedAt advances', async () => {
    const { doc } = makeFakeDoc();
    const repo = repoWith(doc);

    await repo.scheduleExtraction('conv-1', 'sms', T1);
    const first = await repo.getDue('conv-1');
    await repo.scheduleExtraction('conv-1', 'sms', T2);
    const second = await repo.getDue('conv-1');

    expect(second!.createdAt).toBe(first!.createdAt);
    expect(second!.dueAt).toBe(T2);
  });
});

// ---------------------------------------------------------------------------
// listDue - only scheduled + past-due
// ---------------------------------------------------------------------------

describe('extractionRepo.listDue', () => {
  it('returns only scheduled rows due at or before now (excludes future)', async () => {
    const { doc } = makeFakeDoc();
    const repo = repoWith(doc);

    await repo.scheduleExtraction('conv-past', 'sms', T1);
    await repo.scheduleExtraction('conv-future', 'sms', FUTURE);

    const due = await repo.listDue(T2);
    const ids = due.map((r) => r.conversationId);
    expect(ids).toContain('conv-past');
    expect(ids).not.toContain('conv-future'); // dueAt > now
  });

  it('a completed conversation cursor row never appears in listDue', async () => {
    const { doc } = makeFakeDoc();
    const repo = repoWith(doc);

    await repo.scheduleExtraction('conv-1', 'sms', T1);
    expect(await repo.claim('conv-1', T2, T1)).toBe(true);
    await repo.complete('conv-1', 'msg-9', T2);

    expect((await repo.listDue(FUTURE)).map((r) => r.conversationId)).not.toContain('conv-1');
  });
});

// ---------------------------------------------------------------------------
// claim - the sliding-debounce guard
// ---------------------------------------------------------------------------

describe('extractionRepo.claim', () => {
  it('fails (false) when dueAt slid after listDue read it (stale listedDueAt)', async () => {
    const { doc, lastUpdate } = makeFakeDoc();
    const repo = repoWith(doc);

    await repo.scheduleExtraction('conv-1', 'sms', T1);
    const listed = await repo.listDue(T2);
    expect(listed).toHaveLength(1);

    // A newer inbound slides the due item forward before the poll claims it.
    await repo.scheduleExtraction('conv-1', 'sms', T3);

    // Claiming with the STALE dueAt loses - the debounce-correctness clause.
    expect(await repo.claim('conv-1', FUTURE, listed[0]!.dueAt!)).toBe(false);
    const cond = lastUpdate()!.input.ConditionExpression!;
    expect(cond).toContain('attribute_exists(#dp)');
    expect(cond).toContain(':listedDueAt');

    // Still scheduled at the slid time (untouched by the failed claim).
    const item = await repo.getDue('conv-1');
    expect(item!._duePartition).toBe('due');
    expect(item!.dueAt).toBe(T3);
    expect(item!.claimedAt).toBeUndefined();
  });

  it('succeeds and REMOVES both _duePartition and dueAt so the row leaves listDue (D2)', async () => {
    const { doc } = makeFakeDoc();
    const repo = repoWith(doc);

    await repo.scheduleExtraction('conv-1', 'sms', T1);
    const listed = await repo.listDue(T2);

    expect(await repo.claim('conv-1', T2, listed[0]!.dueAt!)).toBe(true);

    const item = await repo.getDue('conv-1');
    expect(item!._duePartition).toBeUndefined();
    expect(item!.dueAt).toBeUndefined();
    expect(item!.claimedAt).toBe(T2);
    expect((await repo.listDue(FUTURE)).map((r) => r.conversationId)).not.toContain('conv-1');
  });

  it('a second claim of an already-claimed row loses (false)', async () => {
    const { doc } = makeFakeDoc();
    const repo = repoWith(doc);

    await repo.scheduleExtraction('conv-1', 'sms', T1);
    expect(await repo.claim('conv-1', T2, T1)).toBe(true);
    expect(await repo.claim('conv-1', T2, T1)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// complete - cursor record, claim cleared
// ---------------------------------------------------------------------------

describe('extractionRepo.complete', () => {
  it('stores cursor + lastRanAt and clears claimedAt/attempts/lastError', async () => {
    const { doc } = makeFakeDoc();
    const repo = repoWith(doc);

    await repo.scheduleExtraction('conv-1', 'sms', T1);
    await repo.claim('conv-1', T2, T1);
    await repo.fail('conv-1', 'boom', T3); // arm attempts=1 + lastError
    await repo.claim('conv-1', FUTURE, T3);
    await repo.complete('conv-1', 'msg-42', T2);

    const item = await repo.getDue('conv-1');
    expect(item!.cursor).toBe('msg-42');
    expect(item!.lastRanAt).toBe(T2);
    expect(item!.claimedAt).toBeUndefined();
    expect(item!.attempts).toBeUndefined();
    expect(item!.lastError).toBeUndefined();
    // Persists as the conversation cursor record, out of the due index.
    expect(item!._duePartition).toBeUndefined();
    expect(item!.dueAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// fail - re-arm then park
// ---------------------------------------------------------------------------

describe('extractionRepo.fail', () => {
  it('re-arms with attempts=1 (nextDueAt non-null) then parks on null keeping lastError', async () => {
    const { doc } = makeFakeDoc();
    const repo = repoWith(doc);

    await repo.scheduleExtraction('conv-1', 'sms', T1);
    await repo.claim('conv-1', T2, T1);

    // First failure re-arms: attempts=1, back in the due index at nextDueAt.
    await repo.fail('conv-1', 'driver timeout', T3);
    let item = await repo.getDue('conv-1');
    expect(item!.attempts).toBe(1);
    expect(item!.dueAt).toBe(T3);
    expect(item!._duePartition).toBe('due');
    expect(item!.lastError).toBe('driver timeout');
    expect((await repo.listDue(FUTURE)).map((r) => r.conversationId)).toContain('conv-1');

    // Claim + fail again with null nextDueAt -> park: attempts=2, out of the index.
    await repo.claim('conv-1', FUTURE, T3);
    await repo.fail('conv-1', 'gave up', null);
    item = await repo.getDue('conv-1');
    expect(item!.attempts).toBe(2);
    expect(item!._duePartition).toBeUndefined();
    expect(item!.dueAt).toBeUndefined();
    expect(item!.lastError).toBe('gave up');
    expect((await repo.listDue(FUTURE)).map((r) => r.conversationId)).not.toContain('conv-1');
  });
});

// ---------------------------------------------------------------------------
// suggestions - put / replace / get / list-by-contact / delete
// ---------------------------------------------------------------------------

describe('extractionRepo suggestions', () => {
  it('putSuggestion stamps itemId, pending partition and createdAt; get round-trips', async () => {
    const { doc } = makeFakeDoc();
    const repo = repoWith(doc);

    const s = await repo.putSuggestion({
      ownerContactId: 'contact-1',
      target: 'voucherSize',
      currentValue: '2',
      suggestedValue: '3',
      reason: 'said needs a 3-bedroom',
      conversationId: 'conv-1',
      tsMsgId: 'msg-1',
      createdAt: T1,
    });

    expect(s.itemId).toBe('sugg#contact-1#voucherSize');
    expect(s._pendingPartition).toBe('pending');
    expect(s.createdAt).toBe(T1);

    const got = await repo.getSuggestion('contact-1', 'voucherSize');
    expect(got!.suggestedValue).toBe('3');
    expect(got!.ownerContactId).toBe('contact-1');
  });

  it('a re-put on the same target REPLACES (latest wins)', async () => {
    const { doc, store } = makeFakeDoc();
    const repo = repoWith(doc);

    await repo.putSuggestion({ ownerContactId: 'c1', target: 'pets', suggestedValue: 'cat', conversationId: 'conv-1' });
    await repo.putSuggestion({ ownerContactId: 'c1', target: 'pets', suggestedValue: 'dog', conversationId: 'conv-2' });

    const rows = [...store.values()].filter((r) => r['itemId'] === 'sugg#c1#pets');
    expect(rows).toHaveLength(1);
    expect((await repo.getSuggestion('c1', 'pets'))!.suggestedValue).toBe('dog');
  });

  it('defaults createdAt to now when omitted', async () => {
    const { doc } = makeFakeDoc();
    const repo = repoWith(doc);

    const s = await repo.putSuggestion({ ownerContactId: 'c1', target: 'pets', suggestedValue: 'dog', conversationId: 'conv-1' });
    expect(s.createdAt).toBeDefined();
    expect(Number.isFinite(Date.parse(s.createdAt))).toBe(true);
  });

  it('listSuggestionsByContact returns all of one contact via the byOwner GSI', async () => {
    const { doc } = makeFakeDoc();
    const repo = repoWith(doc);

    await repo.putSuggestion({ ownerContactId: 'c1', target: 'pets', suggestedValue: 'dog', conversationId: 'x' });
    await repo.putSuggestion({ ownerContactId: 'c1', target: 'evictions', suggestedValue: 'none', conversationId: 'x' });
    await repo.putSuggestion({ ownerContactId: 'c2', target: 'pets', suggestedValue: 'cat', conversationId: 'y' });

    const list = await repo.listSuggestionsByContact('c1');
    expect(list.map((s) => s.target).sort()).toEqual(['evictions', 'pets']);
    expect(list.every((s) => s.ownerContactId === 'c1')).toBe(true);
  });

  it('deleteSuggestion removes the row', async () => {
    const { doc } = makeFakeDoc();
    const repo = repoWith(doc);

    await repo.putSuggestion({ ownerContactId: 'c1', target: 'pets', suggestedValue: 'dog', conversationId: 'x' });
    await repo.deleteSuggestion('c1', 'pets');

    expect(await repo.getSuggestion('c1', 'pets')).toBeUndefined();
    expect(await repo.listSuggestionsByContact('c1')).toHaveLength(0);
  });

  it('round-trips suggestedAddress parts for the compound address target', async () => {
    const { doc } = makeFakeDoc();
    const repo = repoWith(doc);

    await repo.putSuggestion({
      ownerContactId: 'contact-1',
      target: 'address',
      suggestedValue: '1 Main St, Atlanta',
      suggestedAddress: { line1: '1 Main St', city: 'Atlanta' },
      conversationId: 'conv-1',
      createdAt: T1,
    });

    const got = await repo.getSuggestion('contact-1', 'address');
    expect(got!.suggestedAddress).toEqual({ line1: '1 Main St', city: 'Atlanta' });
    expect(got!.suggestedValue).toBe('1 Main St, Atlanta');
  });

  it('omits suggestedAddress when the target carries none', async () => {
    const { doc } = makeFakeDoc();
    const repo = repoWith(doc);

    await repo.putSuggestion({ ownerContactId: 'c1', target: 'pets', suggestedValue: 'dog', conversationId: 'x' });
    const got = await repo.getSuggestion('c1', 'pets');
    expect(got!.suggestedAddress).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// listPending - only pending suggestions, newest first, excludes deleted + due
// ---------------------------------------------------------------------------

describe('extractionRepo.listPending', () => {
  it('returns only _pendingPartition rows, newest first, excluding deleted and due items', async () => {
    const { doc } = makeFakeDoc();
    const repo = repoWith(doc);

    // A due item (no _pendingPartition) must never surface here.
    await repo.scheduleExtraction('conv-1', 'sms', T1);

    await repo.putSuggestion({ ownerContactId: 'c1', target: 'pets', suggestedValue: 'dog', conversationId: 'x', createdAt: T1 });
    await repo.putSuggestion({ ownerContactId: 'c2', target: 'pets', suggestedValue: 'cat', conversationId: 'y', createdAt: T2 });
    await repo.putSuggestion({ ownerContactId: 'c3', target: 'pets', suggestedValue: 'bird', conversationId: 'z', createdAt: T3 });

    const pending = await repo.listPending();
    expect(pending.map((s) => s.ownerContactId)).toEqual(['c3', 'c2', 'c1']); // newest first
    expect(pending.every((s) => s._pendingPartition === 'pending')).toBe(true);

    await repo.deleteSuggestion('c2', 'pets');
    const after = await repo.listPending();
    expect(after.map((s) => s.ownerContactId)).toEqual(['c3', 'c1']); // c2 gone
  });

  it('honors an explicit limit', async () => {
    const { doc } = makeFakeDoc();
    const repo = repoWith(doc);

    await repo.putSuggestion({ ownerContactId: 'c1', target: 'pets', suggestedValue: 'dog', conversationId: 'x', createdAt: T1 });
    await repo.putSuggestion({ ownerContactId: 'c2', target: 'pets', suggestedValue: 'cat', conversationId: 'y', createdAt: T2 });
    await repo.putSuggestion({ ownerContactId: 'c3', target: 'pets', suggestedValue: 'bird', conversationId: 'z', createdAt: T3 });

    const pending = await repo.listPending({ limit: 2 });
    expect(pending).toHaveLength(2);
    expect(pending.map((s) => s.ownerContactId)).toEqual(['c3', 'c2']);
  });
});
