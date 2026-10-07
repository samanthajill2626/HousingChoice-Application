// unitsRepo.getDisplaysByIds - the property labels for a page of tours (tour
// list S3, spec 5.6): one BatchGetItem per 100 DISTINCT unit ids, projected to
// unitId + address, BEST-EFFORT like contactsRepo.getDisplaysByIds. A short map
// is a missing LABEL, never an error.
//
// Pure: a stub DocumentClient records every BatchGetCommand input and answers
// from a per-test script, so the chunking, the projection, the UnprocessedKeys
// retries and the drop-with-a-WARN policy are all visible without DynamoDB.
// The round trip against DynamoDB Local (a soft-deleted unit included) is in
// unitsRepo.integration.test.ts.
import { BatchGetCommand, type BatchGetCommandInput, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import { createUnitsRepo } from '../src/repos/unitsRepo.js';
import { createLogCapture } from './helpers/logCapture.js';

/** tableName('units', env) is TABLE_PREFIX + 'units'. */
const TABLE = 'hc-test-x-units';

type Key = { unitId: string };
/** How the stub answers one request: the keys it serves (and withholds), or a throw. */
type Reply = { served: Key[]; unprocessed?: Key[] } | 'throw';

const addressOf = (unitId: string) => ({ line1: `${unitId} Main St`, city: 'Atlanta', state: 'GA' });

/** Default script: a healthy table that serves every key it is asked for. */
function stubDoc(script: (keys: Key[], call: number) => Reply = (keys) => ({ served: keys })) {
  const requests: BatchGetCommandInput[] = [];
  const doc = {
    async send(command: unknown) {
      if (!(command instanceof BatchGetCommand)) throw new Error('stub: expected a BatchGetCommand');
      requests.push(command.input);
      const keys = (command.input.RequestItems?.[TABLE]?.Keys ?? []) as Key[];
      const reply = script(keys, requests.length);
      if (reply === 'throw') throw new Error('stub: the request failed');
      return {
        Responses: { [TABLE]: reply.served.map(({ unitId }) => ({ unitId, address: addressOf(unitId) })) },
        ...(reply.unprocessed !== undefined &&
          reply.unprocessed.length > 0 && { UnprocessedKeys: { [TABLE]: { Keys: reply.unprocessed } } }),
      };
    },
  };
  return { doc: doc as unknown as DynamoDBDocumentClient, requests };
}

function makeRepo(doc: DynamoDBDocumentClient) {
  const capture = createLogCapture();
  const logger = createLogger({ destination: capture.stream });
  const units = createUnitsRepo({ doc, env: { TABLE_PREFIX: 'hc-test-x-' }, logger });
  return { units, capture };
}

const keysOf = (request: BatchGetCommandInput): string[] =>
  ((request.RequestItems?.[TABLE]?.Keys ?? []) as Key[]).map((k) => k.unitId);

const unitIds = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `unit-${String(i).padStart(3, '0')}`);

const UNPROCESSED_MSG = 'units: BatchGet left keys unprocessed after retries';
const CHUNK_FAILED_MSG = 'units: BatchGet chunk failed - keys dropped';

