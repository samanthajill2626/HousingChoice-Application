// primary-contact-integrity (spec 2026-10-12 section 4.6, "Remove from the
// property"): the real unitsRepo.removeContact against DynamoDB Local.
// Removing the PRIMARY row hands the primary to the heir function's pick
// (lib/propertyContact.ts chooseHeir, the removed contact EXCLUDED): the live
// landlord of record - its row ADDED as primary when it has none - else the
// earliest-added remaining contact eligible for automatic routing; no heir
// clears every flag and REMOVEs the scalar. The liveness read is the caller's
// opts.readContacts, called per attempt after a CONSISTENT unit read; a failed
// read (or none supplied) is RosterReadFailedError and nothing is written.
// Removing a non-primary row reads nothing. opts.onPrimaryHandoff reports a
// hand-off once, after the write.
//
// Self-skipping like the other integration suites when nothing answers at
// DYNAMODB_ENDPOINT (`npm run db:start` to run for real).
import { randomUUID } from 'node:crypto';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createLogger } from '../src/lib/logger.js';
import type { RosterContactsRead } from '../src/lib/propertyContact.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import {
  createUnitsRepo,
  RosterReadFailedError,
  type PrimaryHandoff,
  type UnitContact,
} from '../src/repos/unitsRepo.js';
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
  console.warn(
    `[unitsRepoPrimaryOnRemove.integration] SKIPPED - no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

const GONE = '2026-10-01T09:00:00.000Z';

/** A contact record, typed landlord unless overridden. */
function person(contactId: string, fields: Partial<ContactItem> = {}): ContactItem {
  return { contactId, type: 'landlord', ...fields } as ContactItem;
}

/** A liveness read answering from `known` (any other id is missing), recording each call's ids. */
function livenessFrom(known: ContactItem[]): {
  read: (ids: string[]) => Promise<RosterContactsRead>;
  calls: string[][];
} {
  const calls: string[][] = [];
  const byId = new Map(known.map((c) => [c.contactId, c] as const));
  return {
    calls,
    read: async (ids) => {
      calls.push([...ids]);
      const found = new Map<string, ContactItem>();
      for (const id of ids) {
        const contact = byId.get(id);
        if (contact !== undefined) found.set(id, contact);
      }
      return { ok: true, byId: found };
    },
  };
}

const failedRead = async (): Promise<RosterContactsRead> => ({ ok: false });

describe.skipIf(!reachable)('unitsRepo.removeContact - the heir function (spec 4.6) against DynamoDB Local', () => {
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

  async function ownerlessUnit(contacts: UnitContact[], primary?: string): Promise<string> {
    const created = await units.create({ landlordId: 'c-temp', status: 'available' });
    await units.update(created.unitId, {
      landlordId: null,
      contacts,
      ...(primary !== undefined && { primary_contact: primary }),
    });
    return created.unitId;
  }

  async function ownedUnit(landlordId: string, contacts: UnitContact[], primary?: string): Promise<string> {
    const created = await units.create({
      landlordId,
      status: 'available',
      contacts,
      ...(primary !== undefined && { primary_contact: primary }),
    });
    return created.unitId;
  }

  function countingRepo(unitId: string) {
    const counter = { writes: 0 };
    const countingDoc = Object.create(doc) as typeof doc;
    countingDoc.send = (async (command: Parameters<typeof doc.send>[0]) => {
      if (command instanceof UpdateCommand && command.input.Key?.['unitId'] === unitId) counter.writes += 1;
      return doc.send(command);
    }) as typeof doc.send;
    return { repo: createUnitsRepo({ doc: countingDoc, env: testEnv, logger }), counter };
  }

  /** A repo whose FIRST read of `unitId` is followed by `race`; records every unit read's ConsistentRead. */
  function racingRepo(unitId: string, race: () => Promise<unknown>) {
    const counter = { unitReads: [] as Array<boolean | undefined> };
    let raced = false;
    const racingDoc = Object.create(doc) as typeof doc;
    racingDoc.send = (async (command: Parameters<typeof doc.send>[0]) => {
      const result = await doc.send(command);
      if (command instanceof GetCommand && command.input.Key?.['unitId'] === unitId) {
        counter.unitReads.push(command.input.ConsistentRead);
        if (!raced) {
          raced = true;
          await race();
        }
      }
      return result;
    }) as typeof doc.send;
    return { repo: createUnitsRepo({ doc: racingDoc, env: testEnv, logger }), counter };
  }

  it('the live landlord of record takes over - flag and scalar - and onPrimaryHandoff reports it once', async () => {
    const unitId = await ownedUnit(
      'c-ll',
      [
        { contactId: 'c-ll', role: 'landlord', primaryContact: false },
        { contactId: 'c-pm', role: 'pm', primaryContact: true },
      ],
      'c-pm',
    );
    const liveness = livenessFrom([person('c-ll'), person('c-pm')]);
    const handoffs: PrimaryHandoff[] = [];

    const updated = await units.removeContact(unitId, 'c-pm', {
      readContacts: liveness.read,
      onPrimaryHandoff: (handoff) => {
        handoffs.push(handoff);
      },
    });

    expect(updated.contacts).toEqual([{ contactId: 'c-ll', role: 'landlord', primaryContact: true }]);
    expect(updated.primary_contact).toBe('c-ll');
    expect(handoffs).toEqual([{ from: 'c-pm', to: 'c-ll' }]);
    // The removed contact is excluded, never asked about.
    expect(liveness.calls.flat()).not.toContain('c-pm');
  });

  it('an off-roster landlord of record takes over: a landlord row is ADDED as the primary', async () => {
    const unitId = await ownedUnit('c-ll', [{ contactId: 'c-pm', role: 'pm', primaryContact: true }], 'c-pm');

    const updated = await units.removeContact(unitId, 'c-pm', {
      readContacts: livenessFrom([person('c-ll')]).read,
    });

    expect(updated.contacts).toHaveLength(1);
    expect(updated.contacts).toContainEqual(
      expect.objectContaining({ contactId: 'c-ll', role: 'landlord', primaryContact: true }),
    );
    expect(updated.primary_contact).toBe('c-ll');
  });

  it('no landlord of record: the EARLIEST-added remaining eligible contact takes over - a tenant, a soft-deleted landlord-typed contact and a caseworker are skipped', async () => {
    const unitId = await ownerlessUnit(
      [
        { contactId: 'c-ten', role: 'other', primaryContact: false },
        { contactId: 'c-gone', role: 'pm', primaryContact: false },
        { contactId: 'c-cw', role: 'other', primaryContact: false },
        { contactId: 'c-own', role: 'owner', primaryContact: false },
        { contactId: 'c-pm', role: 'pm', primaryContact: true },
        { contactId: 'c-late', role: 'pm', primaryContact: false },
      ],
      'c-pm',
    );
    const liveness = livenessFrom([
      person('c-ten', { type: 'tenant' }),
      person('c-gone', { deleted_at: GONE }),
      person('c-cw', { type: 'partner', role: 'Caseworker' }),
      person('c-own'),
      person('c-late'),
    ]);

    const updated = await units.removeContact(unitId, 'c-pm', { readContacts: liveness.read });

    expect(updated.contacts).toEqual([
      { contactId: 'c-ten', role: 'other', primaryContact: false },
      { contactId: 'c-gone', role: 'pm', primaryContact: false },
      { contactId: 'c-cw', role: 'other', primaryContact: false },
      { contactId: 'c-own', role: 'owner', primaryContact: true },
      { contactId: 'c-late', role: 'pm', primaryContact: false },
    ]);
    expect(updated.primary_contact).toBe('c-own');
  });

  it('a soft-deleted landlord of record is skipped for the earliest eligible roster contact; landlordId stays', async () => {
    const unitId = await ownedUnit(
      'c-ll',
      [
        { contactId: 'c-ll', role: 'landlord', primaryContact: false },
        { contactId: 'c-pm', role: 'pm', primaryContact: true },
        { contactId: 'c-own', role: 'owner', primaryContact: false },
      ],
      'c-pm',
    );

    const updated = await units.removeContact(unitId, 'c-pm', {
      readContacts: livenessFrom([person('c-ll', { deleted_at: GONE }), person('c-own')]).read,
    });

    expect(updated.contacts).toEqual([
      { contactId: 'c-ll', role: 'landlord', primaryContact: false },
      { contactId: 'c-own', role: 'owner', primaryContact: true },
    ]);
    expect(updated.primary_contact).toBe('c-own');
    expect(updated.landlordId).toBe('c-ll');
  });

  it('no heir (nobody eligible left): every flag cleared, the scalar REMOVEd, no hand-off reported', async () => {
    const unitId = await ownerlessUnit(
      [
        { contactId: 'c-ten', role: 'other', primaryContact: false },
        { contactId: 'c-pm', role: 'pm', primaryContact: true },
      ],
      'c-pm',
    );
    const handoffs: PrimaryHandoff[] = [];

    const updated = await units.removeContact(unitId, 'c-pm', {
      readContacts: livenessFrom([person('c-ten', { type: 'tenant' })]).read,
      onPrimaryHandoff: (handoff) => {
        handoffs.push(handoff);
      },
    });

    expect(updated.contacts).toEqual([{ contactId: 'c-ten', role: 'other', primaryContact: false }]);
    expect(updated.primary_contact).toBeUndefined();
    expect(handoffs).toEqual([]);
  });

  const UNKNOWN_READS: Array<[string, ((ids: string[]) => Promise<RosterContactsRead>) | undefined]> = [
    ['the read failed', failedRead],
    ['no read was supplied', undefined],
  ];
  it.each(UNKNOWN_READS)('liveness unknown (%s): RosterReadFailedError - nothing written', async (_case, read) => {
    const roster: UnitContact[] = [
      { contactId: 'c-ll', role: 'landlord', primaryContact: false },
      { contactId: 'c-pm', role: 'pm', primaryContact: true },
    ];
    const unitId = await ownedUnit('c-ll', roster, 'c-pm');
    const { repo, counter } = countingRepo(unitId);

    await expect(
      repo.removeContact(unitId, 'c-pm', read === undefined ? undefined : { readContacts: read }),
    ).rejects.toBeInstanceOf(RosterReadFailedError);

    expect(counter.writes).toBe(0);
    const stored = await units.getById(unitId, { consistentRead: true });
    expect(stored?.contacts).toEqual(roster);
    expect(stored?.primary_contact).toBe('c-pm');
  });

  it('(PIN) removing a NON-primary row reads no liveness - it succeeds even with a read that would fail', async () => {
    const unitId = await ownedUnit(
      'c-ll',
      [
        { contactId: 'c-ll', role: 'landlord', primaryContact: true },
        { contactId: 'c-pm', role: 'pm', primaryContact: false },
      ],
      'c-ll',
    );
    let reads = 0;
    const counted = async (): Promise<RosterContactsRead> => {
      reads += 1;
      return { ok: false };
    };

    const updated = await units.removeContact(unitId, 'c-pm', { readContacts: counted });

    expect(updated.contacts).toEqual([{ contactId: 'c-ll', role: 'landlord', primaryContact: true }]);
    expect(updated.primary_contact).toBe('c-ll');
    expect(reads).toBe(0);
  });

  it('(PIN) every attempt reads the unit CONSISTENTLY, and a retry decides the heir again on its own read', async () => {
    const unitId = await ownerlessUnit(
      [
        { contactId: 'c-pm', role: 'pm', primaryContact: true },
        { contactId: 'c-own', role: 'owner', primaryContact: false },
      ],
      'c-pm',
    );
    // Staff B's write lands right after attempt 1's read: c-first is now the
    // earliest-added row. Attempt 1 decides c-own, its write loses the roster
    // condition, and attempt 2 re-reads and decides c-first.
    const { repo, counter } = racingRepo(unitId, () =>
      doc.send(
        new UpdateCommand({
          TableName: tableName('units', testEnv),
          Key: { unitId },
          UpdateExpression: 'SET #c = :c',
          ExpressionAttributeNames: { '#c': 'contacts' },
          ExpressionAttributeValues: {
            ':c': [
              { contactId: 'c-first', role: 'owner', primaryContact: false },
              { contactId: 'c-pm', role: 'pm', primaryContact: true },
              { contactId: 'c-own', role: 'owner', primaryContact: false },
            ],
          },
        }),
      ),
    );
    const liveness = livenessFrom([person('c-first'), person('c-own')]);
    const handoffs: PrimaryHandoff[] = [];

    const updated = await repo.removeContact(unitId, 'c-pm', {
      readContacts: liveness.read,
      onPrimaryHandoff: (handoff) => {
        handoffs.push(handoff);
      },
    });

    expect(updated.contacts).toEqual([
      { contactId: 'c-first', role: 'owner', primaryContact: true },
      { contactId: 'c-own', role: 'owner', primaryContact: false },
    ]);
    expect(updated.primary_contact).toBe('c-first');
    expect(liveness.calls).toHaveLength(2);
    expect(handoffs).toEqual([{ from: 'c-pm', to: 'c-first' }]);
    expect(counter.unitReads.length).toBeGreaterThanOrEqual(2);
    expect(counter.unitReads.every((consistent) => consistent === true)).toBe(true);
  });
});
