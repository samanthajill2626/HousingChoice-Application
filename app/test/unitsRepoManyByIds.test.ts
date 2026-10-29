// unitsRepo.getManyByIds (WP1 B2a spec D2.3; plan PR5, WI9): the FULL-item
// batch reader the ranking seen set uses. Complete or nothing: a chunk whose
// request fails rethrows, keys still unread after the retries throw
// IncompleteBatchReadError - an unread unit must never read as "not on file",
// which would change a tenant card and its fingerprint. A key the table
// answered with NO row is a complete read of an absent unit.
//
// Pure: a stub DocumentClient records every BatchGetCommand and answers from a
// per-test script (the unitsRepoDisplays.test.ts idiom). The DynamoDB Local
// round trip is unitsRepoManyByIds.integration.test.ts.
import { BatchGetCommand, type BatchGetCommandInput, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import { IncompleteBatchReadError } from '../src/repos/contactsRepo.js';
import { createUnitsRepo } from '../src/repos/unitsRepo.js';
import { createLogCapture } from './helpers/logCapture.js';
import { createFakeWorld } from './helpers/twilioWebhookHarness.js';

const TABLE = 'hc-test-x-units';

type Key = { unitId: string };
type Reply = { served: Key[]; unprocessed?: Key[] } | 'throw';

const fullUnit = (unitId: string) => ({
  unitId,
  landlordId: `ll-${unitId}`,
  status: 'available',
  beds: 2,
  rent_max: 1500,
  notes: `Notes for ${unitId}`,
  address: { line1: `${unitId} Main St`, city: 'Atlanta', state: 'GA' },
});

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
        Responses: { [TABLE]: reply.served.map(({ unitId }) => fullUnit(unitId)) },
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
  return { units: createUnitsRepo({ doc, env: { TABLE_PREFIX: 'hc-test-x-' }, logger }), capture };
}

const keysOf = (request: BatchGetCommandInput): string[] =>
  ((request.RequestItems?.[TABLE]?.Keys ?? []) as Key[]).map((k) => k.unitId);

const unitIds = (n: number): string[] => Array.from({ length: n }, (_, i) => `unit-${String(i).padStart(3, '0')}`);

describe('unitsRepo.getManyByIds (stub client)', () => {
  it('reads 150 distinct ids plus repeats in TWO BatchGets of 100 and 50 keys, repeats removed', async () => {
    const { doc, requests } = stubDoc();
    const { units } = makeRepo(doc);
    const distinct = unitIds(150);

    const found = await units.getManyByIds([...distinct, ...distinct.slice(0, 10)], { requireComplete: true });

    expect(requests.map((r) => keysOf(r).length)).toEqual([100, 50]);
    const sent = requests.flatMap(keysOf);
    expect(new Set(sent).size).toBe(sent.length);
    expect(found.size).toBe(150);
  });

  it('returns FULL items: no projection is sent, every stored attribute comes back', async () => {
    const { doc, requests } = stubDoc();
    const { units } = makeRepo(doc);

    const found = await units.getManyByIds(['unit-001'], { requireComplete: true });

    const entry = requests[0]!.RequestItems![TABLE]!;
    expect(entry.ProjectionExpression).toBeUndefined();
    expect(entry.ExpressionAttributeNames).toBeUndefined();
    expect(found.get('unit-001')).toEqual(fullUnit('unit-001'));
  });

  it('retries UnprocessedKeys with the SAME keys until they are read', async () => {
    const { doc, requests } = stubDoc((keys, call) =>
      call === 1 ? { served: keys.slice(0, -2), unprocessed: keys.slice(-2) } : { served: keys },
    );
    const { units, capture } = makeRepo(doc);
    const asked = unitIds(5);

    const found = await units.getManyByIds(asked, { requireComplete: true });

    expect(requests.map(keysOf)).toEqual([asked, asked.slice(-2)]);
    expect(found.size).toBe(5);
    expect(capture.atLevel(40)).toEqual([]);
  });

  it('keys still unread after 4 attempts THROW IncompleteBatchReadError naming the units table; no WARN', async () => {
    const { doc, requests } = stubDoc((keys) => ({ served: keys.slice(0, -1), unprocessed: keys.slice(-1) }));
    const { units, capture } = makeRepo(doc);

    const err = await units.getManyByIds(unitIds(3), { requireComplete: true }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(IncompleteBatchReadError);
    expect(err).toMatchObject({ unprocessed: 1, requested: 3 });
    expect((err as Error).message).toMatch(/^units batch read incomplete: 1 of 3 keys unread/);
    expect(requests).toHaveLength(4);
    expect(capture.atLevel(40)).toEqual([]);
  });

  it('a chunk whose request THROWS rethrows that error and reads no further chunk', async () => {
    const { doc, requests } = stubDoc((keys, call) => (call === 2 ? 'throw' : { served: keys }));
    const { units } = makeRepo(doc);

    await expect(units.getManyByIds(unitIds(250), { requireComplete: true })).rejects.toThrow(
      'stub: the request failed',
    );
    expect(requests.map((r) => keysOf(r).length)).toEqual([100, 100]);
  });

  it('a key the table answered with NO row is a complete read: absent, never a throw', async () => {
    const { doc } = stubDoc((keys) => ({ served: keys.filter((k) => k.unitId !== 'unit-001') }));
    const { units } = makeRepo(doc);

    const found = await units.getManyByIds(unitIds(3), { requireComplete: true });

    expect([...found.keys()].sort()).toEqual(['unit-000', 'unit-002']);
  });

  it('an empty id list makes NO call', async () => {
    const { doc, requests } = stubDoc();
    const { units } = makeRepo(doc);

    expect((await units.getManyByIds([], { requireComplete: true })).size).toBe(0);
    expect(requests).toEqual([]);
  });

  it('refuses to run as a best-effort read (the option is the contract)', async () => {
    const { doc, requests } = stubDoc();
    const { units } = makeRepo(doc);

    await expect(
      units.getManyByIds(['unit-001'], { requireComplete: false } as unknown as { requireComplete: true }),
    ).rejects.toThrow(/complete read only/);
    expect(requests).toEqual([]);
  });
});

describe('the harness fake unitsRepo.getManyByIds mirrors the repo', () => {
  it('answers full copies of the stored units; an unknown id is absent; a soft-deleted unit still answers', async () => {
    const world = createFakeWorld();
    world.units.set('unit-a', {
      unitId: 'unit-a',
      landlordId: 'll-a',
      status: 'available',
      beds: 3,
      created_at: '2026-10-01T00:00:00.000Z',
      updated_at: '2026-10-01T00:00:00.000Z',
    });
    world.units.set('unit-gone', {
      unitId: 'unit-gone',
      landlordId: 'll-b',
      status: 'available',
      deleted_at: '2026-10-02T00:00:00.000Z',
      created_at: '2026-10-01T00:00:00.000Z',
      updated_at: '2026-10-02T00:00:00.000Z',
    });

    const found = await world.unitsRepo.getManyByIds(['unit-a', 'unit-gone', 'unit-missing'], {
      requireComplete: true,
    });

    expect([...found.keys()].sort()).toEqual(['unit-a', 'unit-gone']);
    expect(found.get('unit-a')).toMatchObject({ beds: 3, landlordId: 'll-a' });
    found.get('unit-a')!.beds = 9;
    expect(world.units.get('unit-a')!.beds).toBe(3);
  });
});
