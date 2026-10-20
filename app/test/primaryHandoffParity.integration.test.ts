// primary-contact-integrity (spec 2026-10-12 section 10, "Parity"): the real
// unitsRepo (DynamoDB Local) and the API-test fake
// (test/helpers/twilioWebhookHarness.ts createFakeWorld) give the SAME result
// for the heir cases, because both call lib/propertyContact.ts chooseHeir /
// applyPrimary (and for P2, because both call decideAutoPrimary). Each case
// runs once through each implementation from the same stored shape and the
// same liveness read; the roster, the scalar, the landlord of record and the
// soft-delete state must match - and, where given, equal the expected outcome.
//
// Self-skipping like the other integration suites when nothing answers at
// DYNAMODB_ENDPOINT (`npm run db:start` to run for real).
import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createLogger } from '../src/lib/logger.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import {
  createUnitsRepo,
  type ReadRosterContacts,
  type UnitContact,
  type UnitItem,
  type UnitsRepo,
} from '../src/repos/unitsRepo.js';
import { createLogCapture } from './helpers/logCapture.js';
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
    `[primaryHandoffParity.integration] SKIPPED - no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

const GONE = '2026-10-01T09:00:00.000Z';
const LANDLORD_FACTS = { caseworker: false, landlordTyped: true, autoPrimaryEligible: true };

function person(contactId: string, fields: Partial<ContactItem> = {}): ContactItem {
  return { contactId, type: 'landlord', ...fields } as ContactItem;
}

/** A complete liveness read answering from `known` (any other id is missing). */
function liveness(known: ContactItem[]): ReadRosterContacts {
  const byId = new Map(known.map((c) => [c.contactId, c] as const));
  return async (ids) => {
    const found = new Map<string, ContactItem>();
    for (const id of ids) {
      const contact = byId.get(id);
      if (contact !== undefined) found.set(id, contact);
    }
    return { ok: true, byId: found };
  };
}

function row(contactId: string, role: UnitContact['role'], primaryContact: boolean): UnitContact {
  return { contactId, role, primaryContact };
}

interface Shape {
  landlordId?: string;
  contacts: UnitContact[];
  primary?: string;
  deleted?: boolean;
  /** property requirements (spec 2026-10-20 D5): the stored requirement_sources map. */
  sources?: UnitItem['requirement_sources'];
}

interface ParityCase {
  shape: Shape;
  people: ContactItem[];
  act: (repo: UnitsRepo, unitId: string, read: ReadRosterContacts) => Promise<unknown>;
  /** The outcome, when the case pins it (an ADDED landlord row's position is applyPrimary's choice). */
  expected?: {
    contacts: UnitContact[];
    primary: string | null;
    /** The requirement_sources the write leaves; null = REMOVEd; undefined = not pinned. */
    sources?: UnitItem['requirement_sources'] | null;
  };
}

const remove =
  (contactId: string) =>
  (repo: UnitsRepo, unitId: string, read: ReadRosterContacts): Promise<unknown> =>
    repo.removeContact(unitId, contactId, { readContacts: read });

const CASES: Array<[string, ParityCase]> = [
  [
    'remove: the live landlord of record takes over',
    {
      shape: { landlordId: 'c-ll', contacts: [row('c-ll', 'landlord', false), row('c-pm', 'pm', true)], primary: 'c-pm' },
      people: [person('c-ll')],
      act: remove('c-pm'),
      expected: { contacts: [row('c-ll', 'landlord', true)], primary: 'c-ll' },
    },
  ],
  [
    'remove: an off-roster landlord of record gets a row as the primary',
    {
      shape: { landlordId: 'c-ll', contacts: [row('c-pm', 'pm', true), row('c-own', 'owner', false)], primary: 'c-pm' },
      people: [person('c-ll'), person('c-own')],
      act: remove('c-pm'),
    },
  ],
  [
    'remove: no landlord - the earliest-added eligible contact takes over',
    {
      shape: {
        contacts: [
          row('c-ten', 'other', false),
          row('c-gone', 'pm', false),
          row('c-own', 'owner', false),
          row('c-pm', 'pm', true),
          row('c-late', 'pm', false),
        ],
        primary: 'c-pm',
      },
      people: [person('c-ten', { type: 'tenant' }), person('c-gone', { deleted_at: GONE }), person('c-own'), person('c-late')],
      act: remove('c-pm'),
      expected: {
        contacts: [
          row('c-ten', 'other', false),
          row('c-gone', 'pm', false),
          row('c-own', 'owner', true),
          row('c-late', 'pm', false),
        ],
        primary: 'c-own',
      },
    },
  ],
  [
    'remove: nobody eligible - every flag cleared, the scalar removed',
    {
      shape: { contacts: [row('c-ten', 'other', false), row('c-pm', 'pm', true)], primary: 'c-pm' },
      people: [person('c-ten', { type: 'tenant' })],
      act: remove('c-pm'),
      expected: { contacts: [row('c-ten', 'other', false)], primary: null },
    },
  ],
  [
    'remove: a soft-deleted landlord of record is skipped',
    {
      shape: {
        landlordId: 'c-ll',
        contacts: [row('c-ll', 'landlord', false), row('c-pm', 'pm', true), row('c-own', 'owner', false)],
        primary: 'c-pm',
      },
      people: [person('c-ll', { deleted_at: GONE }), person('c-own')],
      act: remove('c-pm'),
      expected: { contacts: [row('c-ll', 'landlord', false), row('c-own', 'owner', true)], primary: 'c-own' },
    },
  ],
  [
    'delete hand-off: moved to the earliest eligible contact, the deleted row kept',
    {
      shape: {
        contacts: [row('c-d', 'pm', true), row('c-cw', 'other', false), row('c-own', 'owner', false)],
        primary: 'c-d',
      },
      people: [person('c-cw', { type: 'partner', role: 'Caseworker' }), person('c-own')],
      act: (repo, unitId, read) => repo.handOffPrimaryFrom(unitId, 'c-d', read),
      expected: {
        contacts: [row('c-d', 'pm', false), row('c-cw', 'other', false), row('c-own', 'owner', true)],
        primary: 'c-own',
      },
    },
  ],
  [
    'delete hand-off: no heir - unchanged',
    {
      shape: { contacts: [row('c-d', 'pm', true), row('c-ten', 'other', false)], primary: 'c-d' },
      people: [person('c-ten', { type: 'tenant' })],
      act: (repo, unitId, read) => repo.handOffPrimaryFrom(unitId, 'c-d', read),
      expected: { contacts: [row('c-d', 'pm', true), row('c-ten', 'other', false)], primary: 'c-d' },
    },
  ],
  // Planner fix wave F2: the shared contactIsPrimaryToHandOff on both sides.
  [
    'delete hand-off: NO row flagged - the deleted landlord of record hands off, landlordId kept',
    {
      shape: { landlordId: 'c-ll', contacts: [row('c-ll', 'landlord', false), row('c-pm', 'pm', false)] },
      people: [person('c-pm')],
      act: (repo, unitId, read) => repo.handOffPrimaryFrom(unitId, 'c-ll', read),
      expected: { contacts: [row('c-ll', 'landlord', false), row('c-pm', 'pm', true)], primary: 'c-pm' },
    },
  ],
  [
    'delete hand-off: NO row flagged and the deleted contact is not the landlord of record - unchanged',
    {
      shape: { landlordId: 'c-other', contacts: [row('c-other', 'landlord', false), row('c-d', 'pm', false)] },
      people: [person('c-other')],
      act: (repo, unitId, read) => repo.handOffPrimaryFrom(unitId, 'c-d', read),
      expected: { contacts: [row('c-other', 'landlord', false), row('c-d', 'pm', false)], primary: null },
    },
  ],
  [
    'delete hand-off: a flagged row elsewhere wins over the deleted landlord of record - unchanged',
    {
      shape: {
        landlordId: 'c-ll',
        contacts: [row('c-ll', 'landlord', false), row('c-pm', 'pm', true)],
        primary: 'c-pm',
      },
      people: [person('c-pm')],
      act: (repo, unitId, read) => repo.handOffPrimaryFrom(unitId, 'c-ll', read),
      expected: { contacts: [row('c-ll', 'landlord', false), row('c-pm', 'pm', true)], primary: 'c-pm' },
    },
  ],
  [
    'restore swap: a soft-deleted new landlord is skipped for the earliest eligible contact',
    {
      shape: {
        landlordId: 'c-old',
        contacts: [row('c-old', 'landlord', true), row('c-pm', 'pm', false)],
        primary: 'c-old',
        deleted: true,
      },
      people: [person('c-new', { deleted_at: GONE }), person('c-pm')],
      act: (repo, unitId, read) =>
        repo.restoreWithLandlord(
          unitId,
          { expectLandlordId: 'c-old', next: { contactId: 'c-new' } },
          { readContacts: read },
        ),
      expected: { contacts: [row('c-pm', 'pm', true), row('c-new', 'landlord', false)], primary: 'c-pm' },
    },
  ],
  [
    'add (P2): a soft-deleted flagged primary counts as absent',
    {
      shape: { contacts: [row('c-dead', 'pm', true)], primary: 'c-dead' },
      people: [person('c-dead', { deleted_at: GONE })],
      act: (repo, unitId, read) =>
        repo.addContact(unitId, { contactId: 'c-new', role: 'pm' }, LANDLORD_FACTS, { readContacts: read }),
      expected: { contacts: [row('c-dead', 'pm', false), row('c-new', 'pm', true)], primary: 'c-new' },
    },
  ],
  // property requirements (spec 2026-10-20 D5): a change of the landlord of
  // record REMOVEs requirement_sources in the same write; a roster write that
  // keeps the landlord leaves it alone; and a fenced write read BEFORE the
  // change can never write its map back.
  [
    'restore swap (requirements): the map is removed',
    {
      shape: {
        landlordId: 'c-old',
        contacts: [row('c-old', 'landlord', false), row('c-pm', 'pm', true)],
        primary: 'c-pm',
        deleted: true,
        sources: { pets: 'set_here' },
      },
      people: [person('c-new'), person('c-pm')],
      act: (repo, unitId, read) =>
        repo.restoreWithLandlord(
          unitId,
          { expectLandlordId: 'c-old', next: { contactId: 'c-new' } },
          { readContacts: read },
        ),
      expected: { contacts: [row('c-pm', 'pm', true), row('c-new', 'landlord', false)], primary: 'c-pm', sources: null },
    },
  ],
  [
    'restore clear (requirements): the map is removed',
    {
      shape: {
        landlordId: 'c-old',
        contacts: [row('c-old', 'landlord', false), row('c-pm', 'pm', true)],
        primary: 'c-pm',
        deleted: true,
        sources: { pets: 'set_here' },
      },
      people: [person('c-pm')],
      act: (repo, unitId, read) =>
        repo.restoreWithLandlord(
          unitId,
          {
            expectLandlordId: 'c-old',
            next: null,
            expectContacts: [row('c-old', 'landlord', false), row('c-pm', 'pm', true)],
            promote: null,
          },
          { readContacts: read },
        ),
      expected: { contacts: [row('c-pm', 'pm', true)], primary: 'c-pm', sources: null },
    },
  ],
  [
    'add (requirements): a claim of the vacant landlord slot removes the map',
    {
      shape: { contacts: [row('c-pm', 'pm', true)], primary: 'c-pm', sources: { credit_requirements: 'set_here' } },
      people: [person('c-pm'), person('c-new')],
      act: (repo, unitId, read) =>
        repo.addContact(unitId, { contactId: 'c-new', role: 'landlord' }, LANDLORD_FACTS, { readContacts: read }),
      expected: { contacts: [row('c-pm', 'pm', true), row('c-new', 'landlord', false)], primary: 'c-pm', sources: null },
    },
  ],
  [
    '(PIN) add (requirements): a row that is not a claim leaves the map alone',
    {
      shape: { landlordId: 'c-ll', contacts: [row('c-ll', 'landlord', true)], primary: 'c-ll', sources: { pets: 'copied' } },
      people: [person('c-ll'), person('c-pm')],
      act: (repo, unitId, read) =>
        repo.addContact(unitId, { contactId: 'c-pm', role: 'pm' }, LANDLORD_FACTS, { readContacts: read }),
      expected: {
        contacts: [row('c-ll', 'landlord', true), row('c-pm', 'pm', false)],
        primary: 'c-ll',
        sources: { pets: 'copied' },
      },
    },
  ],
  [
    '(PIN) remove (requirements): a non-primary removal leaves the map alone',
    {
      shape: {
        landlordId: 'c-ll',
        contacts: [row('c-ll', 'landlord', true), row('c-pm', 'pm', false)],
        primary: 'c-ll',
        sources: { pets: 'copied' },
      },
      people: [person('c-ll')],
      act: remove('c-pm'),
      expected: { contacts: [row('c-ll', 'landlord', true)], primary: 'c-ll', sources: { pets: 'copied' } },
    },
  ],
  [
    'slow fenced write (requirements): a read taken before a restore swap never writes its map back',
    {
      shape: {
        landlordId: 'c-old',
        contacts: [row('c-old', 'landlord', false), row('c-pm', 'pm', true)],
        primary: 'c-pm',
        deleted: true,
        sources: { pets: 'set_here' },
      },
      people: [person('c-new'), person('c-pm')],
      act: async (repo, unitId, read) => {
        const before = structuredClone(await repo.getById(unitId, { consistentRead: true })) as UnitItem;
        await repo.restoreWithLandlord(
          unitId,
          { expectLandlordId: 'c-old', next: { contactId: 'c-new' } },
          { readContacts: read },
        );
        await expect(
          repo.updateIfRequirementsCurrent(before, { pet_fee: '$300', requirement_sources: { pets: 'set_here' } }),
        ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
        expect((await repo.getById(unitId, { consistentRead: true }))?.['pet_fee']).toBeUndefined();
      },
      expected: { contacts: [row('c-pm', 'pm', true), row('c-new', 'landlord', false)], primary: 'c-pm', sources: null },
    },
  ],
  [
    'slow fenced write (requirements): a read taken before a landlord claim never writes its map back',
    {
      shape: { contacts: [row('c-pm', 'pm', true)], primary: 'c-pm', sources: { credit_requirements: 'set_here' } },
      people: [person('c-pm'), person('c-new')],
      act: async (repo, unitId, read) => {
        const before = structuredClone(await repo.getById(unitId, { consistentRead: true })) as UnitItem;
        await repo.addContact(unitId, { contactId: 'c-new', role: 'landlord' }, LANDLORD_FACTS, { readContacts: read });
        await expect(
          repo.updateIfRequirementsCurrent(before, {
            credit_requirements: 'Score 600+',
            requirement_sources: { credit_requirements: 'set_here' },
          }),
        ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
        expect((await repo.getById(unitId, { consistentRead: true }))?.['credit_requirements']).toBeUndefined();
      },
      expected: { contacts: [row('c-pm', 'pm', true), row('c-new', 'landlord', false)], primary: 'c-pm', sources: null },
    },
  ],
];

/** The fields a roster write decides. */
function observe(unit: UnitItem | undefined) {
  return {
    contacts: unit?.contacts ?? null,
    primary: unit?.primary_contact ?? null,
    landlordId: unit?.landlordId ?? null,
    deleted: typeof unit?.deleted_at === 'string',
    sources: unit?.requirement_sources ?? null,
  };
}

describe.skipIf(!reachable)('heir parity: the real unitsRepo and the API-test fake (spec section 10)', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const units = createUnitsRepo({ doc, env: testEnv, logger });

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('units'), tableName('units', testEnv));
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, tableName('units', testEnv));
    doc.destroy();
    client.destroy();
  }, 120_000);

  async function seedReal(shape: Shape): Promise<string> {
    const created = await units.create({
      landlordId: shape.landlordId ?? 'c-temp',
      status: 'available',
      contacts: structuredClone(shape.contacts),
      ...(shape.primary !== undefined && { primary_contact: shape.primary }),
      ...(shape.sources !== undefined && { requirement_sources: structuredClone(shape.sources) }),
    });
    if (shape.landlordId === undefined) await units.update(created.unitId, { landlordId: null });
    if (shape.deleted === true) await units.softDelete(created.unitId, GONE);
    return created.unitId;
  }

  it.each(CASES)('%s: the real repo and the fake agree', async (_name, c) => {
    const realId = await seedReal(c.shape);
    await c.act(units, realId, liveness(c.people));
    const real = observe(await units.getById(realId, { consistentRead: true }));

    const world = createFakeWorld();
    world.units.set('u-parity', {
      unitId: 'u-parity',
      status: 'available',
      contacts: structuredClone(c.shape.contacts),
      ...(c.shape.landlordId !== undefined && { landlordId: c.shape.landlordId }),
      ...(c.shape.primary !== undefined && { primary_contact: c.shape.primary }),
      ...(c.shape.deleted === true && { deleted_at: GONE }),
      ...(c.shape.sources !== undefined && { requirement_sources: structuredClone(c.shape.sources) }),
    } as UnitItem);
    await c.act(world.unitsRepo, 'u-parity', liveness(c.people));
    const fake = observe(world.units.get('u-parity'));

    expect(fake).toEqual(real);
    if (c.expected !== undefined) {
      expect(real.contacts).toEqual(c.expected.contacts);
      expect(real.primary).toBe(c.expected.primary);
      if (c.expected.sources !== undefined) expect(real.sources).toEqual(c.expected.sources);
    }
  });
});