describe('unitsRepo.getDisplaysByIds (stub client)', () => {
  it('reads 150 distinct ids plus 10 repeats in TWO BatchGets of 100 and 50 keys - repeats removed', async () => {
    const { doc, requests } = stubDoc();
    const { units } = makeRepo(doc);
    const distinct = unitIds(150);

    const found = await units.getDisplaysByIds([...distinct, ...distinct.slice(0, 10)]);

    expect(requests.map((r) => keysOf(r).length)).toEqual([100, 50]);
    // DynamoDB REJECTS a BatchGetItem that repeats a key.
    const sent = requests.flatMap(keysOf);
    expect(new Set(sent).size).toBe(sent.length);
    expect(new Set(sent)).toEqual(new Set(distinct));
    expect(found.size).toBe(150);
    expect(found.get('unit-007')).toEqual({ unitId: 'unit-007', address: addressOf('unit-007') });
  });

  it('projects ONLY unitId and address, through ExpressionAttributeNames', async () => {
    const { doc, requests } = stubDoc();
    const { units } = makeRepo(doc);

    await units.getDisplaysByIds(unitIds(120));

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(Object.keys(request.RequestItems ?? {})).toEqual([TABLE]);
      const { ProjectionExpression, ExpressionAttributeNames } = request.RequestItems![TABLE]!;
      const tokens = String(ProjectionExpression)
        .split(',')
        .map((token) => token.trim());
      // Aliases only, and they name exactly the two display fields.
      expect(tokens.every((token) => token.startsWith('#'))).toBe(true);
      expect(tokens.map((token) => ExpressionAttributeNames?.[token]).sort()).toEqual(['address', 'unitId']);
    }
  });

  it('retries UnprocessedKeys with the SAME keys until they are read', async () => {
    // The first answer withholds the last two keys; the retry serves them.
    const { doc, requests } = stubDoc((keys, call) =>
      call === 1 ? { served: keys.slice(0, -2), unprocessed: keys.slice(-2) } : { served: keys },
    );
    const { units, capture } = makeRepo(doc);
    const asked = unitIds(5);

    const found = await units.getDisplaysByIds(asked);

    expect(requests.map(keysOf)).toEqual([asked, asked.slice(-2)]);
    expect(found.size).toBe(5);
    expect(capture.atLevel(40)).toEqual([]);
  });

  it('stops after 4 attempts per chunk: keys still unread are DROPPED with one WARN carrying counts only', async () => {
    // A table that never catches up: every answer withholds its last key.
    const { doc, requests } = stubDoc((keys) => ({ served: keys.slice(0, -1), unprocessed: keys.slice(-1) }));
    const { units, capture } = makeRepo(doc);
    const asked = unitIds(3);

    const found = await units.getDisplaysByIds(asked);

    // The first request plus three retries, each for the key left unread.
    expect(requests.map(keysOf)).toEqual([asked, ['unit-002'], ['unit-002'], ['unit-002']]);
    expect([...found.keys()].sort()).toEqual(['unit-000', 'unit-001']);
    const warns = capture.atLevel(40);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({ msg: UNPROCESSED_MSG, unprocessed: 1, requested: 3 });
    // Counts only - never a unit id.
    expect(JSON.stringify(warns[0])).not.toMatch(/unit-\d/);
  });

  it('a chunk whose request THROWS is dropped with a WARN; the other chunks keep their results', async () => {
    // Three chunks (100, 100, 50); the middle one fails outright.
    const { doc, requests } = stubDoc((keys, call) => (call === 2 ? 'throw' : { served: keys }));
    const { units, capture } = makeRepo(doc);

    const found = await units.getDisplaysByIds(unitIds(250));

    expect(requests.map((r) => keysOf(r).length)).toEqual([100, 100, 50]);
    expect(found.size).toBe(150);
    expect(found.has('unit-000')).toBe(true); // read before the failure
    expect(found.has('unit-150')).toBe(false); // the failed chunk
    expect(found.has('unit-249')).toBe(true); // read after it
    // A thrown chunk also counts as unprocessed, so it logs TWO warns -
    // asserted by msg, never as a total.
    const warns = capture.atLevel(40);
    expect(warns.find((l) => l['msg'] === CHUNK_FAILED_MSG)).toMatchObject({ chunkKeys: 100 });
    expect(warns.find((l) => l['msg'] === UNPROCESSED_MSG)).toMatchObject({ unprocessed: 100, requested: 250 });
  });

  it('an empty id list makes NO call and returns an empty map', async () => {
    const { doc, requests } = stubDoc();
    const { units } = makeRepo(doc);

    const found = await units.getDisplaysByIds([]);

    expect(requests).toEqual([]);
    expect(found.size).toBe(0);
  });
});
