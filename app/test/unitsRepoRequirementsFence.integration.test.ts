// property requirements (spec 2026-10-20 D5 / D8; plan 2.3): the fenced unit
// writes - unitsRepo.updateIfRequirementsCurrent (the PATCH fence) and
// unitsRepo.applyRequirements (the Apply write) - against BOTH the real repo
// (DynamoDB Local) and the API-test fake (test/helpers/twilioWebhookHarness.ts
// createFakeWorld), which the route suites run on. Each writes only while the
// unit exists with the landlordId and requirement_sources the caller READ
// (absent included) and with every key of each requirement item the patch
// writes as READ (code review OR-29); applyRequirements also refuses a soft-deleted unit - a
// NON-EMPTY deleted_at, exactly as unitsRepo.isDeleted reads it (a blank
// deleted_at is live). A lost condition throws
// ConditionalCheckFailedException and writes nothing.
// An empty map REMOVEs the attribute (it is never stored empty). The fake half
// runs without Docker; the real half self-skips.
import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { planRequirementWrite } from '../src/lib/unitRequirementWrite.js';
import { createUnitsRepo, type UnitItem, type UnitsRepo } from '../src/repos/unitsRepo.js';
import { quietLogger } from './helpers/orgFixtures.js';
import { createFakeWorld } from './helpers/twilioWebhookHarness.js';

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
    `[unitsRepoRequirementsFence.integration] DynamoDB Local half SKIPPED - nothing at ${endpoint}. ` +
      'Run `npm run db:start` to exercise it.',
  );
}

const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
const client = createDynamoClient({ endpoint });
const doc = createDocumentClient({ endpoint });
const unitsTable = tableName('units', testEnv);

beforeAll(async () => {
  if (!reachable) return;
  await ensureTable(client, getTableSpec('units'), unitsTable);
}, 120_000);

afterAll(async () => {
  if (reachable) await deleteTableIfExists(client, unitsTable);
  doc.destroy();
  client.destroy();
}, 120_000);

const STAMP = '2026-10-01T09:00:00.000Z';

/** One implementation under test: the units repo plus raw seed / read / delete access. */
interface World {
  units: UnitsRepo;
  putUnit(item: UnitItem): Promise<void>;
  /** A CONSISTENT read, as the caller's OWN copy (what the fence compares against). */
  readUnit(unitId: string): Promise<UnitItem | undefined>;
  deleteUnit(unitId: string): Promise<void>;
}

function realWorld(): World {
  return {
    units: createUnitsRepo({ doc, env: testEnv, logger: quietLogger() }),
    async putUnit(item) {
      await doc.send(new PutCommand({ TableName: unitsTable, Item: item }));
    },
    async readUnit(unitId) {
      const { Item } = await doc.send(new GetCommand({ TableName: unitsTable, Key: { unitId }, ConsistentRead: true }));
      return Item as UnitItem | undefined;
    },
    async deleteUnit(unitId) {
      await doc.send(new DeleteCommand({ TableName: unitsTable, Key: { unitId } }));
    },
  };
}

function fakeWorld(): World {
  const world = createFakeWorld();
  return {
    units: world.unitsRepo,
    async putUnit(item) {
      world.units.set(item.unitId, structuredClone(item));
    },
    async readUnit(unitId) {
      const hit = world.units.get(unitId);
      return hit === undefined ? undefined : structuredClone(hit);
    },
    async deleteUnit(unitId) {
      world.units.delete(unitId);
    },
  };
}

/** One case against the harness fake (always) and DynamoDB Local (when reachable). */
function parity(name: string, run: (w: World, id: string) => Promise<void>): void {
  it(`${name} [harness fake]`, async () => {
    await run(fakeWorld(), `fake-${randomUUID().slice(0, 8)}`);
  });
  it.skipIf(!reachable)(`${name} [DynamoDB Local]`, async () => {
    await run(realWorld(), `real-${randomUUID().slice(0, 8)}`);
  });
}

