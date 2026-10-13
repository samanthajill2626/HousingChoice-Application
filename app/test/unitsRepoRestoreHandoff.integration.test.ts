// primary-contact-integrity (spec 2026-10-12 section 4.6, caseworker-
// integrity's restores): the real unitsRepo.restoreWithLandlord against
// DynamoDB Local. When the old landlord was the primary, a landlord SWAP
// re-runs the heir function after the swap - chooseHeir on the attempt's
// swapped roster, the old landlord excluded: the new landlord when live, else
// the earliest-added remaining contact eligible for automatic routing, else
// nobody - with liveness from opts.readContacts per attempt; unknown is
// RosterReadFailedError and nothing is written. A restore WITHOUT a landlord
// applies the caller's heir pick (`promote`) and needs no read.
// opts.onPrimaryHandoff reports a flagged heir once, after the write.
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
    `[unitsRepoRestoreHandoff.integration] SKIPPED - no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

const AT = '2026-10-01T09:00:00.000Z';

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

describe.skipIf(!reachable)('unitsRepo.restoreWithLandlord - the heir function (spec 4.6) against DynamoDB Local', () => {
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

  /** A SOFT-DELETED unit owned by c-old with the given stored roster and scalar. */
  async function deletedUnit(contacts: UnitContact[], primary?: string): Promise<string> {
    const created = await units.create({
      landlordId: 'c-old',
      status: 'available',
      contacts,
      ...(primary !== undefined && { primary_contact: primary }),
    });
    await units.softDelete(created.unitId, AT);
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

  it('swap, the new landlord is live: it takes the primary; onPrimaryHandoff reports { from: old, to: new }', async () => {
    const unitId = await deletedUnit(
      [
        { contactId: 'c-old', role: 'landlord', primaryContact: true },
        { contactId: 'c-pm', role: 'pm', primaryContact: false },
      ],
      'c-old',
    );
    const liveness = livenessFrom([person('c-new'), person('c-pm')]);
    const handoffs: PrimaryHandoff[] = [];

    const updated = await units.restoreWithLandlord(
      unitId,
      { expectLandlordId: 'c-old', next: { contactId: 'c-new' } },
      {
        readContacts: liveness.read,
        onPrimaryHandoff: (handoff) => {
          handoffs.push(handoff);
        },
      },
    );

    expect(updated.deleted_at).toBeUndefined();
    expect(updated.landlordId).toBe('c-new');
    expect(updated.contacts).toEqual([
      { contactId: 'c-pm', role: 'pm', primaryContact: false },
      { contactId: 'c-new', role: 'landlord', primaryContact: true },
    ]);
    expect(updated.primary_contact).toBe('c-new');
    expect(handoffs).toEqual([{ from: 'c-old', to: 'c-new' }]);
    expect(liveness.calls.flat()).not.toContain('c-old');
  });

  it('swap, the new landlord is SOFT-DELETED: the earliest eligible remaining contact takes the primary; the new landlord stays landlord of record, not primary', async () => {
    const unitId = await deletedUnit(
      [
        { contactId: 'c-old', role: 'landlord', primaryContact: true },
        { contactId: 'c-ten', role: 'other', primaryContact: false },
        { contactId: 'c-pm', role: 'pm', primaryContact: false },
      ],
      'c-old',
    );
    const handoffs: PrimaryHandoff[] = [];

    const updated = await units.restoreWithLandlord(
      unitId,
      { expectLandlordId: 'c-old', next: { contactId: 'c-new' } },
      {
        readContacts: livenessFrom([
          person('c-new', { deleted_at: AT }),
          person('c-ten', { type: 'tenant' }),
          person('c-pm'),
        ]).read,
        onPrimaryHandoff: (handoff) => {
          handoffs.push(handoff);
        },
      },
    );

    expect(updated.landlordId).toBe('c-new');
    expect(updated.contacts).toEqual([
      { contactId: 'c-ten', role: 'other', primaryContact: false },
      { contactId: 'c-pm', role: 'pm', primaryContact: true },
      { contactId: 'c-new', role: 'landlord', primaryContact: false },
    ]);
    expect(updated.primary_contact).toBe('c-pm');
    expect(handoffs).toEqual([{ from: 'c-old', to: 'c-pm' }]);
  });

  it('swap, the new landlord soft-deleted and nobody eligible: no primary row, the scalar REMOVEd, no hand-off reported', async () => {
    const unitId = await deletedUnit(
      [
        { contactId: 'c-old', role: 'landlord', primaryContact: true },
        { contactId: 'c-ten', role: 'other', primaryContact: false },
      ],
      'c-old',
    );
    const handoffs: PrimaryHandoff[] = [];

    const updated = await units.restoreWithLandlord(
      unitId,
      { expectLandlordId: 'c-old', next: { contactId: 'c-new' } },
      {
        readContacts: livenessFrom([person('c-new', { deleted_at: AT }), person('c-ten', { type: 'tenant' })]).read,
        onPrimaryHandoff: (handoff) => {
          handoffs.push(handoff);
        },
      },
    );

    expect(updated.contacts).toEqual([
      { contactId: 'c-ten', role: 'other', primaryContact: false },
      { contactId: 'c-new', role: 'landlord', primaryContact: false },
    ]);
    expect(updated.primary_contact).toBeUndefined();
    expect(handoffs).toEqual([]);
  });

  const UNKNOWN_READS: Array<[string, ((ids: string[]) => Promise<RosterContactsRead>) | undefined]> = [
    ['the read failed', failedRead],
    ['no read was supplied', undefined],
  ];
  it.each(UNKNOWN_READS)(
    'swap of a primary landlord, liveness unknown (%s): RosterReadFailedError - nothing written',
    async (_case, read) => {
      const roster: UnitContact[] = [
        { contactId: 'c-old', role: 'landlord', primaryContact: true },
        { contactId: 'c-pm', role: 'pm', primaryContact: false },
      ];
      const unitId = await deletedUnit(roster, 'c-old');
      const { repo, counter } = countingRepo(unitId);

      await expect(
        repo.restoreWithLandlord(
          unitId,
          { expectLandlordId: 'c-old', next: { contactId: 'c-new' } },
          read === undefined ? undefined : { readContacts: read },
        ),
      ).rejects.toBeInstanceOf(RosterReadFailedError);

      expect(counter.writes).toBe(0);
      const stored = await units.getById(unitId, { consistentRead: true });
      expect(stored?.deleted_at).toBe(AT);
      expect(stored?.landlordId).toBe('c-old');
      expect(stored?.contacts).toEqual(roster);
      expect(stored?.primary_contact).toBe('c-old');
    },
  );

  it('(PIN) swap where the old landlord was NOT the primary: no liveness read, the other primary stays', async () => {
    const unitId = await deletedUnit(
      [
        { contactId: 'c-old', role: 'landlord', primaryContact: false },
        { contactId: 'c-pm', role: 'pm', primaryContact: true },
      ],
      'c-pm',
    );
    let reads = 0;
    const counted = async (): Promise<RosterContactsRead> => {
      reads += 1;
      return { ok: false };
    };

    const updated = await units.restoreWithLandlord(
      unitId,
      { expectLandlordId: 'c-old', next: { contactId: 'c-new' } },
      { readContacts: counted },
    );

    expect(updated.contacts).toEqual([
      { contactId: 'c-pm', role: 'pm', primaryContact: true },
      { contactId: 'c-new', role: 'landlord', primaryContact: false },
    ]);
    expect(updated.primary_contact).toBe('c-pm');
    expect(reads).toBe(0);
  });

  it('a swap retried after a contacts-only race decides the heir again on a fresh read', async () => {
    const unitId = await deletedUnit(
      [
        { contactId: 'c-old', role: 'landlord', primaryContact: true },
        { contactId: 'c-pm', role: 'pm', primaryContact: false },
      ],
      'c-old',
    );
    // Staff B adds c-late (eligible) right after attempt 1's read. Attempt 1
    // finds nobody (c-new deleted, c-pm a tenant), its write loses the roster
    // condition, and attempt 2 re-reads and finds c-late.
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
              { contactId: 'c-pm', role: 'pm', primaryContact: false },
              { contactId: 'c-late', role: 'other', primaryContact: false },
            ],
          },
        }),
      ),
    );
    const liveness = livenessFrom([
      person('c-new', { deleted_at: AT }),
      person('c-pm', { type: 'tenant' }),
      person('c-late'),
    ]);

    const updated = await racing.restoreWithLandlord(
      unitId,
      { expectLandlordId: 'c-old', next: { contactId: 'c-new' } },
      { readContacts: liveness.read },
    );

    expect(liveness.calls).toHaveLength(2);
    expect(updated.contacts).toEqual([
      { contactId: 'c-pm', role: 'pm', primaryContact: false },
      { contactId: 'c-late', role: 'other', primaryContact: true },
      { contactId: 'c-new', role: 'landlord', primaryContact: false },
    ]);
    expect(updated.primary_contact).toBe('c-late');
  });

  it("without a landlord: the caller's heir pick is applied and reported; no pick reports nothing", async () => {
    const roster: UnitContact[] = [
      { contactId: 'c-old', role: 'landlord', primaryContact: true },
      { contactId: 'c-pm', role: 'pm', primaryContact: false },
    ];
    const withPick = await deletedUnit(roster, 'c-old');
    const picked: PrimaryHandoff[] = [];
    const promoted = await units.restoreWithLandlord(
      withPick,
      { expectLandlordId: 'c-old', next: null, expectContacts: roster, promote: 'c-pm' },
      {
        onPrimaryHandoff: (handoff) => {
          picked.push(handoff);
        },
      },
    );
    expect(promoted.contacts).toEqual([{ contactId: 'c-pm', role: 'pm', primaryContact: true }]);
    expect(promoted.primary_contact).toBe('c-pm');
    expect(picked).toEqual([{ from: 'c-old', to: 'c-pm' }]);

    const withoutPick = await deletedUnit(roster, 'c-old');
    const none: PrimaryHandoff[] = [];
    const cleared = await units.restoreWithLandlord(
      withoutPick,
      { expectLandlordId: 'c-old', next: null, expectContacts: roster, promote: null },
      {
        onPrimaryHandoff: (handoff) => {
          none.push(handoff);
        },
      },
    );
    expect(cleared.contacts).toEqual([{ contactId: 'c-pm', role: 'pm', primaryContact: false }]);
    expect(cleared.primary_contact).toBeUndefined();
    expect(none).toEqual([]);
  });

  it('(PIN) without a landlord needs no liveness read: a failed read changes nothing', async () => {
    const roster: UnitContact[] = [
      { contactId: 'c-old', role: 'landlord', primaryContact: true },
      { contactId: 'c-pm', role: 'pm', primaryContact: false },
    ];
    const unitId = await deletedUnit(roster, 'c-old');

    const updated = await units.restoreWithLandlord(
      unitId,
      { expectLandlordId: 'c-old', next: null, expectContacts: roster, promote: 'c-pm' },
      { readContacts: failedRead },
    );

    expect(updated.contacts).toEqual([{ contactId: 'c-pm', role: 'pm', primaryContact: true }]);
    expect(updated.primary_contact).toBe('c-pm');
  });

  // plan review R2/R3 (spec 3 / 4.7; landlordWasPrimary): when ANY row is
  // flagged, only the flag says who is primary. A stale primary_contact naming
  // the old landlord moves nothing, and the write re-aligns the scalar to the
  // flagged row. (With NO row flagged the restore always hands off, whatever
  // the scalar says - caseworker-integrity's no-flag pins in
  // unitsRepoRestoreWithLandlord.integration.test.ts stay GREEN that way.)
  it('swap: a stale scalar naming the old landlord does NOT move the primary off a live flagged row; the scalar is re-aligned', async () => {
    const unitId = await deletedUnit(
      [
        { contactId: 'c-old', role: 'landlord', primaryContact: false },
        { contactId: 'c-pm', role: 'pm', primaryContact: true },
      ],
      'c-old',
    );
    const handoffs: PrimaryHandoff[] = [];

    const updated = await units.restoreWithLandlord(
      unitId,
      { expectLandlordId: 'c-old', next: { contactId: 'c-new' } },
      {
        onPrimaryHandoff: (handoff) => {
          handoffs.push(handoff);
        },
      },
    );

    expect(updated.contacts).toEqual([
      { contactId: 'c-pm', role: 'pm', primaryContact: true },
      { contactId: 'c-new', role: 'landlord', primaryContact: false },
    ]);
    expect(updated.primary_contact).toBe('c-pm');
    expect(handoffs).toEqual([]);
  });

  it('without a landlord: a stale scalar naming the cleared landlord does NOT move the primary off a live flagged row', async () => {
    const roster: UnitContact[] = [
      { contactId: 'c-old', role: 'landlord', primaryContact: false },
      { contactId: 'c-pm', role: 'pm', primaryContact: true },
      { contactId: 'c-owner', role: 'owner', primaryContact: false },
    ];
    const unitId = await deletedUnit(roster, 'c-old');

    const updated = await units.restoreWithLandlord(unitId, {
      expectLandlordId: 'c-old',
      next: null,
      expectContacts: roster,
      promote: null,
    });

    expect(updated.contacts).toEqual([
      { contactId: 'c-pm', role: 'pm', primaryContact: true },
      { contactId: 'c-owner', role: 'owner', primaryContact: false },
    ]);
    expect(updated.primary_contact).toBe('c-pm');
  });
});
