// BE3/C3 integration tests against DynamoDB Local — the unit roster + property
// siblings: addContact (append + upsert + single-primaryContact invariant), the
// legacy landlordId staying represented in the roster, removeContact (non-
// landlord), the landlord-of-record-stays guard, the byProperty GSI siblings
// query, and the primary_contact scalar staying consistent
// with the roster's ☎ primary.
//
// Self-skipping like the other integration suites: when nothing answers at
// DYNAMODB_ENDPOINT (default http://localhost:8000) the suite is skipped so
// `npm test` stays green without Docker (`npm run db:start` to run for real).
import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createLogger } from '../src/lib/logger.js';
import { CannotRemoveLandlordOfRecordError, createUnitsRepo } from '../src/repos/unitsRepo.js';
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
    `[unitsRepoRoster.integration] SKIPPED — no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

describe.skipIf(!reachable)('unitsRepo roster + property (BE3) against DynamoDB Local', () => {
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

  it('addContact seeds the roster from the legacy landlordId and keeps the landlord present', async () => {
    const unit = await units.create({ landlordId: 'c-ll-1', status: 'available' });
    // The landlord starts as the implicit primaryContact (back-compat serializer).
    const updated = await units.addContact(unit.unitId, { contactId: 'c-pm-1', role: 'pm' });
    const roster = updated.contacts ?? [];
    expect(roster.map((c) => c.contactId).sort()).toEqual(['c-ll-1', 'c-pm-1']);
    const landlord = roster.find((c) => c.contactId === 'c-ll-1');
    expect(landlord).toMatchObject({ role: 'landlord', primaryContact: true });
    // A non-primaryContact add leaves the landlord as the ☎ primary + scalar.
    expect(roster.find((c) => c.contactId === 'c-pm-1')?.primaryContact).toBe(false);
    expect(updated.primary_contact).toBe('c-ll-1');
  });

  it('addContact claims an unowned unit when the new roster role is landlord', async () => {
    const created = await units.create({ landlordId: 'c-temporary', status: 'available' });
    await units.update(created.unitId, { landlordId: null });

    const updated = await units.addContact(created.unitId, {
      contactId: 'c-new-landlord',
      role: 'landlord',
    });

    expect(updated.landlordId).toBe('c-new-landlord');
    expect(updated.contacts).toContainEqual({
      contactId: 'c-new-landlord',
      role: 'landlord',
      primaryContact: false,
    });
    const owned = await units.listByLandlord('c-new-landlord');
    expect(owned.items.map((unit) => unit.unitId)).toContain(created.unitId);
  });

  it('addContact refuses to replace an existing landlord of record through a roster role', async () => {
    const created = await units.create({ landlordId: 'c-current-landlord', status: 'available' });

    await expect(
      units.addContact(created.unitId, {
        contactId: 'c-different-landlord',
        role: 'landlord',
      }),
    ).rejects.toMatchObject({ name: 'LandlordReassignmentRequiredError' });

    const unchanged = await units.getById(created.unitId);
    expect(unchanged?.landlordId).toBe('c-current-landlord');
    expect(unchanged?.contacts).toBeUndefined();
  });

  it('allows only one landlord claim when two roster writes race on an unowned unit', async () => {
    const created = await units.create({ landlordId: 'c-temporary', status: 'available' });
    await units.update(created.unitId, { landlordId: null });

    let releaseReads = (): void => {};
    const bothReadsFinished = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    let reads = 0;
    const gatedDoc = Object.create(doc) as typeof doc;
    gatedDoc.send = (async (command: Parameters<typeof doc.send>[0]) => {
      const result = await doc.send(command);
      if (command instanceof GetCommand && command.input.Key?.['unitId'] === created.unitId) {
        reads += 1;
        if (reads === 2) releaseReads();
        await bothReadsFinished;
      }
      return result;
    }) as typeof doc.send;
    const racingUnits = createUnitsRepo({ doc: gatedDoc, env: testEnv, logger });

    const outcomes = await Promise.allSettled([
      racingUnits.addContact(created.unitId, { contactId: 'c-racer-one', role: 'landlord' }),
      racingUnits.addContact(created.unitId, { contactId: 'c-racer-two', role: 'landlord' }),
    ]);

    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(outcomes.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { name: 'LandlordReassignmentRequiredError' },
    });
    const stored = await units.getById(created.unitId);
    expect(['c-racer-one', 'c-racer-two']).toContain(stored?.landlordId);
    expect(stored?.contacts).toHaveLength(1);
    expect(stored?.contacts?.[0]?.contactId).toBe(stored?.landlordId);
  });

  it('preserves both rows when a landlord claim races a non-landlord roster add', async () => {
    const created = await units.create({ landlordId: 'c-temporary', status: 'available' });
    await units.update(created.unitId, { landlordId: null });

    let releaseReads = (): void => {};
    const bothReadsFinished = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    let reads = 0;
    const gatedDoc = Object.create(doc) as typeof doc;
    gatedDoc.send = (async (command: Parameters<typeof doc.send>[0]) => {
      const result = await doc.send(command);
      if (command instanceof GetCommand && command.input.Key?.['unitId'] === created.unitId) {
        reads += 1;
        if (reads === 2) releaseReads();
        await bothReadsFinished;
      }
      return result;
    }) as typeof doc.send;
    const racingUnits = createUnitsRepo({ doc: gatedDoc, env: testEnv, logger });

    await Promise.all([
      racingUnits.addContact(created.unitId, { contactId: 'c-new-landlord', role: 'landlord' }),
      racingUnits.addContact(created.unitId, { contactId: 'c-property-manager', role: 'pm' }),
    ]);

    const stored = await units.getById(created.unitId);
    expect(stored?.landlordId).toBe('c-new-landlord');
    expect(stored?.contacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ contactId: 'c-new-landlord', role: 'landlord' }),
        expect.objectContaining({ contactId: 'c-property-manager', role: 'pm' }),
      ]),
    );
    expect(stored?.contacts).toHaveLength(2);
  });

  it('preserves the landlord row when a claim races a roster removal', async () => {
    const created = await units.create({ landlordId: 'c-temporary', status: 'available' });
    await units.update(created.unitId, {
      landlordId: null,
      contacts: [{ contactId: 'c-property-manager', role: 'pm', primaryContact: false }],
    });

    let releaseReads = (): void => {};
    const bothReadsFinished = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    let reads = 0;
    const gatedDoc = Object.create(doc) as typeof doc;
    gatedDoc.send = (async (command: Parameters<typeof doc.send>[0]) => {
      const result = await doc.send(command);
      if (command instanceof GetCommand && command.input.Key?.['unitId'] === created.unitId) {
        reads += 1;
        if (reads === 2) releaseReads();
        await bothReadsFinished;
      }
      return result;
    }) as typeof doc.send;
    const racingUnits = createUnitsRepo({ doc: gatedDoc, env: testEnv, logger });

    await Promise.all([
      racingUnits.addContact(created.unitId, { contactId: 'c-new-landlord', role: 'landlord' }),
      racingUnits.removeContact(created.unitId, 'c-property-manager'),
    ]);

    const stored = await units.getById(created.unitId);
    expect(stored?.landlordId).toBe('c-new-landlord');
    expect(stored?.contacts).toEqual([
      { contactId: 'c-new-landlord', role: 'landlord', primaryContact: false },
    ]);
  });

  it('bounds optimistic roster retries under sustained contention', async () => {
    const created = await units.create({ landlordId: 'c-landlord', status: 'available' });
    let updateAttempts = 0;
    const contendedDoc = Object.create(doc) as typeof doc;
    contendedDoc.send = (async (command: Parameters<typeof doc.send>[0]) => {
      if (command instanceof UpdateCommand) {
        updateAttempts += 1;
        throw new ConditionalCheckFailedException({ message: 'raced again', $metadata: {} });
      }
      return doc.send(command);
    }) as typeof doc.send;
    const contendedUnits = createUnitsRepo({ doc: contendedDoc, env: testEnv, logger });

    await expect(
      contendedUnits.addContact(created.unitId, { contactId: 'c-property-manager', role: 'pm' }),
    ).rejects.toMatchObject({ name: 'RosterWriteConflictError' });
    expect(updateAttempts).toBe(3);
  });

  it('addContact with primaryContact demotes others (single-primaryContact) and updates the scalar', async () => {
    const unit = await units.create({ landlordId: 'c-ll-2', status: 'available' });
    await units.addContact(unit.unitId, { contactId: 'c-pm-2', role: 'pm', primaryContact: true });
    const after = await units.getById(unit.unitId);
    const roster = after?.contacts ?? [];
    const primaries = roster.filter((c) => c.primaryContact);
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.contactId).toBe('c-pm-2');
    // The primary_contact scalar tracks the roster ☎ primary.
    expect(after?.primary_contact).toBe('c-pm-2');
  });

  it('addContact is idempotent on (unitId, contactId): updates role/primaryContact/name/company in place', async () => {
    const unit = await units.create({ landlordId: 'c-ll-3', status: 'available' });
    await units.addContact(unit.unitId, { contactId: 'c-x', role: 'other', name: 'Old', company: 'Co' });
    const updated = await units.addContact(unit.unitId, {
      contactId: 'c-x',
      role: 'owner',
      primaryContact: true,
      name: 'New',
    });
    const roster = updated.contacts ?? [];
    expect(roster.filter((c) => c.contactId === 'c-x')).toHaveLength(1); // no dup
    const row = roster.find((c) => c.contactId === 'c-x');
    expect(row).toMatchObject({ role: 'owner', primaryContact: true, name: 'New', company: 'Co' });
    expect(updated.primary_contact).toBe('c-x');
  });

  it('removeContact removes a non-landlord and falls the scalar back to landlordId when it was the ☎ primary', async () => {
    const unit = await units.create({ landlordId: 'c-ll-4', status: 'available' });
    await units.addContact(unit.unitId, { contactId: 'c-pm-4', role: 'pm', primaryContact: true });
    const removed = await units.removeContact(unit.unitId, 'c-pm-4');
    expect((removed.contacts ?? []).map((c) => c.contactId)).toEqual(['c-ll-4']);
    // The removed contact was the ☎ primary → the scalar falls back to landlordId.
    expect(removed.primary_contact).toBe('c-ll-4');
  });

  it('removeContact of the ☎-primary pm: exactly one primaryContact (the landlord) AND scalar === landlordId (FIX B)', async () => {
    const unit = await units.create({ landlordId: 'c-ll-b1', status: 'available' });
    // pm becomes the ☎ primary (landlord demoted to primaryContact:false).
    await units.addContact(unit.unitId, { contactId: 'c-pm-b1', role: 'pm', primaryContact: true });
    const removed = await units.removeContact(unit.unitId, 'c-pm-b1');
    const roster = removed.contacts ?? [];
    // Exactly one primaryContact — the landlord — and the scalar AGREES.
    const primaries = roster.filter((c) => c.primaryContact);
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.contactId).toBe('c-ll-b1');
    expect(removed.primary_contact).toBe('c-ll-b1');
  });

  it('removeContact of the ☎-primary with NO landlordId clears the scalar (no dangling) and leaves no primaryContact (FIX B)', async () => {
    // A landlord-less unit. landlordId is the byLandlord GSI hash key, so an
    // empty string is illegal at write time — create with a real landlordId,
    // then REMOVE it (null→REMOVE) to reach the no-landlord state, then seed the
    // roster + the ☎-primary scalar.
    const created = await units.create({ landlordId: 'c-temp', status: 'available' });
    const unit = await units.update(created.unitId, {
      landlordId: null,
      contacts: [
        { contactId: 'c-a', role: 'owner', primaryContact: false },
        { contactId: 'c-b', role: 'pm', primaryContact: true },
      ],
      primary_contact: 'c-b',
    });
    expect(unit.landlordId).toBeUndefined();
    const removed = await units.removeContact(unit.unitId, 'c-b');
    const roster = removed.contacts ?? [];
    expect(roster.map((c) => c.contactId)).toEqual(['c-a']);
    // No landlord to promote → no primaryContact and the scalar is CLEARED (not
    // left dangling at the removed contact).
    expect(roster.filter((c) => c.primaryContact)).toHaveLength(0);
    expect(removed.primary_contact).toBeUndefined();
  });

  it('addContact pins the owning landlord row to role:landlord even when added as a non-landlord role (FIX C)', async () => {
    const unit = await units.create({ landlordId: 'c-ll-c1', status: 'available' });
    // Add the landlord's own contactId but (mistakenly) as a 'pm'.
    const updated = await units.addContact(unit.unitId, { contactId: 'c-ll-c1', role: 'pm' });
    const landlord = (updated.contacts ?? []).find((c) => c.contactId === 'c-ll-c1');
    expect(landlord?.role).toBe('landlord'); // pinned, not 'pm'
  });

  it('removeContact rejects removing the landlord of record (CannotRemoveLandlordOfRecordError)', async () => {
    const unit = await units.create({ landlordId: 'c-ll-5', status: 'available' });
    await expect(units.removeContact(unit.unitId, 'c-ll-5')).rejects.toBeInstanceOf(
      CannotRemoveLandlordOfRecordError,
    );
  });

  it('removeContact throws ConditionalCheckFailedException for a contact not on the roster', async () => {
    const unit = await units.create({ landlordId: 'c-ll-6', status: 'available' });
    await expect(units.removeContact(unit.unitId, 'c-ghost')).rejects.toBeInstanceOf(
      ConditionalCheckFailedException,
    );
  });

  it('addContact throws ConditionalCheckFailedException for an unknown unit', async () => {
    await expect(
      units.addContact('unit-ghost', { contactId: 'c-z', role: 'pm' }),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
  });

  it('listByProperty returns same-property siblings via the sparse byProperty GSI', async () => {
    const propertyId = `prop-${randomUUID().slice(0, 6)}`;
    const a = await units.create({ landlordId: 'c-ll-7', status: 'available', propertyId });
    const b = await units.create({ landlordId: 'c-ll-7', status: 'placed', propertyId });
    // A unit without propertyId must NOT appear (sparse index).
    await units.create({ landlordId: 'c-ll-7', status: 'available' });
    const page = await units.listByProperty(propertyId);
    expect(page.items.map((u) => u.unitId).sort()).toEqual([a.unitId, b.unitId].sort());
  });
});
