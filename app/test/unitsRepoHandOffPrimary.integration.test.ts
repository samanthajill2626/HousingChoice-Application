// primary-contact-integrity (spec 2026-10-12 section 4.6, "Delete the
// contact"; plan contract 2.2): the real unitsRepo.handOffPrimaryFrom and the
// consistent Scan against DynamoDB Local. handOffPrimaryFrom(unit, deleted,
// read) re-reads the unit CONSISTENTLY, re-checks that `deleted` is STILL the
// flagged primary (else not_primary), runs the heir function with that
// contact EXCLUDED and never read, and: heir -> moves the flag AND the scalar
// in one conditional write (moved); no heir -> nothing changes (unchanged);
// failed read -> nothing changes (unknown). A lost conditional write re-reads,
// re-checks and re-decides, bounded at three attempts
// (RosterWriteConflictError). list({ consistentRead: true }) sends
// ConsistentRead on its Scan.
//
// Self-skipping like the other integration suites when nothing answers at
// DYNAMODB_ENDPOINT (`npm run db:start` to run for real).
import { randomUUID } from 'node:crypto';
import { GetCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createLogger } from '../src/lib/logger.js';
import type { RosterContactsRead } from '../src/lib/propertyContact.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import { createUnitsRepo, RosterWriteConflictError, type UnitContact } from '../src/repos/unitsRepo.js';
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
    `[unitsRepoHandOffPrimary.integration] SKIPPED - no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

const GONE = '2026-10-01T09:00:00.000Z';

function person(contactId: string, fields: Partial<ContactItem> = {}): ContactItem {
  return { contactId, type: 'landlord', ...fields } as ContactItem;
}

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

describe.skipIf(!reachable)('unitsRepo.handOffPrimaryFrom + list({ consistentRead }) (spec 4.6) against DynamoDB Local', () => {
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

  /** A repo whose FIRST read of `unitId` is followed by `race`; counts writes and unit reads. */
  function racingRepo(unitId: string, race: () => Promise<unknown>) {
    const counter = { writes: 0, unitReads: [] as Array<boolean | undefined> };
    let raced = false;
    const racingDoc = Object.create(doc) as typeof doc;
    racingDoc.send = (async (command: Parameters<typeof doc.send>[0]) => {
      if (command instanceof UpdateCommand && command.input.Key?.['unitId'] === unitId) counter.writes += 1;
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

  /** Overwrite a unit's contacts (and optionally its scalar) on the raw client. */
  function rawRosterWrite(unitId: string, contacts: UnitContact[], primary?: string) {
    return doc.send(
      new UpdateCommand({
        TableName: tableName('units', testEnv),
        Key: { unitId },
        UpdateExpression: primary !== undefined ? 'SET #c = :c, #p = :p' : 'SET #c = :c',
        ExpressionAttributeNames: {
          '#c': 'contacts',
          ...(primary !== undefined && { '#p': 'primary_contact' }),
        },
        ExpressionAttributeValues: { ':c': contacts, ...(primary !== undefined && { ':p': primary }) },
      }),
    );
  }

  it('moved: the live landlord of record takes over; the deleted contact keeps its row, unflagged', async () => {
    const unitId = await ownedUnit(
      'c-ll',
      [
        { contactId: 'c-ll', role: 'landlord', primaryContact: false },
        { contactId: 'c-d', role: 'pm', primaryContact: true },
      ],
      'c-d',
    );
    const liveness = livenessFrom([person('c-ll')]);

    const result = await units.handOffPrimaryFrom(unitId, 'c-d', liveness.read);

    expect(result).toMatchObject({ outcome: 'moved', to: 'c-ll' });
    const stored = await units.getById(unitId, { consistentRead: true });
    expect(stored?.contacts).toEqual([
      { contactId: 'c-ll', role: 'landlord', primaryContact: true },
      { contactId: 'c-d', role: 'pm', primaryContact: false },
    ]);
    expect(stored?.primary_contact).toBe('c-ll');
    // The deleted contact is EXCLUDED and never read (spec 4.2).
    expect(liveness.calls.flat()).not.toContain('c-d');
    expect(liveness.calls.flat()).toContain('c-ll');
  });

  it('moved: an off-roster landlord of record gets a landlord row as the primary', async () => {
    const unitId = await ownedUnit('c-ll', [{ contactId: 'c-d', role: 'pm', primaryContact: true }], 'c-d');

    const result = await units.handOffPrimaryFrom(unitId, 'c-d', livenessFrom([person('c-ll')]).read);

    expect(result).toMatchObject({ outcome: 'moved', to: 'c-ll' });
    const stored = await units.getById(unitId, { consistentRead: true });
    expect(stored?.contacts).toHaveLength(2);
    expect(stored?.contacts).toContainEqual({ contactId: 'c-d', role: 'pm', primaryContact: false });
    expect(stored?.contacts).toContainEqual(
      expect.objectContaining({ contactId: 'c-ll', role: 'landlord', primaryContact: true }),
    );
    expect(stored?.primary_contact).toBe('c-ll');
  });

  it('moved: no landlord - the earliest-added eligible contact (a caseworker and a tenant are skipped)', async () => {
    const unitId = await ownerlessUnit(
      [
        { contactId: 'c-d', role: 'pm', primaryContact: true },
        { contactId: 'c-cw', role: 'other', primaryContact: false },
        { contactId: 'c-ten', role: 'other', primaryContact: false },
        { contactId: 'c-own', role: 'owner', primaryContact: false },
      ],
      'c-d',
    );

    const result = await units.handOffPrimaryFrom(
      unitId,
      'c-d',
      livenessFrom([person('c-cw', { type: 'partner', role: 'Caseworker' }), person('c-ten', { type: 'tenant' }), person('c-own')])
        .read,
    );

    expect(result).toMatchObject({ outcome: 'moved', to: 'c-own' });
    const stored = await units.getById(unitId, { consistentRead: true });
    expect(stored?.contacts).toEqual([
      { contactId: 'c-d', role: 'pm', primaryContact: false },
      { contactId: 'c-cw', role: 'other', primaryContact: false },
      { contactId: 'c-ten', role: 'other', primaryContact: false },
      { contactId: 'c-own', role: 'owner', primaryContact: true },
    ]);
    expect(stored?.primary_contact).toBe('c-own');
  });

  it('a soft-deleted unit is handed off too', async () => {
    const unitId = await ownerlessUnit(
      [
        { contactId: 'c-d', role: 'pm', primaryContact: true },
        { contactId: 'c-own', role: 'owner', primaryContact: false },
      ],
      'c-d',
    );
    await units.softDelete(unitId, GONE);

    const result = await units.handOffPrimaryFrom(unitId, 'c-d', livenessFrom([person('c-own')]).read);

    expect(result).toMatchObject({ outcome: 'moved', to: 'c-own' });
    const stored = await units.getById(unitId, { consistentRead: true });
    expect(stored?.deleted_at).toBe(GONE);
    expect(stored?.primary_contact).toBe('c-own');
  });

  it('unchanged: no live non-excluded candidate - nothing written, the deleted contact stays flagged', async () => {
    const roster: UnitContact[] = [
      { contactId: 'c-d', role: 'pm', primaryContact: true },
      { contactId: 'c-ten', role: 'other', primaryContact: false },
    ];
    const unitId = await ownerlessUnit(roster, 'c-d');
    const { repo, counter } = racingRepo(unitId, async () => undefined);

    const result = await repo.handOffPrimaryFrom(unitId, 'c-d', livenessFrom([person('c-ten', { type: 'tenant' })]).read);

    expect(result).toEqual({ outcome: 'unchanged' });
    expect(counter.writes).toBe(0);
    const stored = await units.getById(unitId, { consistentRead: true });
    expect(stored?.contacts).toEqual(roster);
    expect(stored?.primary_contact).toBe('c-d');
  });

  it('unknown: the liveness read failed - nothing written', async () => {
    const roster: UnitContact[] = [
      { contactId: 'c-d', role: 'pm', primaryContact: true },
      { contactId: 'c-own', role: 'owner', primaryContact: false },
    ];
    const unitId = await ownerlessUnit(roster, 'c-d');
    const { repo, counter } = racingRepo(unitId, async () => undefined);

    const result = await repo.handOffPrimaryFrom(unitId, 'c-d', failedRead);

    expect(result).toEqual({ outcome: 'unknown' });
    expect(counter.writes).toBe(0);
    const stored = await units.getById(unitId, { consistentRead: true });
    expect(stored?.contacts).toEqual(roster);
  });

  it('not_primary: the contact holds a row that is not the primary - nothing read, nothing written', async () => {
    const unitId = await ownedUnit(
      'c-ll',
      [
        { contactId: 'c-ll', role: 'landlord', primaryContact: true },
        { contactId: 'c-d', role: 'pm', primaryContact: false },
      ],
      'c-ll',
    );
    const liveness = livenessFrom([person('c-ll')]);

    const result = await units.handOffPrimaryFrom(unitId, 'c-d', liveness.read);

    expect(result).toEqual({ outcome: 'not_primary' });
    expect(liveness.calls).toEqual([]);
  });

  it('not_primary: a unit that does not exist', async () => {
    const result = await units.handOffPrimaryFrom(`unit-missing-${randomUUID()}`, 'c-d', failedRead);
    expect(result).toEqual({ outcome: 'not_primary' });
  });

  it('(PIN) reads the unit CONSISTENTLY', async () => {
    const unitId = await ownerlessUnit(
      [
        { contactId: 'c-d', role: 'pm', primaryContact: true },
        { contactId: 'c-own', role: 'owner', primaryContact: false },
      ],
      'c-d',
    );
    const { repo, counter } = racingRepo(unitId, async () => undefined);

    await repo.handOffPrimaryFrom(unitId, 'c-d', livenessFrom([person('c-own')]).read);

    expect(counter.unitReads).toEqual([true]);
  });

  it('a lost write re-reads and re-checks: someone already moved the primary -> not_primary, nothing more written', async () => {
    const unitId = await ownerlessUnit(
      [
        { contactId: 'c-d', role: 'pm', primaryContact: true },
        { contactId: 'c-own', role: 'owner', primaryContact: false },
      ],
      'c-d',
    );
    const moved: UnitContact[] = [
      { contactId: 'c-d', role: 'pm', primaryContact: false },
      { contactId: 'c-own', role: 'owner', primaryContact: false },
      { contactId: 'c-other', role: 'pm', primaryContact: true },
    ];
    const { repo, counter } = racingRepo(unitId, () => rawRosterWrite(unitId, moved, 'c-other'));

    const result = await repo.handOffPrimaryFrom(unitId, 'c-d', livenessFrom([person('c-own'), person('c-other')]).read);

    expect(result).toEqual({ outcome: 'not_primary' });
    expect(counter.writes).toBe(1);
    const stored = await units.getById(unitId, { consistentRead: true });
    expect(stored?.contacts).toEqual(moved);
    expect(stored?.primary_contact).toBe('c-other');
  });

  it('a lost write re-decides from the new roster', async () => {
    const unitId = await ownerlessUnit(
      [
        { contactId: 'c-d', role: 'pm', primaryContact: true },
        { contactId: 'c-own', role: 'owner', primaryContact: false },
      ],
      'c-d',
    );
    const { repo } = racingRepo(unitId, () =>
      rawRosterWrite(unitId, [
        { contactId: 'c-first', role: 'owner', primaryContact: false },
        { contactId: 'c-d', role: 'pm', primaryContact: true },
        { contactId: 'c-own', role: 'owner', primaryContact: false },
      ]),
    );
    const liveness = livenessFrom([person('c-first'), person('c-own')]);

    const result = await repo.handOffPrimaryFrom(unitId, 'c-d', liveness.read);

    expect(result).toMatchObject({ outcome: 'moved', to: 'c-first' });
    expect(liveness.calls).toHaveLength(2);
    const stored = await units.getById(unitId, { consistentRead: true });
    expect(stored?.primary_contact).toBe('c-first');
  });

  it('gives up after 3 lost writes: RosterWriteConflictError, nothing of its own written', async () => {
    const unitId = await ownerlessUnit(
      [
        { contactId: 'c-d', role: 'pm', primaryContact: true },
        { contactId: 'c-own', role: 'owner', primaryContact: false },
      ],
      'c-d',
    );
    let writes = 0;
    const contendedDoc = Object.create(doc) as typeof doc;
    contendedDoc.send = (async (command: Parameters<typeof doc.send>[0]) => {
      if (command instanceof UpdateCommand && command.input.Key?.['unitId'] === unitId) {
        writes += 1;
        // A racer changes the roster right before every write of ours lands.
        await rawRosterWrite(unitId, [
          { contactId: 'c-d', role: 'pm', primaryContact: true },
          { contactId: 'c-own', role: 'owner', primaryContact: false },
          { contactId: `c-late-${writes}`, role: 'other', primaryContact: false },
        ]);
      }
      return doc.send(command);
    }) as typeof doc.send;
    const contended = createUnitsRepo({ doc: contendedDoc, env: testEnv, logger });

    await expect(
      contended.handOffPrimaryFrom(unitId, 'c-d', livenessFrom([person('c-own')]).read),
    ).rejects.toBeInstanceOf(RosterWriteConflictError);

    expect(writes).toBe(3);
    const stored = await units.getById(unitId, { consistentRead: true });
    expect(stored?.primary_contact).toBe('c-d');
    expect(stored?.contacts?.find((c) => c.contactId === 'c-d')?.primaryContact).toBe(true);
  });

  it('list({ consistentRead: true }) sends a consistent Scan; the default Scan does not', async () => {
    await units.create({ landlordId: 'c-scan', status: 'available' });
    const scans: Array<Record<string, unknown>> = [];
    const spyDoc = Object.create(doc) as typeof doc;
    spyDoc.send = (async (command: Parameters<typeof doc.send>[0]) => {
      if (command instanceof ScanCommand) scans.push(command.input as Record<string, unknown>);
      return doc.send(command);
    }) as typeof doc.send;
    const spied = createUnitsRepo({ doc: spyDoc, env: testEnv, logger });

    const consistent = await spied.list({ deleted: 'any', consistentRead: true, limit: 1 });
    await spied.list({ deleted: 'any', limit: 1 });

    expect(consistent.items).toHaveLength(1);
    expect(scans[0]).toMatchObject({ ConsistentRead: true });
    expect(scans[1]).not.toHaveProperty('ConsistentRead');
  });
});
