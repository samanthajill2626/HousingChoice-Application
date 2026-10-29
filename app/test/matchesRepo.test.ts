// matchesRepo (WP1 B2a spec D8, D8.1; plan PR5, WI1): the pure helpers and the
// batch walks against a stub DocumentClient - chunking, the unprocessed
// retries, the complete-only read, the legacy-row rule. The DynamoDB Local
// round trip is matchesRepo.integration.test.ts.
import {
  BatchGetCommand,
  BatchWriteCommand,
  type BatchGetCommandInput,
  type BatchWriteCommandInput,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import { IncompleteBatchReadError } from '../src/repos/contactsRepo.js';
import {
  MATCH_SCHEMA,
  createMatchesRepo,
  decodeSnapshot,
  encodeSnapshot,
  gunzipBase64,
  gzipBase64,
  isCurrentMatchRow,
  matchPairKey,
  rankingExpiresAt,
  type MatchRow,
} from '../src/repos/matchesRepo.js';
import { createLogCapture } from './helpers/logCapture.js';

const TABLE = 'hc-test-x-matches';
const COMPUTED_AT = '2026-10-28T12:00:00.000Z';

function row(tenantId: string, unitId: string, over: Partial<MatchRow> = {}): MatchRow {
  return {
    tenantId,
    unitId,
    schema: 2,
    score: 72,
    for: [{ text: 'Voucher size fits', source: 'voucher_size' }],
    against: [{ text: 'Over the portion', source: 'rent' }],
    missing: [{ key: 'payment_standard', text: 'Payment standard' }, { text: 'Move-in date' }],
    failedRequirements: [],
    fairHousingFlags: [],
    stage: 1,
    rubricVersion: 'r1',
    examplesVersion: 'e1',
    promptFingerprint: 'a'.repeat(64),
    model: 'fake',
    runId: 'run-1',
    jobGeneration: 'gen-1',
    computedAt: COMPUTED_AT,
    anchorSide: 'unit',
    fingerprints: { tenantCard: 't'.repeat(64), unitCard: 'u'.repeat(64), pairHistory: 'p'.repeat(64) },
    inputSnapshot: encodeSnapshot({ anchor: { card: { beds: 2 } } }),
    expires_at: rankingExpiresAt(COMPUTED_AT, 180),
    ...over,
  };
}

function makeRepo(doc: DynamoDBDocumentClient) {
  const capture = createLogCapture();
  const logger = createLogger({ destination: capture.stream });
  return { matches: createMatchesRepo({ doc, env: { TABLE_PREFIX: 'hc-test-x-' }, logger }), capture };
}

/** Script: how many of a request's items to leave unprocessed (the LAST n), or a throw. */
function stubWriteDoc(script: (count: number, call: number) => number | 'throw' = () => 0) {
  const requests: BatchWriteCommandInput[] = [];
  const doc = {
    async send(command: unknown) {
      if (!(command instanceof BatchWriteCommand)) throw new Error('stub: expected a BatchWriteCommand');
      requests.push(command.input);
      const items = command.input.RequestItems?.[TABLE] ?? [];
      const reply = script(items.length, requests.length);
      if (reply === 'throw') throw new Error('stub: the request failed');
      return reply > 0 ? { UnprocessedItems: { [TABLE]: items.slice(-reply) } } : {};
    },
  };
  return { doc: doc as unknown as DynamoDBDocumentClient, requests };
}

type PairKey = { tenantId: string; unitId: string };

/** Serves `stored` rows for the asked keys, withholding the LAST n keys, or throws. */
function stubGetDoc(
  stored: ReadonlyArray<PairKey>,
  script: (keys: PairKey[], call: number) => number | 'throw' = () => 0,
) {
  const requests: BatchGetCommandInput[] = [];
  const doc = {
    async send(command: unknown) {
      if (!(command instanceof BatchGetCommand)) throw new Error('stub: expected a BatchGetCommand');
      requests.push(command.input);
      const keys = (command.input.RequestItems?.[TABLE]?.Keys ?? []) as PairKey[];
      const reply = script(keys, requests.length);
      if (reply === 'throw') throw new Error('stub: the request failed');
      const served = keys.slice(0, keys.length - reply);
      const withheld = keys.slice(keys.length - reply);
      return {
        Responses: {
          [TABLE]: stored.filter((item) =>
            served.some((k) => k.tenantId === item.tenantId && k.unitId === item.unitId),
          ),
        },
        ...(withheld.length > 0 && { UnprocessedKeys: { [TABLE]: { Keys: withheld } } }),
      };
    },
  };
  return { doc: doc as unknown as DynamoDBDocumentClient, requests };
}

describe('matchesRepo pure helpers', () => {
  it('the schema is 2 and the pair key is tenantId#unitId', () => {
    expect(MATCH_SCHEMA).toBe(2);
    expect(matchPairKey('contact-1', 'unit-1')).toBe('contact-1#unit-1');
  });

  it('rankingExpiresAt is the start plus the TTL in epoch seconds; a bad time throws', () => {
    expect(rankingExpiresAt(COMPUTED_AT, 180)).toBe(Math.floor(Date.parse(COMPUTED_AT) / 1000) + 180 * 86400);
    expect(() => rankingExpiresAt('not a time', 180)).toThrow(/not an ISO time/);
  });

  it('the snapshot codec round-trips JSON through gzip and base64', () => {
    const value = { anchor: { card: { beds: 2, notes: 'Line one / line two' } }, candidates: [{ handle: 'c1' }] };
    const encoded = encodeSnapshot(value);
    expect(encoded).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(decodeSnapshot(encoded)).toEqual(value);
    expect(gunzipBase64(gzipBase64('the batch user message'))).toBe('the batch user message');
    expect(() => encodeSnapshot(undefined)).toThrow(/not JSON/);
  });

  it('a row is current only with schema 2 (the legacy seed shape is not)', () => {
    expect(isCurrentMatchRow(row('t', 'u'))).toBe(true);
    expect(isCurrentMatchRow({ tenantId: 't', unitId: 'u', fit_score: 0.91, expires_at: 1 })).toBe(false);
    expect(isCurrentMatchRow({ tenantId: 't', unitId: 'u', schema: 1 })).toBe(false);
    expect(isCurrentMatchRow(null)).toBe(false);
  });
});

describe('matchesRepo.putMatches (stub client)', () => {
  it('writes 60 rows in BatchWrites of 25, 25 and 10, each a PutRequest of the row', async () => {
    const { doc, requests } = stubWriteDoc();
    const { matches } = makeRepo(doc);
    const rows = Array.from({ length: 60 }, (_, i) => row(`contact-${i}`, 'unit-1'));

    expect(await matches.putMatches(rows)).toEqual({ written: 60, unwritten: [] });

    expect(requests.map((r) => r.RequestItems?.[TABLE]?.length)).toEqual([25, 25, 10]);
    expect(requests[0]!.RequestItems![TABLE]![0]).toEqual({ PutRequest: { Item: rows[0] } });
  });

  it('a pair given twice is written once, the LAST copy (BatchWrite rejects duplicate keys)', async () => {
    const { doc, requests } = stubWriteDoc();
    const { matches } = makeRepo(doc);

    const result = await matches.putMatches([
      row('contact-1', 'unit-1', { score: 10 }),
      row('contact-1', 'unit-1', { score: 90 }),
    ]);

    expect(result).toEqual({ written: 1, unwritten: [] });
    const items = requests[0]!.RequestItems![TABLE]!;
    expect(items).toHaveLength(1);
    expect((items[0]!.PutRequest!.Item as MatchRow).score).toBe(90);
  });

  it('retries the unprocessed items with the same items until written', async () => {
    const { doc, requests } = stubWriteDoc((_count, call) => (call === 1 ? 2 : 0));
    const { matches, capture } = makeRepo(doc);
    const rows = [row('c-1', 'u'), row('c-2', 'u'), row('c-3', 'u')];

    expect(await matches.putMatches(rows)).toEqual({ written: 3, unwritten: [] });

    expect(requests.map((r) => r.RequestItems?.[TABLE]?.length)).toEqual([3, 2]);
    expect(requests[1]!.RequestItems![TABLE]!.map((w) => (w.PutRequest!.Item as MatchRow).tenantId)).toEqual([
      'c-2',
      'c-3',
    ]);
    expect(capture.atLevel(40)).toEqual([]);
  });

  it('items still unprocessed after 5 attempts are REPORTED, never thrown; one WARN with counts only (PR37)', async () => {
    const { doc, requests } = stubWriteDoc(() => 1);
    const { matches, capture } = makeRepo(doc);

    const result = await matches.putMatches([row('c-1', 'u'), row('c-2', 'u'), row('c-3', 'u')]);

    expect(result).toEqual({ written: 2, unwritten: [{ tenantId: 'c-3', unitId: 'u' }] });
    expect(requests).toHaveLength(5);
    const warns = capture.atLevel(40);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({ unwritten: 1, requested: 3 });
    for (const id of ['c-1', 'c-2', 'c-3']) expect(JSON.stringify(warns[0])).not.toContain(id);
  });

  it('a chunk whose request THROWS is reported "not confirmed written" whole; the other chunks still land (PR37)', async () => {
    // Three chunks (25, 25, 10); the second request fails outright. The stub
    // cannot say whether DynamoDB applied it, so every row of it is reported.
    const { doc, requests } = stubWriteDoc((_count, call) => (call === 2 ? 'throw' : 0));
    const { matches, capture } = makeRepo(doc);
    const rows = Array.from({ length: 60 }, (_, i) => row(`contact-${i}`, 'unit-1'));

    const result = await matches.putMatches(rows);

    expect(requests.map((r) => r.RequestItems?.[TABLE]?.length)).toEqual([25, 25, 10]);
    expect(result.written).toBe(35);
    expect(result.unwritten).toEqual(rows.slice(25, 50).map((r) => ({ tenantId: r.tenantId, unitId: r.unitId })));
    const warn = capture.atLevel(40).find((l) => l['msg'] === 'matches: BatchWrite chunk failed');
    expect(warn).toMatchObject({ chunkRows: 25 });
    expect(JSON.stringify(warn)).not.toMatch(/contact-\d/);
  });

  it('refuses a row that is not schema 2 before any call (a programming error, so it throws); no rows makes no call', async () => {
    const { doc, requests } = stubWriteDoc();
    const { matches } = makeRepo(doc);

    await expect(
      matches.putMatches([{ ...row('c-1', 'u'), schema: 1 } as unknown as MatchRow]),
    ).rejects.toThrow(/schema 2 rows only/);
    expect(await matches.putMatches([])).toEqual({ written: 0, unwritten: [] });
    expect(requests).toEqual([]);
  });
});

describe('matchesRepo.getPairs (stub client)', () => {
  it('reads by key, consistent, 100 keys per request, repeats removed, keyed tenantId#unitId', async () => {
    const stored = Array.from({ length: 150 }, (_, i) => row(`contact-${i}`, 'unit-1'));
    const { doc, requests } = stubGetDoc(stored);
    const { matches } = makeRepo(doc);
    const keys = stored.map((r) => ({ tenantId: r.tenantId, unitId: r.unitId }));

    const found = await matches.getPairs([...keys, ...keys.slice(0, 5)], { requireComplete: true });

    expect(requests.map((r) => r.RequestItems?.[TABLE]?.Keys?.length)).toEqual([100, 50]);
    for (const request of requests) {
      expect(request.RequestItems![TABLE]!.ConsistentRead).toBe(true);
      for (const key of request.RequestItems![TABLE]!.Keys!) expect(Object.keys(key).sort()).toEqual(['tenantId', 'unitId']);
    }
    expect(found.size).toBe(150);
    expect(found.get('contact-7#unit-1')).toEqual(stored[7]);
  });

  it('a legacy row (no schema 2) and a pair with no row are both absent', async () => {
    const legacy = { tenantId: 'contact-old', unitId: 'unit-1', fit_score: 0.91, rank: 1, expires_at: 1787270400 };
    const { doc } = stubGetDoc([legacy, row('contact-new', 'unit-1')]);
    const { matches } = makeRepo(doc);

    const found = await matches.getPairs(
      [
        { tenantId: 'contact-old', unitId: 'unit-1' },
        { tenantId: 'contact-new', unitId: 'unit-1' },
        { tenantId: 'contact-none', unitId: 'unit-1' },
      ],
      { requireComplete: true },
    );

    expect([...found.keys()]).toEqual(['contact-new#unit-1']);
  });

  it('retries unprocessed keys; keys still unread after 4 attempts THROW IncompleteBatchReadError (matches)', async () => {
    const stored = [row('c-1', 'u'), row('c-2', 'u'), row('c-3', 'u')];
    const keys = stored.map((r) => ({ tenantId: r.tenantId, unitId: r.unitId }));

    const healed = stubGetDoc(stored, (_k, call) => (call === 1 ? 2 : 0));
    expect((await makeRepo(healed.doc).matches.getPairs(keys, { requireComplete: true })).size).toBe(3);
    expect(healed.requests).toHaveLength(2);

    const stuck = stubGetDoc(stored, () => 1);
    const err = await makeRepo(stuck.doc).matches.getPairs(keys, { requireComplete: true }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(IncompleteBatchReadError);
    expect((err as Error).message).toMatch(/^matches batch read incomplete: 1 of 3 keys unread/);
    expect(stuck.requests).toHaveLength(4);
  });

  it('a chunk whose request throws rethrows; no keys makes no call', async () => {
    const failing = stubGetDoc([], () => 'throw');
    await expect(
      makeRepo(failing.doc).matches.getPairs([{ tenantId: 'c', unitId: 'u' }], { requireComplete: true }),
    ).rejects.toThrow('stub: the request failed');

    const idle = stubGetDoc([]);
    expect((await makeRepo(idle.doc).matches.getPairs([], { requireComplete: true })).size).toBe(0);
    expect(idle.requests).toEqual([]);
  });
});
