// caseworker-integrity (spec 2026-10-12 revision 4, section 4 "Contact list
// (I4)", paragraph "Auto-primary", Cameron 2026-10-12): the real
// unitsRepo.addContact against DynamoDB Local. A NEW seat on a property with
// no primary contact (no contact-list row marked primary) and no landlord of
// record (no landlordId attribute) becomes the property's primary contact,
// whatever its role - a Landlord-role add that claims the vacant slot
// included - and the primary_contact scalar names it, when the contact is
// typed landlord (revision 5, Cameron's Q4: case (g) - any other type joins
// non-primary; the route states the type as ContactListFacts) and eligible
// for automatic routing (revision 6: not soft-deleted, not a routing pointer
// - the route's `autoPrimaryEligible`, case (i)). Every other add keeps
// the request's flag: a property with a landlord of record, one with a
// primary row, and an upsert of a contact already on the list. The rule is
// decided per attempt from the unit that attempt read, so of two racing adds
// only the one whose write commits first is the primary; the loser re-reads
// and joins non-primary.
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
import { createUnitsRepo, type UnitContact, type UnitItem } from '../src/repos/unitsRepo.js';
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
    `[unitsRepoAutoPrimary.integration] SKIPPED - no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

/** The contact facts the route states (ContactListFacts) for a live contact
 *  typed landlord - a landlord, a property manager or an owner. */
const LANDLORD_FACTS = { caseworker: false, landlordTyped: true, autoPrimaryEligible: true };
/** ...and for a contact of any other type (a tenant, a partner who is not a
 *  caseworker, an unknown contact, a team member). */
const NOT_LANDLORD_FACTS = { caseworker: false, landlordTyped: false, autoPrimaryEligible: false };
/** ...and for a SOFT-DELETED contact typed landlord: still typed landlord (the
 *  I3 claim asks only that), but not eligible for automatic routing (spec
 *  revision 6; fix wave FWF-3). */
const DELETED_LANDLORD_FACTS = { caseworker: false, landlordTyped: true, autoPrimaryEligible: false };

describe.skipIf(!reachable)('unitsRepo.addContact auto-primary against DynamoDB Local', () => {
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

  /** An OWNERLESS unit: created with a landlord, then landlordId REMOVEd (the
   *  null sentinel - the byLandlord GSI key can never be written empty), with
   *  the given stored contact list and primary_contact scalar when supplied. */
  async function ownerlessUnit(contacts?: UnitContact[], primary?: string): Promise<string> {
    const created = await units.create({ landlordId: 'c-temp', status: 'available' });
    await units.update(created.unitId, {
      landlordId: null,
      ...(contacts !== undefined && { contacts }),
      ...(primary !== undefined && { primary_contact: primary }),
    });
    return created.unitId;
  }

  /** The e2e's state, reached through the real path: a property soft-deleted,
   *  then restored WITHOUT a landlord (landlordId removed, the old landlord's
   *  row dropped so the stored list is empty, primary_contact removed). */
  async function restoredWithoutLandlord(): Promise<string> {
    const created = await units.create({ landlordId: 'c-old', status: 'available' });
    await units.softDelete(created.unitId, '2026-10-01T09:00:00.000Z');
    await units.restoreWithLandlord(created.unitId, {
      expectLandlordId: 'c-old',
      next: null,
      expectContacts: undefined,
      promote: null,
    });
    return created.unitId;
  }

  /** The contactIds of the rows marked primary (the resolvers' `=== true`). */
  const primaries = (unit: UnitItem | undefined): string[] =>
    (unit?.contacts ?? []).filter((c) => c.primaryContact === true).map((c) => c.contactId);

  const SHAPES: Array<[string, () => Promise<string>]> = [
    ['no stored contact list', () => ownerlessUnit()],
    ['an empty contact list (restored without a landlord)', () => restoredWithoutLandlord()],
    [
      'a contact list with no primary row',
      () => ownerlessUnit([{ contactId: 'c-owner-row', role: 'owner', primaryContact: false }]),
    ],
    [
      'only a stale primary_contact scalar (no row marked primary)',
      () => ownerlessUnit([{ contactId: 'c-owner-row', role: 'owner', primaryContact: false }], 'c-gone'),
    ],
  ];

  it.each(SHAPES)(
    '(a) ownerless with %s: an added PM becomes the primary contact and primary_contact names it',
    async (_shape, makeUnit) => {
      const unitId = await makeUnit();
      const before = await units.getById(unitId, { consistentRead: true });
      expect(before !== undefined && Object.prototype.hasOwnProperty.call(before, 'landlordId')).toBe(false);
      expect(primaries(before)).toEqual([]);

      const updated = await units.addContact(unitId, { contactId: 'c-pm', role: 'pm' }, LANDLORD_FACTS);

      expect(updated.contacts).toContainEqual({ contactId: 'c-pm', role: 'pm', primaryContact: true });
      expect(primaries(updated)).toEqual(['c-pm']);
      expect(updated.primary_contact).toBe('c-pm');
      // A PM never claims the landlord-of-record slot.
      expect(Object.prototype.hasOwnProperty.call(updated, 'landlordId')).toBe(false);
      const stored = await units.getById(unitId, { consistentRead: true });
      expect(primaries(stored)).toEqual(['c-pm']);
      expect(stored?.primary_contact).toBe('c-pm');
    },
  );

  // Q4 (Cameron 2026-10-12, spec revision 5): auto-primary applies only to a
  // contact typed landlord. On the very property (a) promotes a PM on, a
  // contact of any other type joins the list NON-primary, whatever its role;
  // the landlord-typed PM added next is still made the primary contact.
  it.each(['pm', 'owner', 'other'] as const)(
    '(g) ownerless, no primary: a contact NOT typed landlord added as %s joins non-primary; a landlord-typed PM added next is the primary',
    async (role) => {
      const unitId = await restoredWithoutLandlord();

      const joined = await units.addContact(unitId, { contactId: 'c-not-ll', role }, NOT_LANDLORD_FACTS);

      expect(joined.contacts).toEqual([{ contactId: 'c-not-ll', role, primaryContact: false }]);
      expect(joined.primary_contact).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(joined, 'landlordId')).toBe(false);

      const withPm = await units.addContact(unitId, { contactId: 'c-pm', role: 'pm' }, LANDLORD_FACTS);

      expect(primaries(withPm)).toEqual(['c-pm']);
      expect(withPm.primary_contact).toBe('c-pm');
      expect(withPm.contacts).toContainEqual({ contactId: 'c-not-ll', role, primaryContact: false });
    },
  );

  // Spec revision 6 section 4 "Contact list (I4)" (final review A4; fix wave
  // FWF-3): auto-primary follows the ONE automatic-routing eligibility rule
  // the route states as `autoPrimaryEligible` (typed landlord, not
  // soft-deleted, not a routing pointer), not the type alone. A soft-deleted
  // landlord-typed contact joins NON-primary; the I3 claim still asks only the
  // type, so its Landlord-role add still claims the vacant slot.
  it.each(['pm', 'landlord'] as const)(
    '(i) ownerless, no primary: a landlord-typed contact that is not eligible for automatic routing (soft-deleted) added as %s joins NON-primary',
    async (role) => {
      const unitId = await restoredWithoutLandlord();

      const updated = await units.addContact(unitId, { contactId: 'c-gone', role }, DELETED_LANDLORD_FACTS);

      expect(updated.contacts).toEqual([{ contactId: 'c-gone', role, primaryContact: false }]);
      expect(updated.primary_contact).toBeUndefined();
      if (role === 'landlord') expect(updated.landlordId).toBe('c-gone');
      else expect(Object.prototype.hasOwnProperty.call(updated, 'landlordId')).toBe(false);
      const stored = await units.getById(unitId, { consistentRead: true });
      expect(primaries(stored)).toEqual([]);
      expect(stored?.primary_contact).toBeUndefined();
    },
  );

  it('(b) a landlord of record and no primary row: an added PM is NOT the primary contact and primary_contact stays unset', async () => {
    // A landlord of record whose row is not marked primary (what a landlord
    // claim wrote before this rule): the resolvers fall back to landlordId, so
    // the property is reachable and the rule does not apply.
    const created = await units.create({ landlordId: 'c-ll', status: 'available' });
    await units.update(created.unitId, {
      contacts: [{ contactId: 'c-ll', role: 'landlord', primaryContact: false }],
    });

    const updated = await units.addContact(created.unitId, { contactId: 'c-pm', role: 'pm' }, LANDLORD_FACTS);

    expect(updated.contacts).toEqual([
      { contactId: 'c-ll', role: 'landlord', primaryContact: false },
      { contactId: 'c-pm', role: 'pm', primaryContact: false },
    ]);
    expect(updated.primary_contact).toBeUndefined();
    expect(updated.landlordId).toBe('c-ll');
  });

  it('(c) ownerless WITH a primary row: the add is not primary and the existing primary is unchanged', async () => {
    const unitId = await ownerlessUnit([{ contactId: 'c-first', role: 'pm', primaryContact: true }], 'c-first');

    const updated = await units.addContact(unitId, { contactId: 'c-second', role: 'pm' }, LANDLORD_FACTS);

    expect(updated.contacts).toEqual([
      { contactId: 'c-first', role: 'pm', primaryContact: true },
      { contactId: 'c-second', role: 'pm', primaryContact: false },
    ]);
    expect(updated.primary_contact).toBe('c-first');
  });

  it('(d) ownerless, no primary: a Landlord-role add claims landlordId AND becomes the primary contact', async () => {
    const unitId = await ownerlessUnit();

    const updated = await units.addContact(unitId, { contactId: 'c-new-ll', role: 'landlord' }, LANDLORD_FACTS);

    expect(updated.landlordId).toBe('c-new-ll');
    expect(updated.contacts).toEqual([{ contactId: 'c-new-ll', role: 'landlord', primaryContact: true }]);
    expect(updated.primary_contact).toBe('c-new-ll');
  });

  it('(e) two concurrent adds on an ownerless no-primary property: exactly one primary - the add whose write committed first', async () => {
    const unitId = await ownerlessUnit();

    // The racing pattern of unitsRepoRoster.integration.test.ts: every read of
    // this unit waits until BOTH adds have read it, so both decide from the
    // same ownerless, primary-less unit; one write commits and the other's
    // first write loses its condition, re-reads and retries.
    let releaseReads = (): void => {};
    const bothReadsFinished = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    let reads = 0;
    let lostWrites = 0;
    const gatedDoc = Object.create(doc) as typeof doc;
    gatedDoc.send = (async (command: Parameters<typeof doc.send>[0]) => {
      if (command instanceof UpdateCommand) {
        try {
          return await doc.send(command);
        } catch (err) {
          if (err instanceof ConditionalCheckFailedException) lostWrites += 1;
          throw err;
        }
      }
      const result = await doc.send(command);
      if (command instanceof GetCommand && command.input.Key?.['unitId'] === unitId) {
        reads += 1;
        if (reads === 2) releaseReads();
        await bothReadsFinished;
      }
      return result;
    }) as typeof doc.send;
    const racingUnits = createUnitsRepo({ doc: gatedDoc, env: testEnv, logger });

    const answers = await Promise.all([
      racingUnits.addContact(unitId, { contactId: 'c-racer-one', role: 'pm' }, LANDLORD_FACTS),
      racingUnits.addContact(unitId, { contactId: 'c-racer-two', role: 'other' }, LANDLORD_FACTS),
    ]);

    // The second add's first write lost; it re-read and wrote again.
    expect(lostWrites).toBe(1);
    // The winner's own answer holds only its row; the loser's holds both.
    const winnerAnswer = answers.find((unit) => (unit.contacts ?? []).length === 1);
    const winnerId = winnerAnswer?.contacts?.[0]?.contactId;
    expect(['c-racer-one', 'c-racer-two']).toContain(winnerId);
    const loserId = winnerId === 'c-racer-one' ? 'c-racer-two' : 'c-racer-one';

    const stored = await units.getById(unitId, { consistentRead: true });
    expect(stored?.contacts).toHaveLength(2);
    expect(primaries(stored)).toEqual([winnerId]);
    expect(stored?.primary_contact).toBe(winnerId);
    expect(stored?.contacts?.find((c) => c.contactId === loserId)?.primaryContact).toBe(false);
  });

  it.each([
    ['a role edit', 'owner'],
    ['a role edit that claims the vacant landlord slot', 'landlord'],
  ] as const)(
    '(f) (PIN) an upsert of a contact already on an ownerless no-primary list (%s, primaryContact false) does NOT become primary',
    async (_kind, role) => {
      const unitId = await ownerlessUnit([{ contactId: 'c-seated', role: 'pm', primaryContact: false }]);

      const updated = await units.addContact(
        unitId,
        { contactId: 'c-seated', role, primaryContact: false },
        LANDLORD_FACTS,
      );

      expect(updated.contacts).toEqual([{ contactId: 'c-seated', role, primaryContact: false }]);
      expect(primaries(updated)).toEqual([]);
      expect(updated.primary_contact).toBeUndefined();
      // The landlord-role edit still claims the vacant slot (today's behavior);
      // the resolvers then fall back to that landlord of record.
      if (role === 'landlord') expect(updated.landlordId).toBe('c-seated');
      else expect(Object.prototype.hasOwnProperty.call(updated, 'landlordId')).toBe(false);
    },
  );
});
