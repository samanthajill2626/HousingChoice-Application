// caseworker-integrity (spec 2026-10-12 section 4 "Restore"): the real
// unitsRepo.restoreWithLandlord against DynamoDB Local - restore plus a
// landlord swap or clear in one conditional write, the old landlord's row
// removed, the new one pinned 'landlord', primary_contact kept consistent, a
// landlordId that changed under the read answered with
// RosterWriteConflictError (nothing written), a unit that is not (or no
// longer) soft-deleted refused the same way, and a contacts-only race retried
// without losing the concurrent row.
//
// Self-skipping like the other integration suites when nothing answers at
// DYNAMODB_ENDPOINT (`npm run db:start` to run for real).
import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createLogger } from '../src/lib/logger.js';
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
    `[unitsRepoRestoreWithLandlord.integration] SKIPPED - no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

describe.skipIf(!reachable)('unitsRepo.restoreWithLandlord against DynamoDB Local', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const units = createUnitsRepo({ doc, env: testEnv, logger });
  const AT = '2026-10-01T09:00:00.000Z';

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('units'), tableName('units', testEnv));
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, tableName('units', testEnv));
    doc.destroy();
    client.destroy();
  }, 120_000);

  /** A SOFT-DELETED unit owned by c-old, with the given stored roster (or none). */
  async function deletedUnit(contacts: UnitContact[] | undefined, primary?: string): Promise<string> {
    const created = await units.create({
      landlordId: 'c-old',
      status: 'available',
      ...(contacts !== undefined && { contacts }),
      ...(primary !== undefined && { primary_contact: primary }),
    });
    await units.softDelete(created.unitId, AT);
    return created.unitId;
  }

  /** A LIVE (never soft-deleted) unit owned by c-old, with the given stored roster. */
  async function liveUnit(contacts: UnitContact[], primary: string): Promise<string> {
    const created = await units.create({
      landlordId: 'c-old',
      status: 'available',
      contacts,
      primary_contact: primary,
    });
    return created.unitId;
  }

  /** A repo that counts the UpdateCommands it sends for `unitId`. */
  function countingRepo(unitId: string) {
    const counter = { writes: 0 };
    const countingDoc = Object.create(doc) as typeof doc;
    countingDoc.send = (async (command: Parameters<typeof doc.send>[0]) => {
      if (command instanceof UpdateCommand && command.input.Key?.['unitId'] === unitId) counter.writes += 1;
      return doc.send(command);
    }) as typeof doc.send;
    return { repo: createUnitsRepo({ doc: countingDoc, env: testEnv, logger }), counter };
  }

  /** A repo whose FIRST read of `unitId` is followed by `race` (on the raw client). */
  function racingRepo(unitId: string, race: () => Promise<unknown>) {
    let raced = false;
    const racingDoc = Object.create(doc) as typeof doc;
    racingDoc.send = (async (command: Parameters<typeof doc.send>[0]) => {
      const result = await doc.send(command);
      if (!raced && command instanceof GetCommand && command.input.Key?.['unitId'] === unitId) {
        raced = true;
        await race();
      }
      return result;
    }) as typeof doc.send;
    return createUnitsRepo({ doc: racingDoc, env: testEnv, logger });
  }

  it('swaps the landlord: restored, old row gone, new row pinned landlord and made primary in its place', async () => {
    const unitId = await deletedUnit(
      [
        { contactId: 'c-old', role: 'landlord', primaryContact: true },
        { contactId: 'c-pm', role: 'pm', primaryContact: false },
      ],
      'c-old',
    );
    const updated = await units.restoreWithLandlord(unitId, {
      expectLandlordId: 'c-old',
      next: { contactId: 'c-new', name: 'Nora Lane', company: 'Lane Homes' },
    });
    expect(updated.deleted_at).toBeUndefined();
    expect(updated.landlordId).toBe('c-new');
    expect(updated.primary_contact).toBe('c-new');
    expect(updated.contacts).toEqual([
      { contactId: 'c-pm', role: 'pm', primaryContact: false },
      { contactId: 'c-new', role: 'landlord', primaryContact: true, name: 'Nora Lane', company: 'Lane Homes' },
    ]);
    const owned = await units.listByLandlord('c-new');
    expect(owned.items.map((u) => u.unitId)).toContain(unitId);
  });

  it('keeps an already-seated new landlord row (re-roled to landlord) and leaves another primary alone', async () => {
    const unitId = await deletedUnit(
      [
        { contactId: 'c-old', role: 'landlord', primaryContact: false },
        { contactId: 'c-pm', role: 'pm', primaryContact: true },
      ],
      'c-pm',
    );
    const updated = await units.restoreWithLandlord(unitId, {
      expectLandlordId: 'c-old',
      next: { contactId: 'c-pm' },
    });
    expect(updated.landlordId).toBe('c-pm');
    expect(updated.primary_contact).toBe('c-pm');
    expect(updated.contacts).toEqual([{ contactId: 'c-pm', role: 'landlord', primaryContact: true }]);
  });

  // R1 code review, backend finding 4: the old landlord was the primary by the
  // primary_contact SCALAR alone (no roster row flagged - the scalar is
  // PATCH-writable). The new landlord still takes the primary, so the scalar
  // never dangles at a contact who is off the list and no longer the landlord.
  it('moves the primary to the new landlord when only the primary_contact scalar named the old one', async () => {
    const unitId = await deletedUnit(
      [
        { contactId: 'c-old', role: 'landlord', primaryContact: false },
        { contactId: 'c-pm', role: 'pm', primaryContact: false },
      ],
      'c-old',
    );
    const updated = await units.restoreWithLandlord(unitId, {
      expectLandlordId: 'c-old',
      next: { contactId: 'c-new' },
    });
    expect(updated.primary_contact).toBe('c-new');
    expect(updated.contacts).toEqual([
      { contactId: 'c-pm', role: 'pm', primaryContact: false },
      { contactId: 'c-new', role: 'landlord', primaryContact: true },
    ]);
    const stored = await units.getById(unitId, { consistentRead: true });
    expect(stored?.primary_contact).toBe('c-new');
  });

  it('clears the landlord: restored ownerless, old row gone, primary_contact removed', async () => {
    const unitId = await deletedUnit(
      [
        { contactId: 'c-old', role: 'landlord', primaryContact: true },
        { contactId: 'c-pm', role: 'pm', primaryContact: false },
      ],
      'c-old',
    );
    const updated = await units.restoreWithLandlord(unitId, { expectLandlordId: 'c-old', next: null });
    expect(updated.deleted_at).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(updated, 'landlordId')).toBe(false);
    expect(updated.primary_contact).toBeUndefined();
    expect(updated.contacts).toEqual([{ contactId: 'c-pm', role: 'pm', primaryContact: false }]);
    const owned = await units.listByLandlord('c-old', { deleted: 'any' });
    expect(owned.items.map((u) => u.unitId)).not.toContain(unitId);
  });

  it('clears the landlord of a legacy unit with no stored roster', async () => {
    const unitId = await deletedUnit(undefined);
    const updated = await units.restoreWithLandlord(unitId, { expectLandlordId: 'c-old', next: null });
    expect(updated.deleted_at).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(updated, 'landlordId')).toBe(false);
    expect(updated.contacts).toEqual([]);
    expect(updated.primary_contact).toBeUndefined();
  });

  it('throws RosterWriteConflictError when the stored landlordId is not the expected one - nothing written', async () => {
    const unitId = await deletedUnit([{ contactId: 'c-old', role: 'landlord', primaryContact: true }], 'c-old');
    await expect(
      units.restoreWithLandlord(unitId, { expectLandlordId: 'c-someone-else', next: null }),
    ).rejects.toBeInstanceOf(RosterWriteConflictError);
    const stored = await units.getById(unitId, { consistentRead: true });
    expect(stored?.deleted_at).toBe(AT);
    expect(stored?.landlordId).toBe('c-old');
  });

  // R1 code review, backend finding 2: restoreWithLandlord only ever restores a
  // SOFT-DELETED property. On a live one - never deleted, or restored by
  // someone else after the caller's read - it must never swap or clear the
  // landlord of record: RosterWriteConflictError (route 409
  // unit_roster_conflict), decided on its own read, so no write is even sent.
  const LIVE_CASES: Array<[string, { contactId: string } | null]> = [
    ['swap', { contactId: 'c-new' }],
    ['clear', null],
  ];
  it.each(LIVE_CASES)(
    'a %s on a LIVE unit throws RosterWriteConflictError - landlord and contacts unchanged, no write sent',
    async (_label, next) => {
      const roster: UnitContact[] = [
        { contactId: 'c-old', role: 'landlord', primaryContact: true },
        { contactId: 'c-pm', role: 'pm', primaryContact: false },
      ];
      const unitId = await liveUnit(roster, 'c-old');
      const { repo, counter } = countingRepo(unitId);
      await expect(repo.restoreWithLandlord(unitId, { expectLandlordId: 'c-old', next })).rejects.toBeInstanceOf(
        RosterWriteConflictError,
      );
      expect(counter.writes).toBe(0);
      const stored = await units.getById(unitId, { consistentRead: true });
      expect(stored?.deleted_at).toBeUndefined();
      expect(stored?.landlordId).toBe('c-old');
      expect(stored?.primary_contact).toBe('c-old');
      expect(stored?.contacts).toEqual(roster);
    },
  );

  it('a plain restore landing between the read and the write is a conflict - the write requires deleted_at', async () => {
    const roster: UnitContact[] = [
      { contactId: 'c-old', role: 'landlord', primaryContact: true },
      { contactId: 'c-pm', role: 'pm', primaryContact: false },
    ];
    const unitId = await deletedUnit(roster, 'c-old');
    // Someone else's plain restore (the stored landlord is valid again) REMOVEs
    // deleted_at right after this call's first read.
    const racing = racingRepo(unitId, () => units.restore(unitId));
    await expect(
      racing.restoreWithLandlord(unitId, { expectLandlordId: 'c-old', next: { contactId: 'c-new' } }),
    ).rejects.toBeInstanceOf(RosterWriteConflictError);
    // Nothing of this call landed: live by the racer's restore, still c-old's.
    const stored = await units.getById(unitId, { consistentRead: true });
    expect(stored?.deleted_at).toBeUndefined();
    expect(stored?.landlordId).toBe('c-old');
    expect(stored?.primary_contact).toBe('c-old');
    expect(stored?.contacts).toEqual(roster);
  });

  it('throws ConditionalCheckFailedException for an unknown unit', async () => {
    await expect(
      units.restoreWithLandlord(`unit-missing-${randomUUID()}`, { expectLandlordId: 'c-old', next: null }),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
  });

  it('a landlordId changed between the read and the write is a conflict - the write is conditioned on it', async () => {
    const unitId = await deletedUnit([{ contactId: 'c-old', role: 'landlord', primaryContact: true }], 'c-old');
    const racing = racingRepo(unitId, () =>
      doc.send(
        new UpdateCommand({
          TableName: tableName('units', testEnv),
          Key: { unitId },
          UpdateExpression: 'SET #l = :l',
          ExpressionAttributeNames: { '#l': 'landlordId' },
          ExpressionAttributeValues: { ':l': 'c-racer' },
        }),
      ),
    );
    await expect(
      racing.restoreWithLandlord(unitId, { expectLandlordId: 'c-old', next: { contactId: 'c-new' } }),
    ).rejects.toBeInstanceOf(RosterWriteConflictError);
    const stored = await units.getById(unitId, { consistentRead: true });
    expect(stored?.landlordId).toBe('c-racer');
    expect(stored?.deleted_at).toBe(AT);
  });

  it('a contacts-only change between the read and the write is retried and keeps the concurrent row', async () => {
    const unitId = await deletedUnit([{ contactId: 'c-old', role: 'landlord', primaryContact: true }], 'c-old');
    const racing = racingRepo(unitId, () =>
      doc.send(
        new UpdateCommand({
          TableName: tableName('units', testEnv),
          Key: { unitId },
          UpdateExpression: 'SET #c = :c',
          ExpressionAttributeNames: { '#c': 'contacts' },
          ExpressionAttributeValues: {
            ':c': [
              { contactId: 'c-old', role: 'landlord', primaryContact: true },
              { contactId: 'c-late', role: 'other', primaryContact: false },
            ],
          },
        }),
      ),
    );
    const updated = await racing.restoreWithLandlord(unitId, {
      expectLandlordId: 'c-old',
      next: { contactId: 'c-new' },
    });
    expect(updated.landlordId).toBe('c-new');
    expect(updated.deleted_at).toBeUndefined();
    expect(updated.contacts).toEqual([
      { contactId: 'c-late', role: 'other', primaryContact: false },
      { contactId: 'c-new', role: 'landlord', primaryContact: true },
    ]);
  });

  // Orchestrator correction C2 (build research RD-1, ruling S4-4): the retry
  // bound on contacts-only races, pinned the way unitsRepoRoster.integration
  // pins the roster writes' bound. EVERY attempt loses a real contacts-only
  // race (a raw write lands between the attempt's read and its conditional
  // write), so the call gives up after exactly ROSTER_WRITE_MAX_ATTEMPTS (3)
  // writes with RosterWriteConflictError and writes nothing itself. The racer
  // stops after RACES attempts, so a loop with no bound would win a later
  // attempt and fail the rejection below instead of hanging.
  it('gives up after 3 attempts when every attempt loses a contacts-only race - nothing written', async () => {
    const unitId = await deletedUnit([{ contactId: 'c-old', role: 'landlord', primaryContact: true }], 'c-old');
    const RACES = 5;
    let writes = 0;
    const contendedDoc = Object.create(doc) as typeof doc;
    contendedDoc.send = (async (command: Parameters<typeof doc.send>[0]) => {
      if (command instanceof UpdateCommand && command.input.Key?.['unitId'] === unitId) {
        writes += 1;
        if (writes <= RACES) {
          await doc.send(
            new UpdateCommand({
              TableName: tableName('units', testEnv),
              Key: { unitId },
              UpdateExpression: 'SET #c = :c',
              ExpressionAttributeNames: { '#c': 'contacts' },
              ExpressionAttributeValues: {
                ':c': [
                  { contactId: 'c-old', role: 'landlord', primaryContact: true },
                  { contactId: `c-late-${writes}`, role: 'other', primaryContact: false },
                ],
              },
            }),
          );
        }
      }
      return doc.send(command);
    }) as typeof doc.send;
    const contended = createUnitsRepo({ doc: contendedDoc, env: testEnv, logger });

    await expect(
      contended.restoreWithLandlord(unitId, { expectLandlordId: 'c-old', next: { contactId: 'c-new' } }),
    ).rejects.toBeInstanceOf(RosterWriteConflictError);
    expect(writes).toBe(3);
    // Nothing of the restore landed: still deleted, still c-old's, and the
    // roster is exactly the racer's last write.
    const stored = await units.getById(unitId, { consistentRead: true });
    expect(stored?.deleted_at).toBe(AT);
    expect(stored?.landlordId).toBe('c-old');
    expect(stored?.primary_contact).toBe('c-old');
    expect(stored?.contacts).toEqual([
      { contactId: 'c-old', role: 'landlord', primaryContact: true },
      { contactId: 'c-late-3', role: 'other', primaryContact: false },
    ]);
  });
});