/** A unit row owned by c-ll; a field given as undefined is left OFF (`landlordId: undefined` = ownerless). */
function unitRow(unitId: string, fields: Record<string, unknown> = {}): UnitItem {
  const row: Record<string, unknown> = {
    unitId,
    landlordId: 'c-ll',
    status: 'available',
    created_at: STAMP,
    updated_at: STAMP,
    ...fields,
  };
  for (const key of Object.keys(row)) if (row[key] === undefined) delete row[key];
  return row as UnitItem;
}

async function readBack(w: World, id: string): Promise<UnitItem> {
  const unit = await w.readUnit(id);
  if (unit === undefined) throw new Error(`unit ${id} not found`);
  return unit;
}

describe('unitsRepo.updateIfRequirementsCurrent - the PATCH fence (D5)', () => {
  parity('writes while the landlordId and the map are as read: SETs, REMOVEs, the new map whole, a fresh updated_at, ALL_NEW', async (w, id) => {
    await w.putUnit(unitRow(id, { pets: 'Cats OK', deposit: 900, requirement_sources: { pets: 'set_here' } }));
    const read = await readBack(w, id);
    const written = await w.units.updateIfRequirementsCurrent(read, {
      no_pets: true,
      pets: null,
      deposit: null,
      requirement_sources: { pets: 'copied', deposit: 'set_here' },
    });
    const stored = await readBack(w, id);
    expect(stored).toMatchObject({
      landlordId: 'c-ll',
      no_pets: true,
      requirement_sources: { pets: 'copied', deposit: 'set_here' },
    });
    expect(stored).not.toHaveProperty('pets');
    expect(stored).not.toHaveProperty('deposit');
    expect(stored.updated_at).not.toBe(STAMP);
    expect(written).toEqual(stored);
  });

  parity('writes on an ownerless unit with no map while both are still absent', async (w, id) => {
    await w.putUnit(unitRow(id, { landlordId: undefined }));
    const read = await readBack(w, id);
    await w.units.updateIfRequirementsCurrent(read, {
      credit_requirements: 'Score 600+',
      requirement_sources: { credit_requirements: 'set_here' },
    });
    const stored = await readBack(w, id);
    expect(stored).toMatchObject({
      credit_requirements: 'Score 600+',
      requirement_sources: { credit_requirements: 'set_here' },
    });
    expect(stored).not.toHaveProperty('landlordId');
  });

  parity('an EMPTY map in the patch REMOVEs the attribute', async (w, id) => {
    await w.putUnit(unitRow(id, { requirement_sources: { pets: 'set_here' } }));
    const read = await readBack(w, id);
    await w.units.updateIfRequirementsCurrent(read, { requirement_sources: {} });
    expect(await readBack(w, id)).not.toHaveProperty('requirement_sources');
  });

  parity('refuses when the map changed since the read - nothing written', async (w, id) => {
    await w.putUnit(unitRow(id, { requirement_sources: { pets: 'set_here' } }));
    const read = await readBack(w, id);
    await w.putUnit(unitRow(id, { requirement_sources: { pets: 'copied' } }));
    await expect(
      w.units.updateIfRequirementsCurrent(read, { pet_fee: '$300', requirement_sources: { pets: 'set_here' } }),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
    const stored = await readBack(w, id);
    expect(stored).not.toHaveProperty('pet_fee');
    expect(stored.requirement_sources).toEqual({ pets: 'copied' });
    expect(stored.updated_at).toBe(STAMP);
  });

  parity('refuses when the map was REMOVEd since the read - the old map is never written back', async (w, id) => {
    await w.putUnit(unitRow(id, { requirement_sources: { pets: 'set_here' } }));
    const read = await readBack(w, id);
    await w.putUnit(unitRow(id));
    await expect(
      w.units.updateIfRequirementsCurrent(read, { pet_fee: '$300', requirement_sources: { pets: 'set_here' } }),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
    const stored = await readBack(w, id);
    expect(stored).not.toHaveProperty('requirement_sources');
    expect(stored).not.toHaveProperty('pet_fee');
  });

  parity('refuses when a map appeared since a read that had none', async (w, id) => {
    await w.putUnit(unitRow(id));
    const read = await readBack(w, id);
    await w.putUnit(unitRow(id, { requirement_sources: { credit_requirements: 'set_here' } }));
    await expect(
      w.units.updateIfRequirementsCurrent(read, { income_requirements: '3x rent' }),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
    expect(await readBack(w, id)).not.toHaveProperty('income_requirements');
  });

  parity('refuses when the landlordId changed since the read', async (w, id) => {
    await w.putUnit(unitRow(id));
    const read = await readBack(w, id);
    await w.putUnit(unitRow(id, { landlordId: 'c-other' }));
    await expect(
      w.units.updateIfRequirementsCurrent(read, { income_requirements: '3x rent' }),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
    const stored = await readBack(w, id);
    expect(stored.landlordId).toBe('c-other');
    expect(stored).not.toHaveProperty('income_requirements');
  });

  parity('refuses when an ownerless unit was claimed since the read', async (w, id) => {
    await w.putUnit(unitRow(id, { landlordId: undefined }));
    const read = await readBack(w, id);
    await w.putUnit(unitRow(id, { landlordId: 'c-new' }));
    await expect(
      w.units.updateIfRequirementsCurrent(read, { income_requirements: '3x rent' }),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
    expect(await readBack(w, id)).not.toHaveProperty('income_requirements');
  });

  parity('refuses a unit that no longer exists - and never re-creates it', async (w, id) => {
    await w.putUnit(unitRow(id));
    const read = await readBack(w, id);
    await w.deleteUnit(id);
    await expect(
      w.units.updateIfRequirementsCurrent(read, { income_requirements: '3x rent' }),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
    expect(await w.readUnit(id)).toBeUndefined();
  });

  parity('writes on a soft-deleted unit (only the Apply write needs a live one)', async (w, id) => {
    await w.putUnit(unitRow(id, { deleted_at: STAMP }));
    const read = await readBack(w, id);
    await w.units.updateIfRequirementsCurrent(read, { income_requirements: '3x rent' });
    expect((await readBack(w, id))['income_requirements']).toBe('3x rent');
  });
});

// Code review RA-1 / OR-29: a write's classification (D5), its
// deposit_conflict (D1) and Apply's own values (D8) are computed from EVERY
// key of each item it touches, so both fenced writes also condition every key
// of each requirement item the patch writes on its value in the read - equal
// when the read holds it, attribute_not_exists when it does not - the whole
// item, not only the patch's keys. Each case below lands a colleague's write
// of the SAME item between the read and the stale write, with the map and the
// landlordId unchanged (the hole the landlordId + map fence left open).
describe('the fence covers the item values the write was computed from (code review RA-1 / OR-29)', () => {
  const MAP = { pets: 'set_here', deposit: 'set_here' } as const;
  const staleWrites: Array<[string, Record<string, unknown>, Record<string, unknown>, Record<string, unknown>]> = [
    // [the item key's value type, the row at the read, the row after the colleague's write, the stale patch]
    ['a string (the Pets details)', { pets: 'Cats OK', pet_fee: '$25' }, { pets: 'Dogs OK', pet_fee: '$25' }, { pet_fee: null, requirement_sources: { pets: 'copied', deposit: 'set_here' } }],
    ['a number (the fixed deposit amount)', { deposit: 900 }, { deposit: 950 }, { deposit_notes: 'Two payments' }],
    ['a legacy boolean pets', { pets: false }, { pets: true }, { pet_fee: '$300' }],
    ['a checkbox true (One month\'s rent, cleared since)', { deposit_one_month: true }, {}, { deposit_flexible: true }],
    ['absent (One month\'s rent, checked since)', {}, { deposit_one_month: true }, { deposit: 900 }],
    ['the patch key itself', { pet_fee: '$25' }, { pet_fee: '$50' }, { pet_fee: null }],
  ];
  for (const [kind, atRead, afterColleague, patch] of staleWrites) {
    parity(`updateIfRequirementsCurrent refuses a write computed from a stale item key - ${kind}; nothing written`, async (w, id) => {
      await w.putUnit(unitRow(id, { ...atRead, requirement_sources: MAP }));
      const read = await readBack(w, id);
      const colleague = unitRow(id, { ...afterColleague, requirement_sources: MAP });
      await w.putUnit(colleague);
      await expect(w.units.updateIfRequirementsCurrent(read, patch)).rejects.toBeInstanceOf(
        ConditionalCheckFailedException,
      );
      expect(await readBack(w, id)).toEqual(colleague);
    });
  }

  parity('applyRequirements refuses an Apply over an edit of the item it copies (the map unchanged) - nothing written', async (w, id) => {
    await w.putUnit(unitRow(id, { pets: 'Cats OK', requirement_sources: { pets: 'set_here' } }));
    const read = await readBack(w, id);
    const colleague = unitRow(id, { pets: 'Dogs OK', requirement_sources: { pets: 'set_here' } });
    await w.putUnit(colleague);
    await expect(
      w.units.applyRequirements(read, {
        no_pets: true,
        pets: null,
        pet_fee: '$300',
        requirement_sources: { pets: 'copied' },
      }),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
    expect(await readBack(w, id)).toEqual(colleague);
  });

  parity('(PIN) every key of the item as read - a legacy false, a number, a checkbox true, absent keys - is matched exactly and the write lands', async (w, id) => {
    await w.putUnit(unitRow(id, { pets: false, deposit: 900, deposit_flexible: true }));
    const read = await readBack(w, id);
    await w.units.updateIfRequirementsCurrent(read, {
      no_pets: true,
      pets: null,
      pet_fee: '$300',
      deposit_notes: 'Two payments',
    });
    const stored = await readBack(w, id);
    expect(stored).toMatchObject({ no_pets: true, pet_fee: '$300', deposit: 900, deposit_flexible: true, deposit_notes: 'Two payments' });
    expect(stored).not.toHaveProperty('pets');
  });

  parity("(PIN) the fence is per item: a colleague's write of ANOTHER item does not refuse the write", async (w, id) => {
    await w.putUnit(unitRow(id, { pets: 'Cats OK', credit_requirements: '600+' }));
    const read = await readBack(w, id);
    await w.putUnit(unitRow(id, { pets: 'Cats OK', credit_requirements: '650+' }));
    await w.units.updateIfRequirementsCurrent(read, { pet_fee: '$300' });
    expect(await readBack(w, id)).toMatchObject({ pets: 'Cats OK', pet_fee: '$300', credit_requirements: '650+' });
  });
});

// Code review RC-1: the PATCH landlord change through the fence - the patch
// the route's planner (planRequirementWrite) builds SETs landlordId, the very
// attribute the condition names, and REMOVEs requirement_sources, in ONE write.
describe('unitsRepo.updateIfRequirementsCurrent - a PATCH landlord change (D5; code review RC-1)', () => {
  parity('a landlord change SETs landlordId and REMOVEs the map in one write; a write from the older read is then refused', async (w, id) => {
    await w.putUnit(
      unitRow(id, { pets: 'Cats OK', requirement_sources: { pets: 'set_here', credit_requirements: 'copied' } }),
    );
    const before = await readBack(w, id);
    const plan = planRequirementWrite({
      stored: before,
      fields: { landlordId: 'c-new' },
      landlord: { contactId: 'c-new', type: 'landlord' },
      landlordChanged: true,
    });
    if (!plan.ok) throw new Error('the planner refused a landlord change');
    expect(plan.patch).toEqual({ landlordId: 'c-new', requirement_sources: null });
    const written = await w.units.updateIfRequirementsCurrent(before, plan.patch);
    const stored = await readBack(w, id);
    expect(stored.landlordId).toBe('c-new');
    expect(stored).not.toHaveProperty('requirement_sources');
    expect(stored['pets']).toBe('Cats OK');
    expect(stored.updated_at).not.toBe(STAMP);
    expect(written).toEqual(stored);
    // A slow write computed from the read BEFORE the change can never write
    // the old map back (the restore / claim guarantee, here for PATCH).
    await expect(
      w.units.updateIfRequirementsCurrent(before, {
        pet_fee: '$300',
        requirement_sources: { pets: 'set_here', credit_requirements: 'copied' },
      }),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
    expect(await readBack(w, id)).toEqual(stored);
  });

  parity('a landlord change that also touches an item: reset, then the item classified against the NEW landlord, in one write', async (w, id) => {
    await w.putUnit(unitRow(id, { pets: 'Cats OK', requirement_sources: { pets: 'set_here' } }));
    const before = await readBack(w, id);
    const plan = planRequirementWrite({
      stored: before,
      fields: { landlordId: 'c-new', income_requirements: '3x rent' },
      landlord: { contactId: 'c-new', type: 'landlord', req_income_requirements: '3x rent' },
      landlordChanged: true,
    });
    if (!plan.ok) throw new Error('the planner refused a landlord change');
    expect(plan.patch).toEqual({
      landlordId: 'c-new',
      income_requirements: '3x rent',
      requirement_sources: { income_requirements: 'copied' },
    });
    await w.units.updateIfRequirementsCurrent(before, plan.patch);
    const stored = await readBack(w, id);
    expect(stored).toMatchObject({
      landlordId: 'c-new',
      pets: 'Cats OK',
      income_requirements: '3x rent',
      requirement_sources: { income_requirements: 'copied' },
    });
  });
});

describe('unitsRepo.applyRequirements - the Apply write (D8)', () => {
  parity('applyRequirements writes a live unit whose landlordId and map are as read', async (w, id) => {
    await w.putUnit(unitRow(id, { pets: 'Cats OK', requirement_sources: { pets: 'set_here' } }));
    const read = await readBack(w, id);
    const written = await w.units.applyRequirements(read, {
      no_pets: true,
      pets: null,
      requirement_sources: { pets: 'copied' },
    });
    const stored = await readBack(w, id);
    expect(stored).toMatchObject({ no_pets: true, requirement_sources: { pets: 'copied' } });
    expect(stored).not.toHaveProperty('pets');
    expect(stored.updated_at).not.toBe(STAMP);
    expect(written).toEqual(stored);
  });

  parity('applyRequirements refuses a soft-deleted unit (a non-empty deleted_at) - nothing written', async (w, id) => {
    await w.putUnit(unitRow(id, { deleted_at: STAMP }));
    const read = await readBack(w, id);
    await expect(
      w.units.applyRequirements(read, { credit_requirements: 'Score 600+' }),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
    expect(await readBack(w, id)).not.toHaveProperty('credit_requirements');
  });

  parity('applyRequirements writes a unit whose deleted_at is BLANK - live, as isDeleted reads it', async (w, id) => {
    await w.putUnit(unitRow(id, { deleted_at: '' }));
    const read = await readBack(w, id);
    await w.units.applyRequirements(read, { credit_requirements: 'Score 600+' });
    const stored = await readBack(w, id);
    expect(stored['credit_requirements']).toBe('Score 600+');
    expect(stored.deleted_at).toBe('');
  });

  parity('applyRequirements refuses when the map changed since the read', async (w, id) => {
    await w.putUnit(unitRow(id));
    const read = await readBack(w, id);
    await w.putUnit(unitRow(id, { requirement_sources: { pets: 'set_here' } }));
    await expect(
      w.units.applyRequirements(read, { credit_requirements: 'Score 600+', requirement_sources: { credit_requirements: 'copied' } }),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
    const stored = await readBack(w, id);
    expect(stored.requirement_sources).toEqual({ pets: 'set_here' });
    expect(stored).not.toHaveProperty('credit_requirements');
  });

  parity('applyRequirements refuses when the landlordId changed since the read', async (w, id) => {
    await w.putUnit(unitRow(id));
    const read = await readBack(w, id);
    await w.putUnit(unitRow(id, { landlordId: 'c-other' }));
    await expect(
      w.units.applyRequirements(read, { credit_requirements: 'Score 600+' }),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
    expect(await readBack(w, id)).not.toHaveProperty('credit_requirements');
  });
});
